import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationError, OpenAIImageGenerator } from "./local-secure-provider-fixtures.js";
import { OpenAIImageGenerator as DirectImageGenerator, IMAGE_REQUEST_TIMEOUT_MS } from "../src/daemon/openai-image.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { rememberKunpoImageSource, copyProviderImageSource } from "../src/daemon/provider-image-source.js";
vi.mock("node:dns/promises", async original => ({ ...await original<typeof import("node:dns/promises")>(), lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

describe("GPT Image 2.6 via Images API", () => {
  const baseUrl = "http://127.0.0.1:43199/v1";
  const models = ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"];
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>');
  const gif = Buffer.from("R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFGAAAACwAAAAAAQABAAACAkwBACH5BAUYAAAALAAAAAABAAEAgExpcQAA/wICTAEAOw==", "base64");
  const bitmap = () => sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 2, g: 4, b: 8, alpha: 0.5 } } });

  it.each(models)("sends the format-specific fields for %s and preserves original bytes", async model => {
    for (const format of ["png", "jpeg", "webp", "svg", "gif"] as const) {
      const bytes = format === "svg" ? svg : format === "gif" ? gif : await bitmap().toFormat(format).toBuffer();
      const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: bytes.toString("base64") }] }));
      const generator = new DirectImageGenerator("fixture-key", baseUrl, request);
      const options = format === "gif" ? { frameCount: 2, frameDurationMs: 237 } : format === "jpeg" || format === "webp" ? { outputCompression: 0 } : {};
      const background = ["png", "svg", "webp"].includes(format) ? "transparent" : "auto";
      const result = await generator.generate({ imageModel: { provider: "kunpo", id: model }, model, prompt: "Icon", outputFormat: format, background, ...options });
      expect(result.bytes).toEqual(bytes);
      expect(result.mediaType).toBe(format === "svg" ? "image/svg+xml" : `image/${format}`);
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]![0]).toBe(`${baseUrl}/images/generations`);
      expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({
        model, prompt: "Icon", output_format: format, size: format === "gif" ? "512x512" : "1024x1024", background, quality: "auto", n: 1,
        complexity: "high", response_format: "url",
        ...(format === "svg" ? { svg: { model: "gpt-6-sol", reasoning: { effort: "low" } } } : {}),
        ...(format === "jpeg" || format === "webp" ? { output_compression: 0 } : {}),
        ...(format === "gif" ? { frame_count: 2, frame_duration_ms: 237 } : {}),
      });
    }
  });

  it("sends ordered reference objects and separate transparent markup in JSON edits", async () => {
    const img = { mediaType: "image/webp" as const, data: (await bitmap().webp().toBuffer()).toString("base64") };
    const mark = { mediaType: "image/png" as const, data: (await bitmap().png().toBuffer()).toString("base64") };
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: mark.data }] }));
    const result = await new DirectImageGenerator("fixture-key", baseUrl, request).generate({ model: models[0], prompt: "Move the icon", images: [img, mark], markup: mark, complexity: "medium", pixelSize: "4096x4096" });
    expect(request.mock.calls[0]![0]).toBe(`${baseUrl}/images/edits`);
    const payload = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(payload).toMatchObject({ size: "4096x4096", complexity: "medium", images: [img, mark].map(im => ({ image_url: `data:${im.mediaType};base64,${im.data}` })), markup: { image_url: `data:image/png;base64,${mark.data}` } });
    expect(payload).not.toHaveProperty("response_format");
    expect(result.generation?.parameters).toMatchObject({ markedUp: true, masked: false, referenceCount: 2 });
  });

  it("downloads the original from a URL and checks requested format against its bytes", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => options?.method === "POST"
      ? Response.json({ data: [{ url: `${baseUrl}/files/result` }] }) : new Response(gif, { headers: { "content-type": "image/png" } }));
    const generator = new DirectImageGenerator("fixture-key", baseUrl, request);
    const options = { model: models[0], prompt: "Sprite", aspectRatio: "16:9" as const, outputFormat: "gif" as const, frameCount: 2, frameDurationMs: 240 };
    await expect(generator.generate(options)).resolves.toMatchObject({ bytes: gif, mediaType: "image/gif" });
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body)).size).toBe("768x432");
    await expect(generator.generate({ model: models[1], prompt: "Icon", outputFormat: "svg" })).rejects.toMatchObject({ outcomeUnknown: true });
    expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("rejects malformed references and markup before dispatch", async () => {
    const ref = { mediaType: "image/png" as const, data: (await bitmap().png().toBuffer()).toString("base64") };
    const opaque = { ...ref, data: (await bitmap().flatten().png().toBuffer()).toString("base64") };
    const small = { ...ref, data: (await bitmap().resize(8, 8).png().toBuffer()).toString("base64") };
    const request = vi.fn<typeof fetch>(), generator = new DirectImageGenerator("fixture-key", baseUrl, request);
    for (const opts of [{ images: [{ ...ref, data: "dGVzdA==" }] }, { images: [ref], markup: opaque }, { images: [ref], markup: small },
      { images: [ref], outputFormat: "svg" as const }, { images: [ref], markup: ref, mask: ref }, { outputFormat: "gif" as const, background: "transparent" as const }])
      await expect(generator.generate({ model: models[0], prompt: "Icon", ...opts })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("identifies a denied SVG author and an uncertain server response without a second submission", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: "no access" } }, { status: 403 })).mockResolvedValueOnce(Response.json({}, { status: 502 }));
    const generator = new DirectImageGenerator("fixture-key", baseUrl, request);
    const opts = { model: models[0], prompt: "Icon", outputFormat: "svg" as const, svgModel: "gpt-6.1-sol", svgReasoningEffort: "xhigh" as const };
    await expect(generator.generate(opts)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("gpt-6.1-sol") });
    await expect(generator.generate(opts)).rejects.toMatchObject({ statusCode: 502, outcomeUnknown: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("OpenAI image generator", () => {
  it.each([false, true])("keeps mask=%s semantics while selecting known reference URLs only for supported JSON edits", async masked => {
    const source = { bytes: PNG }, url = "https://kunpoapiimg.ziy.cc/source.png?signature=fixture-edit";
    rememberKunpoImageSource(source, url, "https://llm.ziy.cc/v1");
    const image = copyProviderImageSource(source, { mediaType: "image/png" as const, data: PNG.toString("base64") });
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const result = await new DirectImageGenerator("edit-fake-key", "https://llm.ziy.cc/v1", request).generate({ prompt: "Synthetic", size: "1024x1024", images: [image], ...(masked ? { mask: { mediaType: "image/png", data: PNG.toString("base64") } } : {}) });
    expect(request).toHaveBeenCalledOnce();
    if (masked) {
      const form = request.mock.calls[0]![1]!.body as FormData;
      expect(form).toBeInstanceOf(FormData); expect(Buffer.from(await (form.get("mask") as Blob).arrayBuffer())).toEqual(PNG);
      expect(Buffer.from(await (form.get("image[]") as Blob ?? form.get("image") as Blob).arrayBuffer())).toEqual(PNG);
      expect(result.generation?.parameters.referenceUrlCount).toBe(0);
    } else { expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).images).toEqual([url]); expect(result.generation?.parameters.referenceUrlCount).toBe(1); }
    expect(JSON.stringify(result)).not.toContain("fixture-edit");
  });

  it("rejects protected decoded reference and mask bytes before multipart or JSON upload", async () => {
    const canary = "CANARY_IMAGE_REFERENCE_CREDENTIAL_ONLY";
    registerSensitiveValue(canary);
    const clean = { mediaType: "image/png" as const, data: PNG.toString("base64") };
    const protectedImage = { ...clean, data: Buffer.concat([PNG, Buffer.from(canary)]).toString("base64") };
    const request = vi.fn<typeof fetch>();
    const generator = new DirectImageGenerator("test-key", "http://127.0.0.1:43199/v1", request);
    for (const input of [
      { images: [protectedImage] }, { images: [clean], mask: protectedImage },
      { model: "Image-GI2.1", images: [protectedImage] },
    ]) await expect(generator.generate({ prompt: "Icon", size: "1024x1024", ...input })).rejects.toMatchObject({ statusCode: 400, message: "Protected data cannot be included in image references or masks" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects protected metadata hidden in otherwise recognizable output image bytes", async () => {
    const canary = "CANARY_IMAGE_OUTPUT_CREDENTIAL_ONLY";
    registerSensitiveValue(canary);
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: Buffer.concat([PNG, Buffer.from(canary)]).toString("base64") }] }));
    await expect(new DirectImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024" })).rejects.toThrow("protected data");
    expect(request).toHaveBeenCalledOnce();
  });
  it("calls GPT Image 2.5 through the native Images API", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: PNG.toString("base64") }],
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "request-123" },
    }));
    const generator = new OpenAIImageGenerator("secret-key", "http://127.0.0.1:43199/v1/", request);

    const result = await generator.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(result).toMatchObject({
      bytes: PNG,
      mediaType: "image/png",
      requestId: "request-123",
      generation: { model: "gpt-image-2.5-sunburst", protocol: "openai-images", parameters: { output_format: "png", quality: "auto" } },
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: "Bearer secret-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "A game icon",
      size: "1024x1024",
      quality: "auto",
      output_format: "png",
      background: "auto",
      response_format: "url",
      n: 1,
    });
  });

  it("maps authentication and moderation errors without exposing provider details", async () => {
    const unauthorized = new OpenAIImageGenerator("bad-key", undefined, async () => new Response(JSON.stringify({
      error: { message: "Incorrect API key" },
    }), { status: 401 }));
    await expect(unauthorized.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "OpenAI API key was rejected",
      statusCode: 503,
    });

    const blocked = new OpenAIImageGenerator("key", undefined, async () => new Response(JSON.stringify({
      error: { code: "moderation_blocked", message: "blocked" },
    }), { status: 400 }));
    await expect(blocked.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "OpenAI rejected the image request",
      statusCode: 400,
    });
  });

  it("uses multipart image edits when a reference is provided", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: PNG.toString("base64") }],
    }));
    const generator = new OpenAIImageGenerator("key", "http://127.0.0.1:43199/v1", request);

    await generator.generate({
      prompt: "Turn this into concept art",
      resolution: "1K",
      aspectRatio: "3:2",
      images: [{ mediaType: "image/png", data: Buffer.from("reference").toString("base64") }],
    });

    const [url, init] = request.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:43199/v1/images/edits");
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ authorization: "Bearer key" });
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("prompt")).toBe("Turn this into concept art");
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("uploads multiple reference images as image[]", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const generator = new OpenAIImageGenerator("sk-test", "http://127.0.0.1:43199/v1", request);

    await generator.generate({ prompt: "Compose references", size: "1536x1024", images: [
      { mediaType: "image/png", data: "b25l" },
      { mediaType: "image/jpeg", data: "dHdv" },
    ] });

    const form = request.mock.calls[0]?.[1]?.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
  });

  it.each([
    ["1K", "21:9", "1456x624"],
    ["2K", "1:1", "2048x2048"],
    ["2K", "16:9", "2048x1152"],
    ["4K", "1:1", "2880x2880"],
    ["4K", "16:9", "3840x2160"],
  ] as const)("maps %s %s configured output to %s", async (resolution, aspectRatio, size) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: PNG.toString("base64") }],
    }));
    const generator = new OpenAIImageGenerator("key", "http://127.0.0.1:43199/v1", request);

    await generator.generate({ prompt: "A game icon", resolution, aspectRatio });

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ size });
  });

  it("rejects the unsupported 512px output tier", async () => {
    const request = vi.fn<typeof fetch>();
    const generator = new OpenAIImageGenerator("key", undefined, request);

    await expect(generator.generate({ prompt: "A game icon", resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires configuration and rejects empty image responses", async () => {
    await expect(new OpenAIImageGenerator(undefined).generate({ prompt: "image", size: "1024x1024" }))
      .rejects.toEqual(new ImageGenerationError("Image generation is not configured", 503));

    const generator = new OpenAIImageGenerator("key", undefined, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(generator.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "OpenAI returned no generated image; the upstream result is unknown. Do not automatically submit again.",
      statusCode: 502,
      outcomeUnknown: true,
    });
  });

  it("rejects invalid base URLs before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    for (const baseUrl of ["not-a-url", "http://127.0.0.1:43199/v1?route=test", "http://127.0.0.1:43199/v1#test"]) {
      const generator = new OpenAIImageGenerator("key", baseUrl, request);
      await expect(generator.generate({ prompt: "image", size: "1024x1024" })).rejects.toThrow(/Invalid provider URL|local secure mode/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation", async () => {
    const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const generator = new OpenAIImageGenerator("key", undefined, request);
    const controller = new AbortController();

    const generation = generator.generate({ prompt: "image", size: "1024x1024" }, controller.signal);
    controller.abort();

    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends a PNG alpha mask with the first reference and explicit quality settings", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const generator = new OpenAIImageGenerator("canary-image-key", "http://127.0.0.1:43199/v1", request);
    const image = { mediaType: "image/png" as const, data: PNG.toString("base64") };
    const result = await generator.generate({ prompt: "Repaint the transparent mask area", size: "1024x1024", images: [image], mask: image, quality: "xhigh", outputFormat: "png", background: "transparent" });
    const form = request.mock.calls[0]![1]!.body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(form.get("quality")).toBe("xhigh");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("output_format")).toBe("png");
    expect(form.get("response_format")).toBe("url");
    expect(result.generation).toMatchObject({ model: "gpt-image-2.5-sunburst", parameters: { masked: true, referenceCount: 1 } });
    expect(JSON.stringify(result.generation)).not.toContain(image.data);
  });

  it("preserves JPEG compression zero without assuming the returned format", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const result = await new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024", outputFormat: "jpeg", outputCompression: 0, quality: "max" });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toMatchObject({ quality: "max", output_format: "jpeg", output_compression: 0 });
    expect(result.mediaType).toBe("image/png");
  });

  it("rejects invalid formats, alpha settings, masks and size bounds before sending", async () => {
    const request = vi.fn<typeof fetch>();
    const generator = new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", request);
    const image = { mediaType: "image/png" as const, data: PNG.toString("base64") };
    const wider = Buffer.from(PNG); wider.writeUInt32BE(2, 16);
    for (const invalid of [
      { outputFormat: "webp" }, { quality: "ultra" }, { background: "transparent", outputFormat: "jpeg" },
      { outputFormat: "jpeg", outputCompression: 101 }, { outputCompression: 0 },
      { mask: image }, { images: [image], mask: { ...image, data: wider.toString("base64") } },
      { images: [{ mediaType: "image/webp", data: "UkVGRg==" }] },
      { images: Array.from({ length: 17 }, () => image) },
      { size: "1025x1024" }, { size: "4096x2160" }, { size: "512x512" }, { size: "3840x512" },
    ]) await expect(generator.generate({ prompt: "Icon", size: "1024x1024", ...invalid } as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the documented GI2.1 JSON reference contract", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const image = { mediaType: "image/png" as const, data: PNG.toString("base64") };
    const result = await new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ model: "Image-GI2.1", prompt: "Keep the subject", resolution: "2K", aspectRatio: "4:5", images: [image, image] });
    expect(request.mock.calls[0]![0]).toBe("http://127.0.0.1:43199/v1/images/generations");
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({ model: "Image-GI2.1", prompt: "Keep the subject", size: "4:5", imageSize: "2K", n: 1, stream: false, imageMimeType: "image/png", images: Array(2).fill(`data:image/png;base64,${image.data}`) });
    expect(result.generation?.model).toBe("Image-GI2.1");
  });

  it("rejects GI2.1 options that the route cannot honour", async () => {
    const request = vi.fn<typeof fetch>();
    const generator = new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", request);
    for (const invalid of [{ background: "transparent" }, { outputFormat: "png" }, { quality: "high" }, { resolution: "512" }, { images: Array(15).fill({ mediaType: "image/png", data: "cG5n" }) }]) {
      await expect(generator.generate({ model: "Image-GI2.1", prompt: "Icon", resolution: "1K", aspectRatio: "1:1", ...invalid } as never)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("sniffs downloaded bytes and never puts the key on an artifact request", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/generations")
      ? Response.json({ data: [{ b64_json: "", url: "http://127.0.0.1:43199/generated/icon.png" }] })
      : new Response(PNG, { headers: { "content-type": "image/jpeg" } }));
    const result = await new OpenAIImageGenerator("canary-download-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024" });
    expect(result.mediaType).toBe("image/png");
    expect(request.mock.calls[1]![1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(request.mock.calls[1]![1]?.headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("canary-download-key");
  });

  it("rejects non-image bytes instead of assigning the requested extension", async () => {
    const generator = new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", async () => Response.json({ data: [{ b64_json: Buffer.from("<html>not an image</html>").toString("base64") }] }));
    await expect(generator.generate({ prompt: "Icon", size: "1024x1024" })).rejects.toThrow("unsupported image file");
  });

  it("refuses an oversized artifact before buffering it", async () => {
    let cancelled = false;
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith("/generations")
      ? Response.json({ data: [{ url: "http://127.0.0.1:43199/generated/huge.png" }] })
      : new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "image/png", "content-length": String(64 * 1024 * 1024 + 1) } }));
    await expect(new DirectImageGenerator(undefined, "http://127.0.0.1:43199/v1", request, {}, "none").generate({ prompt: "Icon", size: "1024x1024" })).rejects.toThrow("64 MiB");
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(request.mock.calls[0]![1]?.headers).not.toHaveProperty("authorization");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not replay a synchronous POST whose outcome is unknown", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("connection lost", "TimeoutError"));
    await expect(new OpenAIImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024" }))
      .rejects.toMatchObject({ outcomeUnknown: true, message: expect.stringContaining("Do not automatically submit again") });
    expect(request).toHaveBeenCalledOnce();
    expect(IMAGE_REQUEST_TIMEOUT_MS).toBe(960_000);
  });

  it("cancels a pending response body after headers arrive", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
    const generation = new DirectImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024" }, controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort();
    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("returns cancellation even if an injected transport never resolves headers", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const generation = new DirectImageGenerator("test-key", "http://127.0.0.1:43199/v1", request).generate({ prompt: "Icon", size: "1024x1024" }, controller.signal);
    controller.abort();
    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

});
