import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PreinstalledPluginManager } from "../src/daemon/preinstalled-plugins.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";

const apps: FastifyInstance[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function secureApp(preparedDirectory?: string, dataDirectory?: string) {
  const request = vi.fn<typeof fetch>(async () => { throw new Error("Startup must not download Plugins"); });
  const directory = dataDirectory ?? await temporary("ohmygame-preinstalled-data-");
  const app = createApp({ dataDirectory: directory, bundledPluginsDirectory: await temporary("ohmygame-preinstalled-bundled-"), preinstalledPluginsDirectory: preparedDirectory, publishFetch: request });
  apps.push(app);
  await app.ready();
  return { app, directory, request };
}

describe("preinstalled plugins in the local edition", () => {
  it("opens projects with an unreadable receipt when there is no active preinstalled catalog", async () => {
    const directory = await temporary("ohmygame-inactive-preinstall-");
    const folder = path.join(directory, "plugins");
    await mkdir(folder, { recursive: true });
    const receipt = path.join(folder, "preinstalled-plugins.json");
    await writeFile(receipt, "{");
    const { app, request } = await secureApp(undefined, directory);
    expect((await app.inject("/projects")).statusCode).toBe(200);
    expect(await readFile(receipt, "utf8")).toBe("{");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not call the seed executor or wait for prepared Plugin installation at startup", async () => {
    const seed = vi.spyOn(PreinstalledPluginManager.prototype, "seed");
    const prepared = await preparedPlugin();
    const { app, request } = await secureApp(prepared.directory);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(seed).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects archive paths outside the prepared directory", () => {
    expect(isPreparedPluginIndex({
      version: 1,
      plugins: [{
        pluginId: "plugin-1", releaseId: "release-1", name: "unsafe", version: "1.0.0",
        artifactFile: "../plugin.zip",
        artifactSha256: "a".repeat(64), artifactBytes: 1,
        manifest: { name: "unsafe", version: "1.0.0", description: "Unsafe" },
        origin: { type: "github", repository: "example/unsafe", commit: "abc123" },
      }],
    })).toBe(false);
  });


  it("keeps a prepared archive uninstalled even when supplied through the old startup option", async () => {
    const prepared = await preparedPlugin();
    const { app, directory, request } = await secureApp(prepared.directory);
    expect((await app.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(404);
    await expect(stat(path.join(directory, "plugins", "installed", "marketplace", "ohmygame", "reference-tools"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.inject({ method: "GET", url: "/composer/capabilities" })).json().skills).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["1.0.0", "2.0.0"])("does not auto-install or replace user files from prepared version %s after restart", async (version) => {
    const initial = await secureApp();
    const marker = path.join(initial.directory, "plugins", "user-note.md");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "User-managed data");
    await initial.app.close(); apps.splice(apps.indexOf(initial.app), 1);
    const prepared = await preparedPlugin({ version });
    const second = await secureApp(prepared.directory, initial.directory);
    expect(await readFile(marker, "utf8")).toBe("User-managed data");
    expect((await second.app.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(404);
    expect(second.request).not.toHaveBeenCalled();
  });

  it("keeps startup available without opening a damaged prepared archive", async () => {
    const prepared = await preparedPlugin();
    await writeFile(path.join(prepared.directory, `${prepared.releaseId}.zip`), "damaged");
    const { app, request } = await secureApp(prepared.directory);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains local prepared-index parsing and provenance decoration without installing code", async () => {
    const prepared = await preparedPlugin();
    const manager = new PreinstalledPluginManager(prepared.directory, await temporary("ohmygame-preinstalled-metadata-"));
    await manager.load();
    const plugin = manager.decorate({ installed: true, source: { type: "preinstalled", pluginId: prepared.pluginId, releaseId: prepared.releaseId } } as Parameters<PreinstalledPluginManager["decorate"]>[0]);
    expect(plugin).toMatchObject({ preinstalled: true, origin: { type: "github", repository: "example/reference-tools", commit: "abc123" } });
    expect(isPreparedPluginIndex(JSON.parse(await readFile(path.join(prepared.directory, "index.json"), "utf8")))).toBe(true);
  });
});

async function preparedPlugin(options: { releaseId?: string; version?: string; skillContent?: string; iconContent?: string } = {}) {
  const directory = await temporary("ohmygame-prepared-plugin-");
  const source = await temporary("ohmygame-prepared-source-");
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const releaseId = options.releaseId ?? "22222222-2222-4222-8222-222222222222";
  const skillContent = options.skillContent ?? "---\nname: reference\ndescription: Rebuild a reference.\n---\n";
  const iconContent = options.iconContent ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#f00"/></svg>';
  const manifest = {
    name: "reference-tools",
    version: options.version ?? "1.0.0",
    description: "Reference workflows",
    skills: ["./skills/reference/SKILL.md"],
    interface: {
      displayName: "Reference Tools", shortDescription: "Rebuild a reference.",
      icon: { type: "asset", path: "./assets/icon.svg" } as const,
    },
  };
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "skills", "reference"), { recursive: true });
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(path.join(source, "assets", "icon.svg"), iconContent);
  await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, "skills", "reference", "SKILL.md"), skillContent);
  const archive = await createPluginArchive(source);
  const artifactSha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(path.join(directory, `${releaseId}.zip`), archive);
  const index: PreparedPluginIndex = {
    version: 1,
    plugins: [{
      pluginId,
      releaseId,
      name: manifest.name,
      version: manifest.version,
      artifactFile: `${releaseId}.zip`,
      artifactSha256,
      artifactBytes: archive.length,
      manifest,
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
    }],
  };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  return { directory, pluginId, releaseId, skillContent, iconContent, artifactSha256 };
}

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
