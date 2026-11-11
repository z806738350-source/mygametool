import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerPluginIconRoutes, validatePluginIconImage } from "../src/daemon/plugin-icons.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";

const svg = (body: string, attributes = "") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" ${attributes}>${body}</svg>`,
  );

describe("static SVG plugin icons", () => {
  it("blocks newly registered credentials even after icon validation was cached", async () => {
    const canary = "CANARY_PLUGIN_ICON_BINARY_KEY_ONLY";
    const bytes = svg(`<title>${canary}</title><path d="M0 0h32v32H0Z"/>`);
    const icon = await validatePluginIconImage(bytes);
    registerSensitiveValue(canary);
    await expect(validatePluginIconImage(bytes)).rejects.toMatchObject({ statusCode: 403 });
    const app = Fastify();
    registerPluginIconRoutes(app, [{ readIcon: async () => icon }]);
    try {
      const response = await app.inject({ url: "/plugins/fake/icon" });
      expect(response.statusCode).toBe(404); expect(response.body).not.toContain(canary);
    } finally { await app.close(); }
  });
  it("accepts shapes, gradients, clipping, and local references without changing the source", async () => {
    const bytes = svg(`<title>Example icon</title><defs>
      <linearGradient id="paint"><stop stop-color="#123456"/><stop offset="1" stop-color="rgb(90, 80, 70)"/></linearGradient>
      <clipPath id="clip"><rect width="32" height="32"/></clipPath>
      <path id="mark" d="M0 0h32v32H0z" fill="url(#paint)"/>
      </defs><g clip-path="url(#clip)"><use href="#mark"/></g>`);
    const result = await validatePluginIconImage(bytes, "image/svg+xml");
    expect(result.bytes).toEqual(bytes);
    expect(result.mediaType).toBe("image/svg+xml");
    expect((await validatePluginIconImage(Buffer.from(bytes))).revision).toBe(
      result.revision,
    );
    await expect(validatePluginIconImage(bytes, "image/png")).rejects.toThrow();
  });

  it.each([
    "<script>alert(1)</script>",
    "<style>path { fill: red; }</style>",
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>',
    '<animate attributeName="href" values="https://example.com"/>',
    '<image href="data:image/png;base64,AAAA"/>',
    '<use href="https://example.com/icon.svg#mark"/>',
    '<path d="M0 0Z" onload="alert(1)"/>',
    '<path d="M0 0Z" style="fill: red"/>',
    '<path d="M0 0Z" fill="url(https://example.com/paint.svg)"/>',
    '<path d="M0 0Z" fill="u\\72l(https://example.com/paint.svg)"/>',
    '<path d="M0 0Z" fill="url(&#104;ttps://example.com/paint.svg)"/>',
    '<path xmlns="http://www.w3.org/1999/xhtml"/>',
    '<?xml-stylesheet href="https://example.com/style.css"?>',
    "<g><path></g>",
  ])("rejects active, external, or malformed content: %s", async (body) => {
    await expect(validatePluginIconImage(svg(body))).rejects.toThrow();
  });

  it.each([
    'onload="alert(1)"',
    'xml:base="https://example.com/"',
    'style="background: url(https://example.com/)"',
    'xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com"',
    'width="100%"',
    'width="2049"',
  ])("rejects unsupported root attributes: %s", async (attributes) => {
    await expect(
      validatePluginIconImage(svg('<path d="M0 0Z"/>', attributes)),
    ).rejects.toThrow();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 32"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2049 32"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 Infinity 32"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/><svg/>',
    '<!DOCTYPE svg SYSTEM "https://example.com/svg.dtd"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>',
    '<!DOCTYPE svg [<!ENTITY x "test">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>&x;</title></svg>',
  ])(
    "rejects invalid geometry and document declarations: %s",
    async (source) => {
      await expect(
        validatePluginIconImage(Buffer.from(source)),
      ).rejects.toThrow();
    },
  );

  it("rejects invalid UTF-8 and bounds the number of vector elements", async () => {
    await expect(
      validatePluginIconImage(Buffer.from([0xff, 0xfe, 0x00])),
    ).rejects.toThrow();
    await expect(
      validatePluginIconImage(svg('<path d="M0 0Z"/>'.repeat(2048))),
    ).rejects.toThrow();
  });
});
