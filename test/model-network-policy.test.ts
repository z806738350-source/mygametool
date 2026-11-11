import { describe, expect, it, vi } from "vitest";
import { assertLocalModelTransport, localModelFetch } from "../src/daemon/model-network-policy.js";

describe("local model transport", () => {
  const model = { api: "openai-responses" as const, baseUrl: "https://llm.ziy.cc/v1" };
  it("rejects SDK protocols that can bypass fetch and legacy remote origins", () => {
    expect(() => assertLocalModelTransport({ ...model, api: "google-generative-ai" })).toThrow("unavailable");
    expect(() => assertLocalModelTransport({ ...model, baseUrl: "https://api.openai.com/v1" })).toThrow("unavailable");
  });
  it("rejects known Meshy identities and endpoints before constructing a fetch", () => {
    const request = vi.fn<typeof fetch>();
    for (const candidate of [
      { ...model, provider: "meshy", id: "anything" },
      { ...model, provider: "kunpo", id: "meshy-7.1" },
      { ...model, baseUrl: "https://api.meshy.ai/openapi/v1" },
    ]) expect(() => localModelFetch(candidate, request)).toThrow("Meshy is disabled");
    expect(request).not.toHaveBeenCalled();
    expect(() => localModelFetch({ ...model, provider: "kunpo", id: "gpt-5.6-sol" }, request)).not.toThrow();
  });
  it("requires the configured origin and guarded redirects", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { headers: { "content-type": "application/json" } }));
    const send = localModelFetch(model, request);
    await expect(async () => send("http://127.0.0.1:1234/steal", { headers: { authorization: "Bearer CANARY_KEY" } })).rejects.toThrow("origin");
    expect(request).not.toHaveBeenCalled();
    await send("https://llm.ziy.cc/v1/responses");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });
});
