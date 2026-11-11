import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSearchSettingsStore } from "../src/daemon/web-search-settings.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";

describe("retired web search settings", () => {
  it("keeps a new install disabled without creating a settings file", async () => {
    const directory = await temporaryTestDirectory("ohmygame-search-");
    const store = new WebSearchSettingsStore(directory);
    await store.load();
    expect(await store.clearCredentials()).toEqual({ enabled: false, provider: "auto", fallback: false, exaApiKeyConfigured: false, parallelApiKeyConfigured: false });
    await expect(stat(path.join(directory, "web-search-settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy configuration until deletion, clears only secrets and stays cleared after restart", async () => {
    const directory = await temporaryTestDirectory("ohmygame-search-");
    const file = path.join(directory, "web-search-settings.json");
    const old = { version: 1, enabled: true, provider: "custom", fallback: true, exaApiKey: "exa-fixture-key", parallelApiKey: "parallel-fixture-key",
      custom: { name: "Search", endpoint: "https://search.example.test/mcp", toolName: "search", apiKey: "custom-fixture-key" } };
    const serialized = JSON.stringify(old);
    await writeFile(file, serialized, { mode: 0o600 });
    const store = new WebSearchSettingsStore(directory);
    await store.load();
    expect(store.get()).toEqual({ enabled: false, provider: "custom", fallback: false, exaApiKeyConfigured: true, parallelApiKeyConfigured: true, custom: { apiKeyConfigured: true } });
    expect(await readFile(file, "utf8")).toBe(serialized);
    await Promise.all([store.clearCredentials(), store.clearCredentials()]);
    const cleared = JSON.parse(await readFile(file, "utf8"));
    expect(cleared).toEqual({ version: 1, enabled: true, provider: "custom", fallback: true, custom: { name: old.custom.name, toolName: old.custom.toolName, endpoint: old.custom.endpoint } });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = new WebSearchSettingsStore(directory);
    await reopened.load();
    expect(reopened.get()).toMatchObject({ enabled: false, exaApiKeyConfigured: false, parallelApiKeyConfigured: false, custom: { apiKeyConfigured: false } });
  });
});
