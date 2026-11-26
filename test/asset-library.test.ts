import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AssetLibrary, normalizeGenerationProvenance, publicGenerationParameters } from "../src/daemon/asset-library.js";
import { createApp } from "../src/daemon/app.js";
import { CheckedMediaSnapshotStore } from "../src/daemon/checked-media-snapshot.js";
import { inspectVolumeMigrationHeadroom } from "../src/daemon/recovery-space.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { kunpoVideoModels, seedanceModels } from "../src/daemon/seedance-models.js";
import { ensureCanvasAssets, readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { fbxFixture, model3DFixture } from "./model3d-fixture.js";
import { matchingKunpoImageUrl, rememberKunpoImageSource, copyProviderImageSource, ProviderImageSourceStore } from "../src/daemon/provider-image-source.js";
import { isPrivateProjectPath } from "../src/shared/private-project-paths.js";

describe("AssetLibrary", () => {
  it("removes unsaved project copies, transfers shared ownership, and preserves saved or independent assets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-project-delete-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const owned = await library.add("owned.mp4", Buffer.from("owned"), { origin: "workspace", sourceKey: "project:first:owned" });
      const shared = await library.add("shared.mp4", Buffer.from("shared"), { origin: "workspace", sourceKey: "canvas:first:shared" });
      const attachment = await library.add("attachment.mp4", Buffer.from("attachment"), { origin: "uploaded", saved: false, sourceKey: "project:first:attachment:fixture" });
      const saved = await library.add("saved.mp4", Buffer.from("saved"), { origin: "workspace", sourceKey: "project:first:saved" }); await library.save(saved.id);
      const independent = await library.add("upload.mp4", Buffer.from("independent"));
      const unattributed = await library.add("unknown.mp4", Buffer.from("unknown"), { origin: "workspace" });
      await library.associateProject(shared.id, "second");
      // The second import has claimed the source but has not written its workspace manifest yet.
      await library.removeProjectCopies("first", async () => ["first"]);
      for (const asset of [owned, attachment]) {
        expect(library.get(asset.id)).toBeUndefined();
        await expect(stat(path.join(directory, "library/files", `${asset.id}.mp4`))).rejects.toMatchObject({ code: "ENOENT" });
      }
      const state = JSON.parse(await readFile(path.join(directory, "library/assets.json"), "utf8"));
      expect(Object.keys(state.sources).some(key => key.startsWith("project:first:") || key.startsWith("canvas:first:"))).toBe(false);
      expect(state.sources[`project:second:shared:${shared.id}`]).toBe(shared.id);
      const reopened = new AssetLibrary(directory);
      try {
        await reopened.load(); await reopened.removeProjectCopies("second", async () => []);
        expect(reopened.get(shared.id)).toBeUndefined();
        for (const asset of [saved, independent, unattributed]) expect((await reopened.content(asset.id)).asset.id).toBe(asset.id);
      } finally { await reopened.close(); }
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves every project copy when another physical project cannot be checked", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-project-unknown-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load(); const projects = new ProjectManager(directory, library); await projects.load();
      const owner = await projects.create(), unknown = await projects.create();
      const assets = await Promise.all(["a", "b"].map(name => library.add(`${name}.mp4`, Buffer.from(name), { origin: "workspace", sourceKey: `project:${owner.id}:${name}` })));
      await writeFile(path.join(directory, "projects", unknown.id, "project.json"), "invalid");
      const reopenedProjects = new ProjectManager(directory, library); await reopenedProjects.load();
      expect(reopenedProjects.list()).toHaveLength(1);
      await expect(library.removeProjectCopies(owner.id, async id => (await reopenedProjects.referencesLibraryAsset(id, owner.id)).map(project => project.id))).rejects.toThrow("Cannot verify registered projects");
      for (const asset of assets) expect((await library.content(asset.id)).asset.id).toBe(asset.id);
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("retains ownership for a retry if deleting a project copy fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-project-retry-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const asset = await library.add("owned.mp4", Buffer.from("owned"), { origin: "workspace", sourceKey: "project:owner:fixture" });
      const file = (await library.content(asset.id)).absolutePath;
      await rm(file); await mkdir(file);
      await expect(library.removeProjectCopies("owner", async () => [])).rejects.toThrow();
      expect(library.get(asset.id)).toBeDefined();
      await rm(file, { recursive: true });
      await library.removeProjectCopies("owner", async () => []);
      expect(library.get(asset.id)).toBeUndefined();
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("persists new content hashes, checks them on read, and keeps legacy records unbound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-digest-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const bytes = Buffer.from("bounded media fixture");
      const asset = await library.add("clip.mp4", bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(asset.contentSha256).toBe(digest);
      const metadata = path.join(directory, "library", "assets.json");
      const parsed = JSON.parse(await readFile(metadata, "utf8"));
      expect(parsed.assets[0].contentSha256).toBe(digest);
      const content = (await library.content(asset.id)).absolutePath;
      await writeFile(content, Buffer.from("tampered media fixture"));
      await expect(library.openSnapshot(asset.id)).rejects.toMatchObject({ statusCode: 409 });
      delete parsed.assets[0].contentSha256;
      await writeFile(metadata, JSON.stringify(parsed));
      const legacy = new AssetLibrary(directory);
      try {
        await legacy.load();
        expect(legacy.get(asset.id)?.contentSha256).toBeUndefined();
        const opened = await legacy.openContent(asset.id);
        const parts: Buffer[] = [];
        for await (const part of opened.stream) parts.push(Buffer.from(part));
        expect(Buffer.concat(parts)).toEqual(Buffer.from("tampered media fixture"));
        expect(JSON.parse(await readFile(metadata, "utf8")).assets[0].contentSha256).toBeUndefined();
      } finally { await legacy.close(); }
      parsed.assets[0].contentSha256 = "invalid";
      await writeFile(metadata, JSON.stringify(parsed));
      const invalid = new AssetLibrary(directory);
      try { await expect(invalid.load()).rejects.toThrow("Invalid Library metadata"); }
      finally { await invalid.close(); }
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("does not close an injected shared snapshot store", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-shared-snapshot-"));
    const snapshots = new CheckedMediaSnapshotStore(path.join(directory, "snapshots"));
    const library = new AssetLibrary(directory, snapshots);
    try {
      await library.load();
      await library.close();
      const asset = await library.add("clip.mp4", Buffer.from("fixture"));
      const { snapshot } = await library.openSnapshot(asset.id);
      expect(snapshot.size).toBe(7);
      await snapshot.release();
    } finally { await snapshots.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("imports a checked source only when the trusted digest matches, and validates source-key reuse", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-import-digest-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const source = path.join(directory, "source.mp3");
      const bytes = Buffer.from("original source");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(source, bytes);
      await expect(library.addFile("source.mp3", source, { expectedSha256: "0".repeat(64) })).rejects.toMatchObject({ statusCode: 409 });
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
      const asset = await library.addFile("source.mp3", source, { expectedSha256: digest, sourceKey: "fixture-source" });
      expect(asset.contentSha256).toBe(digest);
      expect((await library.addFile("source.mp3", source, { expectedSha256: digest, sourceKey: "fixture-source" })).id).toBe(asset.id);
      await writeFile(source, Buffer.from("changed source!"));
      await expect(library.addFile("source.mp3", source, { expectedSha256: digest, sourceKey: "fixture-source" })).rejects.toMatchObject({ statusCode: 409 });
      expect(library.list()).toHaveLength(1);
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("honors explicit read limits and aborts before importing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-limits-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const asset = await library.add("clip.mp4", Buffer.alloc(33));
      await expect(library.openSnapshot(asset.id, 32)).rejects.toMatchObject({ statusCode: 413 });
      const opened = await library.openSnapshot(asset.id, 33);
      expect(opened.snapshot.size).toBe(33);
      await opened.snapshot.release();
      const source = path.join(directory, "source.mp3"); await writeFile(source, "fixture");
      const controller = new AbortController(); controller.abort();
      await expect(library.addFile("source.mp3", source, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await expect(library.openContent(asset.id, undefined, false, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(library.list()).toHaveLength(1);
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects an oversized imported source before writing a Library asset", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-import-limit-"));
    const library = new AssetLibrary(directory);
    try {
      await library.load();
      const source = path.join(directory, "large.mp4");
      const file = await open(source, "wx", 0o600);
      try { await file.truncate(256 * 1024 * 1024 + 1); } finally { await file.close(); }
      await expect(library.addFile("large.mp4", source)).rejects.toMatchObject({ statusCode: 413 });
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
    } finally { await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("reserves target growth and releases it only after an ENOSPC partial write is cleaned up", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-target-enospc-"));
    const library = new AssetLibrary(directory);
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      await library.load();
      const source = path.join(directory, "source.mp3"); await writeFile(source, "original fixture bytes");
      const before = await inspectVolumeMigrationHeadroom(directory);
      expect(before.status).toBe("complete");
      const probe = await open(source, "r");
      const prototype = Object.getPrototypeOf(probe) as { writeFile: (data: Uint8Array) => Promise<void> };
      const originalWrite = prototype.writeFile;
      await probe.close();
      let reservedDuringWrite: number | null = null;
      writeSpy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: unknown, data: Uint8Array) {
        const during = await inspectVolumeMigrationHeadroom(directory);
        reservedDuringWrite = during.physicalOutstandingBytes;
        await originalWrite.call(this, data.subarray(0, 4));
        throw Object.assign(new Error("simulated target disk full"), { code: "ENOSPC" });
      });
      await expect(library.addFile("source.mp3", source)).rejects.toMatchObject({ code: "ENOSPC" });
      writeSpy.mockRestore(); writeSpy = undefined;
      expect(reservedDuringWrite).toBeGreaterThan(before.physicalOutstandingBytes!);
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
      expect(library.list()).toEqual([]);
      const after = await inspectVolumeMigrationHeadroom(directory);
      expect(after.physicalOutstandingBytes).toBe(before.physicalOutstandingBytes);
      expect(await readFile(source, "utf8")).toBe("original fixture bytes");
    } finally { writeSpy?.mockRestore(); await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps the target reservation when closing the target has an uncertain outcome", async () => {
    // Use a separate module instance: an intentionally uncertain promise must survive in its ledger.
    vi.resetModules();
    const { AssetLibrary: IsolatedLibrary } = await import("../src/daemon/asset-library.js");
    const { inspectVolumeMigrationHeadroom: inspect } = await import("../src/daemon/recovery-space.js");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-target-close-"));
    const library = new IsolatedLibrary(directory);
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      await library.load();
      const source = path.join(directory, "source.mp3"); await writeFile(source, "fixture bytes");
      const before = await inspect(directory); expect(before.status).toBe("complete");
      const probe = await open(source, "r");
      const prototype = Object.getPrototypeOf(probe) as { writeFile: (data: Uint8Array) => Promise<void> };
      const originalWrite = prototype.writeFile;
      await probe.close();
      writeSpy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: unknown, data: Uint8Array) {
        const handle = this as { close: () => Promise<void> };
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw new Error("simulated uncertain close"); };
        await originalWrite.call(this, data);
      });
      await expect(library.addFile("source.mp3", source)).rejects.toThrow("simulated uncertain close");
      writeSpy.mockRestore(); writeSpy = undefined;
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
      expect(library.list()).toEqual([]);
      const after = await inspect(directory);
      expect(after.physicalOutstandingBytes).toBeGreaterThan(before.physicalOutstandingBytes!);
      expect(await readFile(source, "utf8")).toBe("fixture bytes");
    } finally {
      writeSpy?.mockRestore();
      await library.close(); await rm(directory, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("reserves preview growth and cleans both owned files after a partial preview ENOSPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-preview-enospc-"));
    const library = new AssetLibrary(directory);
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      await library.load();
      const source = path.join(directory, "source.fbx"), original = fbxFixture(), preview = await model3DFixture();
      await writeFile(source, original);
      const before = await inspectVolumeMigrationHeadroom(directory); expect(before.status).toBe("complete");
      const probe = await open(source, "r");
      const prototype = Object.getPrototypeOf(probe) as { writeFile: (data: Uint8Array) => Promise<void> };
      const originalWrite = prototype.writeFile; await probe.close();
      let reservedDuringPreview: number | null = null;
      writeSpy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: unknown, data: Uint8Array) {
        if (Buffer.from(data).subarray(0, 4).toString() !== "glTF") return originalWrite.call(this, data);
        reservedDuringPreview = (await inspectVolumeMigrationHeadroom(directory)).physicalOutstandingBytes;
        await originalWrite.call(this, data.subarray(0, 4));
        throw Object.assign(new Error("simulated preview disk full"), { code: "ENOSPC" });
      });
      await expect(library.addFile("source.fbx", source, { modelPreview: preview })).rejects.toMatchObject({ code: "ENOSPC" });
      writeSpy.mockRestore(); writeSpy = undefined;
      expect(reservedDuringPreview).toBeGreaterThan(before.physicalOutstandingBytes!);
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
      expect(library.list()).toEqual([]);
      expect((await inspectVolumeMigrationHeadroom(directory)).physicalOutstandingBytes).toBe(before.physicalOutstandingBytes);
      expect(await readFile(source)).toEqual(original);
    } finally { writeSpy?.mockRestore(); await library.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("retains the preview reservation if its close outcome is uncertain", async () => {
    vi.resetModules();
    const { AssetLibrary: IsolatedLibrary } = await import("../src/daemon/asset-library.js");
    const { inspectVolumeMigrationHeadroom: inspect } = await import("../src/daemon/recovery-space.js");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-preview-close-"));
    const library = new IsolatedLibrary(directory);
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      await library.load();
      const source = path.join(directory, "source.fbx"), original = fbxFixture(), preview = await model3DFixture();
      await writeFile(source, original);
      const before = await inspect(directory); expect(before.status).toBe("complete");
      const probe = await open(source, "r");
      const prototype = Object.getPrototypeOf(probe) as { writeFile: (data: Uint8Array) => Promise<void> };
      const originalWrite = prototype.writeFile; await probe.close();
      writeSpy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: unknown, data: Uint8Array) {
        if (Buffer.from(data).subarray(0, 4).toString() === "glTF") {
          const handle = this as { close: () => Promise<void> }, close = handle.close.bind(handle);
          handle.close = async () => { await close(); throw new Error("simulated uncertain preview close"); };
        }
        await originalWrite.call(this, data);
      });
      await expect(library.addFile("source.fbx", source, { modelPreview: preview })).rejects.toThrow("simulated uncertain preview close");
      writeSpy.mockRestore(); writeSpy = undefined;
      expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
      expect(library.list()).toEqual([]);
      expect((await inspect(directory)).physicalOutstandingBytes).toBeGreaterThan(before.physicalOutstandingBytes!);
      expect(await readFile(source)).toEqual(original);
    } finally { writeSpy?.mockRestore(); await library.close(); await rm(directory, { recursive: true, force: true }); vi.resetModules(); }
  });

  it("refuses reads and mutations after the loaded media directory is redirected", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-link-"));
    const library = new AssetLibrary(directory);
    await library.load();
    const asset = await library.add("original.mp3", Buffer.from("original"));
    const files = path.join(directory, "library", "files");
    const outside = path.join(directory, "outside");
    await rename(files, outside);
    await symlink(outside, files);
    await expect(library.content(asset.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(library.openContent(asset.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(library.add("new.mp3", Buffer.from("new"))).rejects.toMatchObject({ statusCode: 409 });
    await expect(library.delete(asset.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readdir(outside)).toEqual([`${asset.id}.mp3`]);
    expect(await readFile(path.join(outside, `${asset.id}.mp3`), "utf8")).toBe("original");
    expect(library.get(asset.id)).toBeDefined();
  });

  it("privately binds a generated CDN result to exact bytes, survives reload/rename, and removes it on delete", async () => {
    expect(isPrivateProjectPath("library/provider-image-sources/receipt.json")).toBe(true);
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-image-origin-"));
    const library = new AssetLibrary(directory); await library.load();
    const image = { bytes: Buffer.from("generated fixture") };
    const url = "https://kunpoapiimg.ziy.cc/original.png?signature=fake-private-capability";
    rememberKunpoImageSource(image, url, "https://llm.ziy.cc/v1");
    const copied = copyProviderImageSource(image, { ...image });
    expect(JSON.stringify(copied)).not.toContain(url);
    const asset = await library.add("generated.png", copied.bytes, { origin: "generated" });
    expect(await library.bindGeneratedImageSource(asset.id, copied)).toBe(true);
    const record = path.join(directory, "library/provider-image-sources", `${asset.id}.json`);
    expect((await stat(record)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(record))).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(directory, "library/assets.json"), "utf8")).not.toContain(url);
    const reopened = new AssetLibrary(directory); await reopened.load(); await reopened.rename(asset.id, "renamed");
    const reference = {}; await reopened.attachImageSource(asset.id, reference);
    expect(matchingKunpoImageUrl(reference, copied.bytes, "https://llm.ziy.cc/v1", [])).toBe(url);
    expect(JSON.stringify(reference)).toBe("{}");
    expect(matchingKunpoImageUrl(reference, Buffer.from("modified! fixture"), "https://llm.ziy.cc/v1", [])).toBeUndefined();
    expect(matchingKunpoImageUrl(reference, copied.bytes, "http://127.0.0.1:43199/v1", [])).toBeUndefined();
    expect(matchingKunpoImageUrl(reference, copied.bytes, "https://llm.ziy.cc/v1", ["fake-private-capability"])).toBeUndefined();
    await reopened.delete(asset.id);
    await expect(stat(record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not infer origin from labels, copied JSON, uploaded files, or unsafe source URLs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-untrusted-origin-"));
    const library = new AssetLibrary(directory); await library.load();
    for (const origin of ["generated", "uploaded"] as const) {
      const image = { bytes: Buffer.from("fixture") };
      const asset = await library.add("fixture.png", image.bytes, { origin });
      expect(await library.bindGeneratedImageSource(asset.id, image)).toBe(false);
    }
    for (const url of ["https://evil.invalid/x.png", "https://kunpoapiimg.ziy.cc.evil.invalid/x.png", "http://kunpoapiimg.ziy.cc/x.png", "https://user:pass@kunpoapiimg.ziy.cc/x.png", "https://127.0.0.1/x.png", "https://kunpoapiimg.ziy.cc/x.png#fragment"]) {
      const image = { bytes: Buffer.from("fixture") }; rememberKunpoImageSource(image, url, "https://llm.ziy.cc/v1");
      expect(matchingKunpoImageUrl(image, image.bytes, "https://llm.ziy.cc/v1", [])).toBeUndefined();
    }
    const minted = { bytes: Buffer.from("fixture") }; rememberKunpoImageSource(minted, "https://kunpoapiimg.ziy.cc/ok.png", "https://llm.ziy.cc/v1");
    const forged = { ...minted, url: "https://kunpoapiimg.ziy.cc/ok.png" };
    expect(matchingKunpoImageUrl(forged, minted.bytes, "https://llm.ziy.cc/v1", [])).toBeUndefined();
    const upload = await library.add("upload.png", minted.bytes, { origin: "uploaded" });
    expect(await library.bindGeneratedImageSource(upload.id, minted)).toBe(false);
  });

  it("degrades safely for missing, corrupt, linked, public, oversized or unwritable private source receipts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-source-receipts-")), store = new ProviderImageSourceStore(directory);
    const id = "11111111-1111-4111-8111-111111111111", file = path.join(directory, `${id}.json`);
    const image = { bytes: Buffer.from("fixture") }; rememberKunpoImageSource(image, "https://kunpoapiimg.ziy.cc/ok.png", "https://llm.ziy.cc/v1");
    expect(await store.attach(id, {})).toBe(false);
    expect(await store.bind(id, image)).toBe(true);
    const saved = await readFile(file);
    for (const invalid of ["{", "x".repeat(33 * 1024), JSON.stringify({ ...JSON.parse(saved.toString()), url: "https://127.0.0.1/x" }), JSON.stringify({ ...JSON.parse(saved.toString()), extra: "not allowed" })]) {
      await writeFile(file, invalid, { mode: 0o600 }); expect(await store.attach(id, {})).toBe(false);
    }
    await writeFile(file, saved); await chmod(file, 0o644); expect(await store.attach(id, {})).toBe(false);
    await rm(file); const outside = path.join(directory, "outside.json"); await writeFile(outside, saved, { mode: 0o600 });
    await symlink(outside, file); expect(await store.attach(id, {})).toBe(false); await rm(file);
    await link(outside, file); expect(await store.attach(id, {})).toBe(false); await rm(file);
    const blocked = new ProviderImageSourceStore(file); await writeFile(file, "ordinary file");
    expect(await blocked.bind(id, image)).toBe(false);
    const library = new AssetLibrary(path.join(directory, "local")); await library.load();
    const asset = await library.add("paid.png", image.bytes, { origin: "generated" });
    await writeFile(path.join(directory, "local/library/provider-image-sources"), "blocked");
    expect(await library.bindGeneratedImageSource(asset.id, image)).toBe(false);
    expect(await readFile((await library.content(asset.id)).absolutePath)).toEqual(image.bytes);
  });

  it("reads persisted 3D generation provenance without dropping it, and rejects unsafe additions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-canvas-provenance-"));
    await mkdir(path.join(directory, "canvas"));
    const generation = { model: "v3.1-20260211", protocol: "tripo", parameters: { face_limit: 4000, texture: true, pbr: true }, taskId: "task_local_fixture", taskIds: ["task_local_fixture"] };
    const model3d = { triangles: 120, textured: true, rigged: false, animations: [], generation };
    const manifest = { version: 1, assets: { fixture: { name: "fixture.glb", path: "assets/fixture.glb", model3d } } };
    const file = path.join(directory, "canvas/assets.json"), save = async () => writeFile(file, JSON.stringify(manifest));
    await save();
    expect(await readCanvasAssets(directory)).toEqual(manifest);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(manifest);
    Object.assign(model3d, { unknown: "not-allowed" }); await save();
    await expect(readCanvasAssets(directory)).rejects.toThrow("additional properties");
    delete (model3d as typeof model3d & { unknown?: string }).unknown;
    Object.assign(generation.parameters, { api_key: "not-public" }); await save();
    await expect(readCanvasAssets(directory)).rejects.toThrow("generation metadata");
    delete (generation.parameters as typeof generation.parameters & { api_key?: string }).api_key;
    generation.taskId = "https://example.invalid/private"; await save();
    await expect(readCanvasAssets(directory)).rejects.toThrow();
  });
  it("uses canonical provenance when rematerializing a historical animation asset", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-legacy-animation-provenance-"));
    try {
      const library = new AssetLibrary(directory); await library.load();
      const bytes = await model3DFixture({ rigged: true, clips: ["Walk"] });
      const generation = { model: "v3.0-20260909", protocol: "tripo-v3", parameters: { rig_type: "biped", spec: "tripo", out_format: "glb", animate_in_place: false }, taskId: "legacy-task" };
      const legacy = await library.add("animation.glb", bytes, { generation, model3d: { triangles: 1, textured: true, rigged: true, animations: ["Walk"], generation: { ...generation, parameters: { ...generation.parameters, animations: '["preset:walk"]' } } } });
      const original = JSON.stringify(legacy);
      const projects = new ProjectManager(directory, library); await projects.load();
      const project = await projects.create("Legacy animation", "asset-canvas");
      await ensureCanvasAssets(project, projects, library, [legacy.id]);
      const manifest = await readCanvasAssets(project.workspacePath), asset = manifest.assets[legacy.id]!;
      expect(asset.model3d?.generation).toEqual(generation);
      expect(asset.model3d?.animations).toEqual(["Walk"]);
      expect(await readFile(path.join(project.workspacePath, asset.path))).toEqual(bytes);
      expect(JSON.stringify(library.get(legacy.id))).toBe(original);
      const restored = new AssetLibrary(directory); await restored.load();
      const secondProject = await projects.create("Reopened legacy animation", "asset-canvas");
      await ensureCanvasAssets(secondProject, projects, restored, [legacy.id]);
      expect((await readCanvasAssets(secondProject.workspacePath)).assets[legacy.id]?.model3d?.generation).toEqual(generation);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["unsafe-top-level", "invalid-nested-only"])("rejects %s provenance before materializing a historical asset", async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-invalid-animation-provenance-"));
    try {
      const library = new AssetLibrary(directory); await library.load();
      const generation = { protocol: "tripo-v3", parameters: { animations: '["preset:walk"]' } };
      const asset = await library.add("animation.glb", await model3DFixture(), { model3d: { triangles: 1, textured: true, rigged: false, animations: [], generation } });
      if (kind === "unsafe-top-level") asset.generation = { protocol: "tripo-v3", parameters: { api_key: "not-public" } };
      const projects = new ProjectManager(directory, library); await projects.load();
      const project = await projects.create("Invalid animation", "asset-canvas");
      const materialize = vi.spyOn(projects, "materializeLibraryAsset");
      const file = path.join(project.workspacePath, "canvas/assets.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, assets: {} }));
      const before = await readFile(file, "utf8");
      await expect(ensureCanvasAssets(project, projects, library, [asset.id])).rejects.toThrow("Invalid generation provenance");
      expect(materialize).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("copies ordinary files through a single private handle and preserves content across chunks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-copy-"));
    const library = new AssetLibrary(directory);
    await library.load();
    const source = path.join(directory, "source.mp3");
    const bytes = Buffer.alloc(160_000, 0x41); bytes[70_000] = 0x42; bytes[150_000] = 0x43;
    await writeFile(source, bytes);
    const asset = await library.addFile("track.mp3", source);
    const content = (await library.content(asset.id)).absolutePath;
    expect(await readFile(content)).toEqual(bytes);
    expect((await stat(content)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(directory, "library", "assets.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(directory, "library", "files"))).mode & 0o777).toBe(0o700);
  });

  it("refuses symlink, hardlink, directory and private-path imports without recording an asset", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-links-"));
    const library = new AssetLibrary(directory);
    await library.load();
    const source = path.join(directory, "source.png"), linked = path.join(directory, "linked.png"), hard = path.join(directory, "hard.png");
    await writeFile(source, "image");
    await symlink(source, linked); await link(source, hard);
    for (const sourcePath of [linked, hard, directory, path.join(directory, ".ssh", "private.png")]) await expect(library.addFile("image.png", sourcePath)).rejects.toThrow();
    expect(library.list()).toEqual([]);
    expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
  });

  it("refuses content replaced with a link and rejects traversal IDs in stored metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-content-links-"));
    const library = new AssetLibrary(directory);
    await library.load();
    const asset = await library.add("sprite.png", Buffer.from("image"));
    const content = (await library.content(asset.id)).absolutePath;
    const external = path.join(directory, "outside.png"); await writeFile(external, "outside");
    await rm(content); await symlink(external, content);
    await expect(library.content(asset.id)).rejects.toMatchObject({ statusCode: 404 });
    const index = path.join(directory, "library", "assets.json");
    await writeFile(index, JSON.stringify({ version: 1, assets: [{ ...asset, id: "../../outside" }], sources: {} }));
    await expect(new AssetLibrary(directory).load()).rejects.toThrow("Invalid Library metadata");
    expect(await readFile(external, "utf8")).toBe("outside");
  });

  it("serves an immutable checked snapshot even if its pathname is later replaced", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-stream-"));
    const library = new AssetLibrary(directory); await library.load();
    const asset = await library.add("sprite.png", Buffer.from("approved-content"));
    const content = (await library.content(asset.id)).absolutePath;
    const opened = await library.openContent(asset.id);
    const external = path.join(directory, "outside.png"); await writeFile(external, "outside-private-content");
    await rm(content); await symlink(external, content);
    const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("approved-content");
    expect(opened.size).toBe(Buffer.byteLength("approved-content"));
    await expect(library.openContent(asset.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects stale stored credentials registered after import and preserves ordinary snapshot bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-stale-protected-"));
    const library = new AssetLibrary(directory); await library.load();
    const canary = "CANARY_LIBRARY_LATE_REGISTERED_BINARY_ONLY";
    const stale = await library.add("old.png", Buffer.concat([Buffer.alloc(65_530, 0), Buffer.from(canary), Buffer.alloc(10, 0)]));
    const plain = Buffer.from([0, 255, 0, 42, 128, 13, 10]);
    const clean = await library.add("clean.png", plain);
    registerSensitiveValue(canary);
    await expect(library.openContent(stale.id)).rejects.toMatchObject({ statusCode: 400, message: "Protected data cannot be stored in asset content" });
    const opened = await library.openContent(clean.id);
    const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plain); expect(opened.size).toBe(plain.byteLength);
  });

  it("refuses linked Library directories and metadata without reading the linked content", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-index-links-"));
    const outside = path.join(directory, "outside"); await mkdir(outside);
    const linkedStore = path.join(directory, "linked-store"); await mkdir(linkedStore);
    await symlink(outside, path.join(linkedStore, "library"));
    await expect(new AssetLibrary(linkedStore).load()).rejects.toThrow("Linked Library directories");
    expect(await readdir(outside)).toEqual([]);
    const library = new AssetLibrary(directory); await library.load();
    const external = path.join(outside, "index.json"); await writeFile(external, "private-not-json");
    await symlink(external, path.join(directory, "library", "assets.json"));
    await expect(new AssetLibrary(directory).load()).rejects.toThrow("Linked Library metadata");
  });

  it("rejects known credentials in metadata, binary content and chunk boundaries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-protected-"));
    const library = new AssetLibrary(directory); await library.load();
    const canary = "CANARY_ASSET_BINARY_CREDENTIAL_ONLY"; registerSensitiveValue(canary);
    await expect(library.add("image.png", Buffer.from("image"), { prompt: canary })).rejects.toMatchObject({ statusCode: 400 });
    await expect(library.add(`${canary}.png`, Buffer.from("image"))).rejects.toMatchObject({ statusCode: 400 });
    const bytes = Buffer.concat([Buffer.alloc(65_530, 0), Buffer.from(canary), Buffer.alloc(70_000, 0)]);
    await expect(library.add("image.png", bytes)).rejects.toMatchObject({ statusCode: 400 });
    const source = path.join(directory, "source.png"); await writeFile(source, bytes);
    await expect(library.addFile("image.png", source)).rejects.toMatchObject({ statusCode: 400 });
    expect(library.list()).toEqual([]);
    expect(await readdir(path.join(directory, "library", "files"))).toEqual([]);
    const clean = await library.add("clean.png", Buffer.from("image"));
    await expect(library.rename(clean.id, canary)).rejects.toMatchObject({ statusCode: 400 });
    const stored = { version: 1, assets: [{ ...clean, prompt: canary }], sources: {} };
    await writeFile(path.join(directory, "library", "assets.json"), JSON.stringify(stored));
    await expect(new AssetLibrary(directory).load()).rejects.toThrow("Protected data in Library metadata");
  });
  it("stores one global asset for a stable source and restores it", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
    const library = new AssetLibrary(dataDirectory);
    await library.load();

    const [first, repeated] = await Promise.all([
      library.add("opening.mp4", Buffer.from("video"), { prompt: "Opening shot", sourceKey: "tool:run:file", duration: 6.5 }),
      library.add("opening.mp4", Buffer.from("different"), { sourceKey: "tool:run:file" }),
    ]);

    expect(repeated).toEqual(first);
    expect(library.list()).toEqual([first]);
    expect(await readFile((await library.content(first.id)).absolutePath, "utf8")).toBe("video");

    const restored = new AssetLibrary(dataDirectory);
    await restored.load();
    expect(restored.list()).toEqual([first]);
  });

  it("renames metadata without moving content and deletes the asset", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    const asset = await library.add("model.glb", Buffer.from("model"));
    const contentPath = (await library.content(asset.id)).absolutePath;

    await expect(library.rename(asset.id, "Character")).resolves.toMatchObject({ name: "Character.glb" });
    expect((await library.content(asset.id)).absolutePath).toBe(contentPath);
    await library.delete(asset.id);
    expect(library.list()).toEqual([]);
    await expect(library.content(asset.id)).rejects.toThrow("not found");
  });

  it("rejects unsupported files and invalid names", async () => {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-")));
    await library.load();
    await expect(library.add("notes.txt", Buffer.from("notes"))).rejects.toThrow("supported media");
    const asset = await library.add("image.webp", Buffer.from("image"));
    await expect(library.rename(asset.id, "../outside")).rejects.toThrow("Invalid asset name");
  });

  it("rejects invalid stored metadata instead of hiding it as an empty Library", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-"));
    await mkdir(path.join(dataDirectory, "library"), { recursive: true });
    await writeFile(path.join(dataDirectory, "library", "assets.json"), JSON.stringify({ version: 1, assets: "invalid", sources: {} }));

    await expect(new AssetLibrary(dataDirectory).load()).rejects.toThrow("Invalid Library metadata");
  });

  it.each(["damaged", "missing"])("serves projects and conversations while a %s Library index protects retained assets and paid work", async kind => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-repair-"));
    const generate = vi.fn().mockRejectedValue(new Error("Unexpected provider request"));
    const options = { dataDirectory: directory, piAgentDirectory: path.join(directory, "agent"), imageGenerator: { generate } };
    const ledger = path.join(directory, "library", "assets.json");
    const library = new AssetLibrary(directory);
    let app = createApp(options);
    try {
      const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Library fixture", type: "general" } })).json();
      const projectUrl = "/projects/" + project.id;
      await app.close();
      await library.load();
      const bytes = Buffer.from("retained project asset");
      const asset = await library.add("retained.mp4", bytes, { saved: false, sourceKey: "project:" + project.id + ":retained" });
      const original = await readFile(ledger), media = (await library.content(asset.id)).absolutePath;
      if (kind === "missing") await rm(ledger);
      else await writeFile(ledger, '{"version":1,"unparsed":"private-fixture"');
      const diskState = () => readFile(ledger, "utf8").catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; return undefined; });
      const damaged = await diskState();
      await expect(library.load()).rejects.toThrow();
      expect(() => library.get(asset.id)).toThrow("Library is unavailable");
      await expect(library.removeProjectCopies(project.id, async () => [])).rejects.toMatchObject({ statusCode: 503 });
      await expect(library.add("duplicate.mp4", bytes)).rejects.toMatchObject({ statusCode: 503 });
      const projects = new ProjectManager(directory, library);
      await projects.load();
      const target = path.join(project.workspacePath, "assets/generated/kept.png");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "original project bytes");
      await expect(projects.addGeneratedAsset(project.id, "kept.png", bytes)).rejects.toMatchObject({ statusCode: 503 });
      await expect(projects.addGeneratedWorkingImage(project.id, "kept.png", bytes)).rejects.toMatchObject({ statusCode: 503 });
      expect(await readFile(target, "utf8")).toBe("original project bytes");
      app = createApp(options);
      const created = await app.inject({ method: "POST", url: projectUrl + "/conversations", payload: {} });
      expect(created.statusCode, created.body).toBe(201);
      const conversation = created.json();
      for (const url of [projectUrl, projectUrl + "/conversations", projectUrl + "/conversations/" + conversation.id]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, response.body).toBe(200);
      }
      const blocked = [
        await app.inject({ method: "GET", url: "/library/assets" }),
        await app.inject({ method: "POST", url: "/library/assets/" + asset.id + "/save" }),
        await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "A garden" } }),
        await app.inject({ method: "DELETE", url: projectUrl }),
      ];
      for (const response of blocked) {
        expect(response.statusCode, response.body).toBe(503);
        expect(response.body).not.toContain("private-fixture");
      }
      expect(generate).not.toHaveBeenCalled();
      expect((await app.inject({ method: "GET", url: "/tool-jobs" })).json()).toEqual([]);
      expect((await app.inject({ method: "GET", url: projectUrl + "/conversations/" + conversation.id })).statusCode).toBe(200);
      expect(await diskState()).toEqual(damaged);
      expect(await readFile(media)).toEqual(bytes);
      await app.close();
      await writeFile(ledger, original);
      app = createApp(options);
      expect((await app.inject({ method: "GET", url: "/library/assets" })).json()).toMatchObject([{ id: asset.id }]);
      expect((await app.inject({ method: "POST", url: "/library/assets/" + asset.id + "/save" })).statusCode).toBe(200);
    } finally {
      await app.close();
      await library.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy sources without guessing from prompts or changing asset IDs", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-legacy-"));
    const directory = path.join(dataDirectory, "library");
    await mkdir(directory, { recursive: true });
    const base = { size: 3, mediaType: "image", contentType: "image/png", createdAt: "2026-08-24T12:00:00Z" };
    await writeFile(path.join(directory, "assets.json"), JSON.stringify({
      version: 1,
      assets: [
        { ...base, id: "model", name: "model.glb", mediaType: "model", contentType: "model/gltf-binary" },
        { ...base, id: "chat", name: "screenshot.png" },
        { ...base, id: "project", name: "sprite.png", prompt: "A generated-looking prompt" },
        { ...base, id: "unknown", name: "other.png", prompt: "Another prompt" },
        { ...base, id: "recovered", name: "recovered.png", origin: "unknown" },
        { ...base, id: "unclassified", name: "unclassified.png", origin: "unknown" },
        { ...base, id: "old-generation", name: "old-generation.png" },
        { ...base, id: "builtin", name: "builtin.png" },
      ],
      sources: { "tool:run:model.glb": "model", "conversation-image:image/png:hash": "chat", "project:project:sprite.png": "project", "tool:old:recovered.png": "recovered", "project:project:assets/generated/old-generation.png": "old-generation", "builtin:example": "builtin" },
    }));
    const library = new AssetLibrary(dataDirectory);
    await library.load();
    expect(library.get("model")).toMatchObject({ origin: "generated", purpose: "asset" });
    expect(library.get("chat")).toMatchObject({ origin: "uploaded", purpose: "reference" });
    expect(library.get("project")).toMatchObject({ origin: "workspace", purpose: "asset", saved: false });
    expect(library.get("unknown")).toMatchObject({ origin: "uploaded", purpose: "asset", saved: true });
    expect(library.get("recovered")).toMatchObject({ origin: "generated", saved: true });
    expect(library.get("unclassified")).toMatchObject({ origin: "unknown", saved: true });
    expect(library.get("old-generation")).toMatchObject({ origin: "workspace", saved: false });
    expect(library.get("builtin")).toMatchObject({ origin: "builtin", saved: true });
    await library.save("project");
    expect(library.get("project")).toMatchObject({ origin: "workspace", saved: true });
    const restored = new AssetLibrary(dataDirectory);
    await restored.load();
    expect(restored.list()).toEqual(library.list());
    expect(JSON.parse(await readFile(path.join(directory, "assets.json"), "utf8")).assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "chat", purpose: "reference" })]));
  });

  it("keeps a reference promoted to an asset when the same input is submitted again", async () => {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-promote-")));
    await library.load();
    const reference = await library.add("reference.png", Buffer.from("image"), { origin: "uploaded", purpose: "reference", sourceKey: "conversation-image:image/png:hash" });
    await library.save(reference.id);
    const reused = await library.add("reference.png", Buffer.from("image"), { origin: "uploaded", purpose: "reference", sourceKey: "conversation-image:image/png:hash" });
    expect(reused).toMatchObject({ id: reference.id, origin: "uploaded", purpose: "asset" });
    expect(library.list()).toHaveLength(1);
  });

  it("keeps exact generation provenance after the transient run and source file are removed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-provenance-"));
    const library = new AssetLibrary(directory);
    await library.load();
    const generation = { model: "gpt-image-2.5-sunburst", protocol: "openai-images", parameters: { size: "1024x1024", quality: "high", background: "transparent", output_format: "png", masked: true }, taskId: "task_fixture", taskIds: ["task_fixture"] };
    const image = await library.add("sprite.png", Buffer.from("image"), { generation, sourceKey: "tool:transient:sprite.png" });
    generation.parameters.quality = "low";
    expect(image.generation?.parameters.quality).toBe("high");
    const source = path.join(directory, "transient-audio.mp3");
    await writeFile(source, "audio");
    const audio = await library.addFile("voice.mp3", source, { generation: { model: "seed-audio-1.0", protocol: "kunpo-seed-audio-binary", parameters: { format: "mp3", sample_rate: 48000, speech_rate: 0, speaker: "zh_female_fixture" } } });
    await rm(source);
    const restored = new AssetLibrary(directory);
    await restored.load();
    expect(restored.get(image.id)?.generation).toEqual(image.generation);
    expect(restored.get(audio.id)?.generation).toEqual(audio.generation);
    expect(await readFile((await restored.content(audio.id)).absolutePath, "utf8")).toBe("audio");
    const legacy = await restored.add("legacy.png", Buffer.from("legacy"));
    expect(legacy).not.toHaveProperty("generation");
  });

  it("accepts the configured video aspect ratios without changing image size validation", () => {
    const ratios = new Set([...seedanceModels("volcengine-ark"), ...kunpoVideoModels()].flatMap((model) => model.aspectRatios));
    expect(ratios.has("adaptive")).toBe(true);
    for (const ratio of ratios) expect(publicGenerationParameters({ aspectRatio: ratio, ratio })).toEqual({ aspectRatio: ratio, ratio });
    expect(() => publicGenerationParameters({ size: "adaptive" })).toThrow("Invalid public generation parameter");
  });

  it.each(["Adaptive", "auto", "adaptive-extra", "adaptive\n", "adaptive?token=private", "https://example.invalid/adaptive", "data:adaptive", { adaptive: true }])("rejects non-literal adaptive variants %j", (value) => {
    for (const name of ["aspectRatio", "ratio"]) expect(() => publicGenerationParameters({ [name]: value })).toThrow("Invalid public generation parameter");
  });

  it("selects only bounded public scalar parameters and rejects credentials or malformed provenance", async () => {
    const filtered = publicGenerationParameters({ model: "duplicate", text_prompt: "private request text", references: [{ url: "https://example.invalid?access=private" }], size: "1024x1024", n: 1, masked: false });
    expect(filtered).toEqual({ size: "1024x1024", n: 1, masked: false });
    const base = { model: "seed-audio-1.0", protocol: "kunpo-seed-audio-binary", parameters: { format: "mp3" } };
    for (const invalid of [
      { ...base, apiKey: "private" }, { ...base, model: "https://example.invalid/model" },
      { ...base, taskId: "https://example.invalid?access=private" }, { ...base, taskIds: ["task_ok", { token: "private" }] },
      { ...base, parameters: { text_prompt: "private request text" } }, { ...base, parameters: { referenceCount: { secret: "nested" } } },
      { ...base, parameters: { referenceCount: Number.POSITIVE_INFINITY } }, { ...base, parameters: { speaker: "https://example.invalid?token=private" } },
    ]) expect(() => normalizeGenerationProvenance(invalid)).toThrow();
    const canary = "CANARY_PROVENANCE_CREDENTIAL_TEST_ONLY";
    registerSensitiveValue(canary);
    expect(() => publicGenerationParameters({ speaker: canary })).toThrow();
    expect(() => normalizeGenerationProvenance({ ...base, taskId: canary })).toThrow();
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), "ohmygame-library-no-protected-")));
    await library.load();
    await expect(library.add("voice.mp3", Buffer.from("audio"), { generation: { ...base, parameters: { speaker: canary } } })).rejects.toThrow();
    expect(library.list()).toEqual([]);
  });

  it("refuses unsafe provenance already present on disk instead of exposing it to the renderer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-stored-provenance-"));
    await mkdir(path.join(directory, "library"), { recursive: true });
    await writeFile(path.join(directory, "library", "assets.json"), JSON.stringify({ version: 1, sources: {}, assets: [{
      id: "fixture", name: "voice.mp3", size: 5, mediaType: "audio", contentType: "audio/mpeg", createdAt: "2026-10-28T00:00:00Z",
      generation: { model: "seed-audio-1.0", protocol: "kunpo-seed-audio-binary", parameters: { api_key: "not-public" } },
    }] }));
    await expect(new AssetLibrary(directory).load()).rejects.toThrow("Invalid Library metadata");
  });
});
