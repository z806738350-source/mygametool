import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";

it("opens local projects while unreadable legacy search credentials stay untouched", async () => {
  const dataDirectory = await temporaryTestDirectory("ohmygame-search-unreadable-");
  const file = path.join(dataDirectory, "web-search-settings.json");
  const original = '{"version":1,"parallelApiKey":"legacy-test-key"';
  await writeFile(file, original, { mode: 0o600 });
  const app = createApp({ dataDirectory });
  try {
    expect((await app.inject({ method: "GET", url: "/projects" })).statusCode).toBe(200);
    for (const [method, url] of [["GET", "/settings/web-search"], ["DELETE", "/settings/web-search/credentials"]] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.body).toContain("web-search-settings.json");
      expect(response.body).not.toContain("legacy-test-key");
    }
    expect(await readFile(file, "utf8")).toBe(original);
  } finally { await app.close(); }
});

it("rejects new web search configuration, reports the legacy key and clears it only on DELETE", async () => {
  const dataDirectory = await temporaryTestDirectory("ohmygame-search-api-");
  const file = path.join(dataDirectory, "web-search-settings.json");
  const original = JSON.stringify({ version: 1, enabled: true, provider: "parallel", fallback: true, parallelApiKey: "legacy-test-key" });
  await writeFile(file, original, { mode: 0o600 });
  const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
  const app = createApp({ dataDirectory });
  const url = "/settings/web-search";
  try {
    const status = await app.inject({ method: "GET", url });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, fallback: false, parallelApiKeyConfigured: true });
    expect(status.body).not.toContain("legacy-test-key");
    for (const payload of [
      { enabled: true, provider: "exa", fallback: true },
      { enabled: false, provider: "parallel", fallback: false, parallelApiKey: "new-test-key" },
      { enabled: false, provider: "parallel", fallback: false, parallelApiKey: null },
    ]) {
      const denied = await app.inject({ method: "PUT", url, payload });
      expect(denied.statusCode).toBe(410);
      expect(denied.body).not.toContain("new-test-key");
    }
    expect(await readFile(file, "utf8")).toBe(original);
    expect((await app.inject({ method: "DELETE", url: url + "/credentials" })).json()).toMatchObject({ enabled: false, parallelApiKeyConfigured: false });
    expect(await readFile(file, "utf8")).not.toContain("legacy-test-key");
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); await app.close(); }
});
