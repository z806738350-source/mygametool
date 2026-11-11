import { access, chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VolcengineTtsSettingsStore } from "../src/daemon/volcengine-tts-settings.js";
import { containsKnownSensitiveValue } from "../src/shared/sensitive-values.js";

describe("Volcengine TTS settings", () => {
  it("protects a retired credential without consuming its Speaker ID or changing the legacy file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-legacy-speech-"));
    const filename = path.join(directory, "volcengine-tts.json");
    const stored = { version: 1, apiKey: "sk-legacy-speech-test-canary", defaultVoiceId: "obsolete-speaker" };
    try {
      await writeFile(filename, JSON.stringify(stored), { mode: 0o600 });
      const settings = new VolcengineTtsSettingsStore(directory);
      await settings.load();
      expect(containsKnownSensitiveValue(stored.apiKey)).toBe(true);
      expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(stored);
      await settings.clear();
      await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("rejects symlink, hard-link and non-private legacy credential files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-speech-private-file-"));
    const file = path.join(directory, "volcengine-tts.json"), target = path.join(directory, "fixture.json");
    try {
      await writeFile(target, JSON.stringify({ version: 1, apiKey: "sk-legacy-private-speech-canary" }), { mode: 0o600 });
      await symlink(target, file);
      await expect(new VolcengineTtsSettingsStore(directory).load()).rejects.toThrow();
      await rm(file);
      await link(target, file);
      await expect(new VolcengineTtsSettingsStore(directory).load()).rejects.toThrow("not private");
      await rm(file);
      await writeFile(file, JSON.stringify({ version: 1, apiKey: "sk-legacy-private-speech-canary" }), { mode: 0o644 });
      await chmod(file, 0o644);
      await expect(new VolcengineTtsSettingsStore(directory).load()).rejects.toThrow("not private");
      expect(await readFile(target, "utf8")).toContain("sk-legacy-private-speech-canary");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
