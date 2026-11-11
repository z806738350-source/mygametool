import { access, chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VolcengineSeedAudioSettingsStore } from "../src/daemon/volcengine-seed-audio-settings.js";

describe("Volcengine Seed Audio settings", () => {
  it("persists and clears the API key without exposing it", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-volcengine-seed-audio-"),
    );
    const settings = new VolcengineSeedAudioSettingsStore(directory);
    await settings.load();
    expect(settings.get()).toEqual({ configured: false });

    await settings.update("  seed-secret  ");
    if (process.platform !== "win32") expect((await stat(path.join(directory, "volcengine-seed-audio.json"))).mode & 0o077).toBe(0);
    expect(settings.get()).toEqual({ configured: true });
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "volcengine-seed-audio.json"),
          "utf8",
        ),
      ),
    ).toEqual({ version: 1, apiKey: "seed-secret" });

    const restored = new VolcengineSeedAudioSettingsStore(directory);
    await restored.load();
    expect(restored.key()).toBe("seed-secret");
    expect(restored.get()).toEqual({ configured: true });
    await restored.clear();
    await expect(
      access(path.join(directory, "volcengine-seed-audio.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty and control-character keys", async () => {
    const settings = new VolcengineSeedAudioSettingsStore(
      await mkdtemp(
        path.join(tmpdir(), "ohmygame-volcengine-seed-audio-invalid-"),
      ),
    );
    await expect(settings.update(" ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("key\nvalue")).rejects.toThrow(
      "printable ASCII",
    );
  });

  it.skipIf(process.platform === "win32")("rejects symlink, hard-link and non-private legacy credential files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-audio-private-file-"));
    const file = path.join(directory, "volcengine-seed-audio.json"), target = path.join(directory, "fixture.json");
    try {
      await writeFile(target, JSON.stringify({ version: 1, apiKey: "sk-legacy-private-audio-canary" }), { mode: 0o600 });
      await symlink(target, file);
      await expect(new VolcengineSeedAudioSettingsStore(directory).load()).rejects.toThrow();
      await rm(file);
      await link(target, file);
      await expect(new VolcengineSeedAudioSettingsStore(directory).load()).rejects.toThrow("not private");
      await rm(file);
      await writeFile(file, JSON.stringify({ version: 1, apiKey: "sk-legacy-private-audio-canary" }), { mode: 0o644 });
      await chmod(file, 0o644);
      await expect(new VolcengineSeedAudioSettingsStore(directory).load()).rejects.toThrow("not private");
      expect(await readFile(target, "utf8")).toContain("sk-legacy-private-audio-canary");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
