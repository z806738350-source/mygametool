import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { GenerationProvenance, LibraryAsset, LibraryAssetDerivation, LibraryAssetOrigin, LibraryAssetPurpose } from "../shared/contracts.js";
import { containsKnownSensitiveValue, knownSensitiveValueOverlap } from "../shared/sensitive-values.js";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";
import { GPT_IMAGE_COMPLEXITIES, GPT_IMAGE_FORMATS, GPT_IMAGE_SVG_EFFORTS, GPT_IMAGE_SVG_MODELS } from "../shared/gpt-image-26.js";
import { workspaceMediaInfo } from "./workspace.js";
import { readMediaDimensions } from "./media-dimensions.js";
import { ProviderImageSourceStore } from "./provider-image-source.js";
import { FBX_MEDIA_TYPE, isFbxArtifact, createFbxPreview } from "./fbx-preview.js";
import { inspectModel3D } from "./model3d-inspect.js";
import { CheckedMediaSnapshotError, CheckedMediaSnapshotStore, type CheckedMediaSnapshot } from "./checked-media-snapshot.js";
import { reserveDerivedMediaSpace, type DerivedMediaSpaceReservation } from "./recovery-space.js";

interface StoredLibrary {
  version: 1;
  assets: LibraryAsset[];
  sources: Record<string, string>;
}

interface AddAssetOptions {
  /** Project-only caches are not an explicit request to keep an independent Library asset. */
  saved?: boolean;
  modelPreview?: Buffer;
  prompt?: string;
  model3d?: LibraryAsset["model3d"];
  sourceKey?: string;
  /** Digest computed by a trusted caller for this exact source file. */
  expectedSha256?: string;
  signal?: AbortSignal;
  duration?: number;
  origin?: LibraryAssetOrigin;
  purpose?: LibraryAssetPurpose;
  derivedFrom?: LibraryAssetDerivation;
  generation?: GenerationProvenance;
}

export class AssetLibraryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class AssetLibrary {
  readonly #filesDirectory: string;
  readonly #metadataFile: string;
  readonly #imageSources: ProviderImageSourceStore;
  readonly #snapshots: CheckedMediaSnapshotStore;
  readonly #ownsSnapshots: boolean;
  #loadedFilesDirectory?: string;
  #state: StoredLibrary = emptyLibrary();
  #mutationChain = Promise.resolve();

  constructor(dataDirectory: string, snapshots?: CheckedMediaSnapshotStore) {
    const directory = path.join(dataDirectory, "library");
    this.#filesDirectory = path.join(directory, "files");
    this.#metadataFile = path.join(directory, "assets.json");
    this.#imageSources = new ProviderImageSourceStore(path.join(directory, "provider-image-sources"));
    this.#snapshots = snapshots ?? new CheckedMediaSnapshotStore(path.join(directory, ".checked-media"));
    this.#ownsSnapshots = !snapshots;
  }

  /** Standalone libraries release their private snapshot store when closed. */
  async close(): Promise<void> { if (this.#ownsSnapshots) await this.#snapshots.close(); }

  async load(): Promise<void> {
    const directory = path.dirname(this.#filesDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new AssetLibraryError("Linked Library directories are unavailable", 409);
    await chmod(directory, 0o700);
    await mkdir(this.#filesDirectory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.#filesDirectory)).isDirectory()) throw new AssetLibraryError("Linked Library directories are unavailable", 409);
    await chmod(this.#filesDirectory, 0o700);
    this.#loadedFilesDirectory = await realpath(this.#filesDirectory);
    try {
      const handle = await open(this.#metadataFile, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      let parsed: unknown;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("Invalid Library metadata");
        parsed = JSON.parse(await handle.readFile("utf8"));
      } finally { await handle.close(); }
      const parsedLibrary = parseLibrary(parsed);
      if (!parsedLibrary) throw new Error("Invalid Library metadata");
      if (containsKnownSensitiveValue(JSON.stringify(parsedLibrary))) throw new AssetLibraryError("Protected data in Library metadata", 409);
      const assets: LibraryAsset[] = [];
      // Sequential reads keep a large Library from exhausting file handles while older records gain dimensions.
      for (const asset of parsedLibrary.assets) assets.push(await this.#withDimensions(asset));
      const stored = { ...parsedLibrary, assets };
      if (JSON.stringify(stored) !== JSON.stringify(parsed)) await this.#write(stored);
      this.#state = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new AssetLibraryError("Linked Library metadata is unavailable", 409);
      throw error;
    }
  }

  list(): LibraryAsset[] {
    return [...this.#state.assets].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(id: string): LibraryAsset | undefined {
    return this.#state.assets.find((asset) => asset.id === id);
  }

  async #assertDirectories(): Promise<void> {
    if (!this.#loadedFilesDirectory || await realpath(this.#filesDirectory) !== this.#loadedFilesDirectory
      || !(await lstat(path.dirname(this.#filesDirectory))).isDirectory() || !(await lstat(this.#filesDirectory)).isDirectory()) {
      throw new AssetLibraryError("Linked Library directories are unavailable", 409);
    }
  }

  async bindGeneratedImageSource(id: string, image: { bytes: Uint8Array }): Promise<boolean> {
    await this.#assertDirectories();
    const asset = this.get(id);
    return asset?.mediaType === "image" && asset.origin === "generated" ? this.#imageSources.bind(id, image) : false;
  }

  async attachImageSource(id: string, reference: object): Promise<void> {
    await this.#assertDirectories();
    const asset = this.get(id);
    if (asset?.mediaType === "image" && asset.origin === "generated") await this.#imageSources.attach(id, reference);
  }

  async add(
    fileName: string,
    contents: Uint8Array,
    options: AddAssetOptions = {},
  ): Promise<LibraryAsset> {
    options.signal?.throwIfAborted();
    assertAssetMetadata(fileName, options);
    assertAssetBytes(contents);
    if (options.model3d?.originalSha256 && createHash("sha256").update(contents).digest("hex") !== options.model3d.originalSha256) throw new AssetLibraryError("The original does not match its retained model binding", 409);
    assertModelPreview(options);
    if (path.extname(fileName).toLowerCase() === ".fbx" && !isFbxArtifact(contents)) throw new AssetLibraryError("Invalid FBX original", 400);
    if (options.modelPreview) { assertAssetBytes(options.modelPreview); await inspectModel3D(options.modelPreview, options.signal); }
    options = { ...options, ...(options.generation === undefined ? {} : { generation: normalizeGenerationProvenance(options.generation) }) };
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const existing = this.#existing(options.sourceKey);
      if (existing) return existing;
      const media = workspaceMediaInfo(fileName);
      if (!media) throw new AssetLibraryError("File is not a supported media asset", 400);
      const id = randomUUID();
      const destination = this.#contentPath(id, fileName);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      let temporaryIdentity: { dev: number; ino: number } | undefined;
      let destinationIdentity: { dev: number; ino: number } | undefined;
      let previewIdentity: { dev: number; ino: number } | undefined;
      try {
        const target = await open(temporary, "wx", 0o600);
        try { const info = await target.stat(); temporaryIdentity = { dev: info.dev, ino: info.ino }; await target.writeFile(contents); }
        finally { await target.close(); }
        const info = await lstat(temporary);
        if (!info.isFile() || info.nlink !== 1 || info.dev !== temporaryIdentity?.dev || info.ino !== temporaryIdentity.ino)
          throw new AssetLibraryError("Temporary Library content changed during import", 409);
        await link(temporary, destination);
        const published = await lstat(destination);
        if (published.dev !== info.dev || published.ino !== info.ino) throw new AssetLibraryError("Temporary Library content changed during import", 409);
        destinationIdentity = temporaryIdentity;
        await unlink(temporary); temporaryIdentity = undefined;
        if (options.modelPreview) {
          const preview = await open(this.#previewPath(id), "wx", 0o600);
          try { const info = await preview.stat(); previewIdentity = { dev: info.dev, ino: info.ino }; await preview.writeFile(options.modelPreview); }
          finally { await preview.close(); }
        }
        return await this.#record(id, fileName, contents.byteLength, media, options, createHash("sha256").update(contents).digest("hex"));
      } catch (error) {
        await removeOwnedFile(destination, destinationIdentity);
        await removeOwnedFile(this.#previewPath(id), previewIdentity);
        throw error;
      } finally {
        await removeOwnedFile(temporary, temporaryIdentity);
      }
    });
  }

  async addFile(
    fileName: string,
    sourcePath: string,
    options: AddAssetOptions = {},
  ): Promise<LibraryAsset> {
    options.signal?.throwIfAborted();
    assertAssetMetadata(fileName, options);
    assertModelPreview(options);
    options.signal?.throwIfAborted();
    if (options.modelPreview) { assertAssetBytes(options.modelPreview); await inspectModel3D(options.modelPreview, options.signal); }
    if (isPrivateProjectPath(sourcePath)) throw new AssetLibraryError("Private files cannot be imported as assets", 400);
    options = { ...options, ...(options.generation === undefined ? {} : { generation: normalizeGenerationProvenance(options.generation) }) };
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const existing = this.#existing(options.sourceKey);
      if (existing && !options.expectedSha256) return existing;
      const media = workspaceMediaInfo(fileName);
      if (!media) throw new AssetLibraryError("File is not a supported media asset", 400);
      if (options.expectedSha256 && options.model3d?.originalSha256 && options.expectedSha256 !== options.model3d.originalSha256)
        throw new AssetLibraryError("The original has conflicting integrity bindings", 409);
      const id = randomUUID();
      const destination = this.#contentPath(id, fileName);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      let snapshot: CheckedMediaSnapshot | undefined;
      let temporaryIdentity: { dev: number; ino: number } | undefined;
      let destinationIdentity: { dev: number; ino: number } | undefined;
      let previewIdentity: { dev: number; ino: number } | undefined;
      let targetReservation: DerivedMediaSpaceReservation | undefined;
      let previewReservation: DerivedMediaSpaceReservation | undefined;
      let targetOpened = false, targetClosed = false;
      let previewOpened = false, previewClosed = false, previewRemoved = false;
      try {
        snapshot = await this.#snapshots.acquire(path.dirname(sourcePath), sourcePath, {
          maxBytes: 256 * 1024 * 1024, signal: options.signal,
          expectedSha256: options.expectedSha256 ?? options.model3d?.originalSha256,
          scope: `library-import:${id}`,
        });
        if (existing) {
          const retained = await this.openSnapshot(existing.id, 256 * 1024 * 1024, false, options.signal);
          try {
            if (retained.snapshot.sha256 !== snapshot.sha256) throw new AssetLibraryError("The retained asset does not match its source", 409);
          } finally { await retained.snapshot.release(); }
          return existing;
        }
        try { targetReservation = await reserveDerivedMediaSpace(this.#loadedFilesDirectory!, snapshot.size, options.signal); }
        catch (cause) {
          options.signal?.throwIfAborted();
          throw new AssetLibraryError("Library import capacity is unavailable", 507);
        }
        const target = await open(temporary, "wx", 0o600);
        targetOpened = true;
        try {
          const info = await target.stat(); temporaryIdentity = { dev: info.dev, ino: info.ino };
          for await (const chunk of snapshot.stream(undefined, options.signal)) {
            options.signal?.throwIfAborted();
            await target.writeFile(chunk);
          }
          await target.sync();
        } finally { await target.close(); targetClosed = true; }
        await targetReservation.release(); targetReservation = undefined;
        options.signal?.throwIfAborted();
        snapshot.assertCurrentPolicy();
        if (media.contentType === FBX_MEDIA_TYPE) {
          const handle = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const header = Buffer.alloc(100), { bytesRead } = await handle.read(header, 0, header.length, 0);
            if (!isFbxArtifact(header.subarray(0, bytesRead))) throw new AssetLibraryError("Invalid FBX original", 400);
          } finally { await handle.close(); }
        }
        const info = await lstat(temporary);
        if (!info.isFile() || info.nlink !== 1 || info.dev !== temporaryIdentity?.dev || info.ino !== temporaryIdentity.ino)
          throw new AssetLibraryError("Temporary Library content changed during import", 409);
        await link(temporary, destination);
        const published = await lstat(destination);
        if (published.dev !== info.dev || published.ino !== info.ino) throw new AssetLibraryError("Temporary Library content changed during import", 409);
        destinationIdentity = { dev: info.dev, ino: info.ino };
        await unlink(temporary); temporaryIdentity = undefined;
        if (options.modelPreview) {
          try { previewReservation = await reserveDerivedMediaSpace(this.#loadedFilesDirectory!, options.modelPreview.byteLength, options.signal); }
          catch (cause) {
            options.signal?.throwIfAborted();
            throw new AssetLibraryError("Library import capacity is unavailable", 507);
          }
          const preview = await open(this.#previewPath(id), "wx", 0o600);
          previewOpened = true;
          try {
            const info = await preview.stat(); previewIdentity = { dev: info.dev, ino: info.ino };
            await preview.writeFile(options.modelPreview);
            await preview.sync();
          } finally { await preview.close(); previewClosed = true; }
          await previewReservation.release(); previewReservation = undefined;
        }
        options.signal?.throwIfAborted();
        return await this.#record(id, fileName, snapshot.size, media, options, snapshot.sha256);
      } catch (error) {
        try { await removeOwnedFile(destination, destinationIdentity); }
        finally { previewRemoved = await removeOwnedFile(this.#previewPath(id), previewIdentity); }
        throw librarySnapshotError(error, true);
      } finally {
        try {
          const removed = await removeOwnedFile(temporary, temporaryIdentity);
          if (targetReservation && (!targetOpened || targetClosed && removed)) await targetReservation.release();
          if (previewReservation && (!previewOpened || previewClosed && previewRemoved)) await previewReservation.release();
        } finally {
          if (snapshot) {
            await snapshot.release();
            await this.#snapshots.evictScope(`library-import:${id}`);
          }
        }
      }
    });
  }

  async content(id: string, preview = false): Promise<{ asset: LibraryAsset; absolutePath: string }> {
    await this.#assertDirectories();
    const asset = this.#variant(id, preview);
    if (!asset) throw new AssetLibraryError("Library asset not found", 404);
    const absolutePath = preview && this.get(id)?.contentType === FBX_MEDIA_TYPE ? this.#previewPath(id) : this.#contentPath(asset.id, asset.name);
    try {
      const entry = await lstat(absolutePath);
      if (!entry.isFile() || entry.nlink !== 1) throw new AssetLibraryError("Library asset content not found", 404);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AssetLibraryError("Library asset content not found", 404);
      throw error;
    }
    return { asset, absolutePath };
  }

  /** Acquire a complete checked snapshot before exposing any content bytes. */
  async openSnapshot(id: string, maxBytes = 200 * 1024 * 1024, preview = false, signal?: AbortSignal): Promise<{ asset: LibraryAsset; snapshot: CheckedMediaSnapshot }> {
    await this.#assertDirectories();
    const asset = this.#variant(id, preview);
    if (!asset) throw new AssetLibraryError("Library asset not found", 404);
    const original = this.get(id)!;
    const fbxPreview = preview && original.contentType === FBX_MEDIA_TYPE;
    if (!fbxPreview && original.model3d?.originalSha256 && original.contentSha256 && original.model3d.originalSha256 !== original.contentSha256)
      throw new AssetLibraryError("The retained original has conflicting integrity bindings", 409);
    const expectedSha256 = fbxPreview ? original.model3d?.preview?.sha256 : original.model3d?.originalSha256 ?? original.contentSha256;
    try {
      const filename = fbxPreview ? this.#previewPath(id) : this.#contentPath(asset.id, asset.name);
      const snapshot = await this.#snapshots.acquire(this.#filesDirectory, filename, { maxBytes, signal, expectedSha256, scope: `library:${id}:${fbxPreview ? "preview" : "original"}` });
      return { asset, snapshot };
    } catch (cause) {
      if (expectedSha256 && cause instanceof CheckedMediaSnapshotError && cause.code === "CHECKED_MEDIA_CHANGED")
        throw new AssetLibraryError("The retained asset failed its integrity check or changed during inspection", 409);
      throw librarySnapshotError(cause);
    }
  }

  async openContent(id: string, maxBytes = 200 * 1024 * 1024, preview = false, signal?: AbortSignal): Promise<{ asset: LibraryAsset; stream: Readable; size: number }> {
    let snapshot: CheckedMediaSnapshot | undefined;
    try {
      const opened = await this.openSnapshot(id, maxBytes, preview, signal);
      snapshot = opened.snapshot;
      return { asset: opened.asset, stream: snapshot.stream(undefined, signal), size: snapshot.size };
    } catch (cause) {
      await snapshot?.release();
      if (cause instanceof AssetLibraryError && cause.statusCode === 403 && cause.message === "Protected credential data cannot be served")
        throw new AssetLibraryError("Protected data cannot be stored in asset content", 400);
      throw librarySnapshotError(cause);
    }
  }

  async rename(id: string, name: string): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      const trimmed = name.trim();
      const extension = path.extname(asset.name);
      if (!trimmed || /[\\/]/.test(trimmed)) throw new AssetLibraryError("Invalid asset name", 400);
      assertAssetMetadata(trimmed, {});
      const updated = { ...asset, name: `${trimmed}${extension}` };
      const state = { ...this.#state, assets: this.#state.assets.map((candidate) => candidate.id === id ? updated : candidate) };
      await this.#write(state);
      this.#state = state;
      return updated;
    });
  }

  async save(id: string): Promise<LibraryAsset> {
    return this.#mutate(async () => {
      const asset = this.get(id);
      if (!asset) throw new AssetLibraryError("Library asset not found", 404);
      if (asset.purpose === "asset" && asset.saved) return asset;
      const updated = { ...asset, purpose: "asset" as const, saved: true };
      const state = { ...this.#state, assets: this.#state.assets.map((candidate) => candidate.id === id ? updated : candidate) };
      await this.#write(state);
      this.#state = state;
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.#mutate(() => this.#delete(id));
  }

  /** Associate before copying, so project deletion cannot remove a shared source mid-import. */
  async associateProject(id: string, projectId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) throw new AssetLibraryError("Invalid project asset owner", 400);
    await this.#mutate(async () => {
      if (!this.get(id)) throw new AssetLibraryError("Library asset not found", 404);
      const key = `project:${projectId}:shared:${id}`;
      if (this.#state.sources[key] === id) return;
      const sources = { ...this.#state.sources, [key]: id };
      await this.#write({ ...this.#state, sources }); this.#state.sources = sources;
    });
  }

  /** Drop only unsaved project copies; references in another project inherit the existing source association. */
  async removeProjectCopies(projectId: string, referencedProjects: (assetId: string) => Promise<readonly string[]>): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId)) throw new AssetLibraryError("Invalid project asset owner", 400);
    await this.#mutate(async () => {
      const owned = (key: string) => key.startsWith(`project:${projectId}:`) || key.startsWith(`canvas:${projectId}:`);
      const ids = new Set(Object.entries(this.#state.sources).filter(([key]) => owned(key)).map(([, id]) => id));
      const releases: Array<{ id: string; references: readonly string[] }> = [];
      // Finish every reference check before deleting; an unreadable project preserves all copies.
      // ponytail: very large libraries scan project references per asset; batch those reads if deletion becomes slow.
      for (const id of ids) if (this.get(id)?.saved === false) {
        const owners = Object.entries(this.#state.sources).flatMap(([key, assetId]) => {
          const match = /^(?:project|canvas):([^:]+):/.exec(key);
          return assetId === id && match ? [match[1]!] : [];
        });
        const references = [...new Set([...owners, ...await referencedProjects(id)])].filter(id => id !== projectId);
        if (references.some(id => !/^[a-zA-Z0-9_-]{1,120}$/.test(id))) throw new AssetLibraryError("Invalid project asset reference", 409);
        releases.push({ id, references });
      }
      const sources = { ...this.#state.sources };
      for (const { id, references } of releases) for (const owner of references) sources[`project:${owner}:shared:${id}`] = id;
      await this.#write({ ...this.#state, sources }); this.#state.sources = sources;
      for (const { id, references } of releases) if (!references.length) await this.#delete(id);
      const retainedSources = Object.fromEntries(Object.entries(this.#state.sources).filter(([key]) => !owned(key)));
      await this.#write({ ...this.#state, sources: retainedSources }); this.#state.sources = retainedSources;
    });
  }

  async #delete(id: string): Promise<void> {
    const asset = this.get(id);
    if (!asset) throw new AssetLibraryError("Library asset not found", 404);
    // Keep ownership metadata until file cleanup finishes, so an IO failure remains retryable.
    await rm(this.#contentPath(asset.id, asset.name), { force: true });
    await rm(this.#previewPath(id), { force: true });
    await this.#imageSources.delete(id);
    await this.#snapshots.evictScope(`library:${id}:original`);
    await this.#snapshots.evictScope(`library:${id}:preview`);
    const sources = Object.fromEntries(Object.entries(this.#state.sources).filter(([, assetId]) => assetId !== id));
    const state = { ...this.#state, assets: this.#state.assets.filter((candidate) => candidate.id !== id), sources };
    await this.#write(state);
    this.#state = state;
  }

  #existing(sourceKey?: string): LibraryAsset | undefined {
    const id = sourceKey ? this.#state.sources[sourceKey] : undefined;
    return id ? this.get(id) : undefined;
  }

  /** Rebuild only from the retained original; this method has no provider or generation connection. */
  async rebuildModelPreview(id: string, signal?: AbortSignal): Promise<LibraryAsset> {
    const asset = this.get(id);
    if (asset?.contentType !== FBX_MEDIA_TYPE) throw new AssetLibraryError("Choose an FBX original", 400);
    const opened = await this.openContent(id, 64 * 1024 * 1024, false, signal), chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    const original = Buffer.concat(chunks), bytes = await createFbxPreview(original, signal), inspected = await inspectModel3D(bytes, signal);
    assertAssetBytes(bytes);
    return this.#mutate(async () => {
      const current = this.get(id); if (!current) throw new AssetLibraryError("Library asset not found", 404);
      const temporary = `${this.#previewPath(id)}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, this.#previewPath(id)); }
      finally { await rm(temporary, { force: true }); }
      const updated = { ...current, model3d: { ...current.model3d, ...inspected, originalSha256: createHash("sha256").update(original).digest("hex"), preview: { status: "ready" as const, materialApproximation: true as const, sha256: createHash("sha256").update(bytes).digest("hex") } } };
      await this.#write({ ...this.#state, assets: this.#state.assets.map(candidate => candidate.id === id ? updated : candidate) });
      this.#state.assets = this.#state.assets.map(candidate => candidate.id === id ? updated : candidate);
      return updated;
    });
  }

  #variant(id: string, preview: boolean): LibraryAsset | undefined {
    const asset = this.get(id);
    if (!asset || !preview || asset.contentType !== FBX_MEDIA_TYPE) return asset;
    if (asset.model3d?.preview?.status !== "ready") throw new AssetLibraryError("The FBX original is retained. Its triangulated GLB preview is unavailable; rebuild the local preview.", 409);
    return { ...asset, name: `${path.parse(asset.name).name}-preview.glb`, contentType: "model/gltf-binary", contentSha256: asset.model3d.preview.sha256 };
  }
  #previewPath(id: string): string { return path.join(this.#filesDirectory, `${id}.preview.glb`); }

  async #record(
    id: string,
    fileName: string,
    size: number,
    media: { mediaType: LibraryAsset["mediaType"]; contentType: string },
    options: AddAssetOptions,
    originalSha256?: string,
  ): Promise<LibraryAsset> {
    const origin = options.origin ?? originFromSource(options.sourceKey);
    const asset: LibraryAsset = await this.#withDimensions({
      id,
      name: path.basename(fileName),
      size,
      ...(originalSha256 ? { contentSha256: originalSha256 } : {}),
      ...media,
      createdAt: new Date().toISOString(),
      origin,
      purpose: options.purpose ?? "asset",
      saved: options.saved ?? origin !== "workspace",
      ...(media.contentType === FBX_MEDIA_TYPE ? { model3d: { triangles: 0, textured: false, rigged: false, animations: [], ...options.model3d, originalSha256,
        preview: { status: options.modelPreview ? "ready" as const : "unavailable" as const, materialApproximation: true as const,
          ...(options.modelPreview ? { sha256: createHash("sha256").update(options.modelPreview).digest("hex") } : {}) } } } : options.model3d ? { model3d: options.model3d } : {}),
      ...(options.duration !== undefined ? { duration: options.duration } : {}),
      ...(options.prompt?.trim() ? { prompt: options.prompt.trim() } : {}),
      ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
      ...(options.generation ? { generation: options.generation } : {}),
    });
    const state = {
      ...this.#state,
      assets: [...this.#state.assets, asset],
      sources: options.sourceKey ? { ...this.#state.sources, [options.sourceKey]: id } : this.#state.sources,
    };
    await this.#write(state);
    this.#state = state;
    return asset;
  }

  async #withDimensions(asset: LibraryAsset): Promise<LibraryAsset> {
    const entry = await lstat(this.#contentPath(asset.id, asset.name)).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; });
    if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new AssetLibraryError("Linked Library content is unavailable", 409);
    if (asset.width !== undefined || (asset.mediaType !== "image" && asset.mediaType !== "video")) return asset;
    const dimensions = await readMediaDimensions(this.#contentPath(asset.id, asset.name));
    return dimensions ? { ...asset, ...dimensions } : asset;
  }

  #contentPath(id: string, fileName: string): string {
    return path.join(this.#filesDirectory, `${id}${path.extname(fileName).toLowerCase()}`);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.#mutationChain.catch(() => undefined).then(() => this.#assertDirectories()).then(operation);
    this.#mutationChain = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  async #write(state: StoredLibrary): Promise<void> {
    const temporary = `${this.#metadataFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.#metadataFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function emptyLibrary(): StoredLibrary {
  return { version: 1, assets: [], sources: {} };
}

function assertAssetMetadata(name: string, options: AddAssetOptions): void {
  if (!path.basename(name) || /[\0-\x1f\x7f]/.test(name) || isPrivateProjectPath(name)) throw new AssetLibraryError("Invalid asset name", 400);
  const { modelPreview: _preview, signal: _signal, expectedSha256: _expected, ...metadata } = options;
  if (containsKnownSensitiveValue(JSON.stringify({ name, ...metadata }))) throw new AssetLibraryError("Protected data cannot be stored in asset metadata", 400);
}

function assertAssetBytes(bytes: Uint8Array): void {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), overlap = knownSensitiveValueOverlap() * 4;
  for (let offset = 0; offset < data.length; offset += 64 * 1024) {
    if (containsKnownSensitiveValue(data.subarray(Math.max(0, offset - overlap), offset + 64 * 1024).toString("utf8"))) throw new AssetLibraryError("Protected data cannot be stored in asset content", 400);
  }
}

function assertModelPreview(options: AddAssetOptions) {
  if (options.modelPreview && options.model3d?.preview?.sha256 && createHash("sha256").update(options.modelPreview).digest("hex") !== options.model3d.preview.sha256) throw new AssetLibraryError("The preview does not match its retained model binding", 409);
}

function librarySnapshotError(cause: unknown, importing = false): unknown {
  if (!(cause instanceof CheckedMediaSnapshotError)) return cause;
  if (cause.code === "CHECKED_MEDIA_PROTECTED") return new AssetLibraryError(importing ? "Protected data cannot be stored in asset content" : "Protected credential data cannot be served", importing ? 400 : 403);
  if (cause.code === "CHECKED_MEDIA_UNSAFE") return new AssetLibraryError(importing ? "Linked or non-ordinary assets cannot be imported" : "Library asset content not found", importing ? 400 : 404);
  return new AssetLibraryError(cause.message, cause.statusCode);
}

async function removeOwnedFile(filename: string, identity?: { dev: number; ino: number }): Promise<boolean> {
  if (!identity) return false;
  const current = await lstat(filename).catch(() => undefined);
  if (current?.dev !== identity.dev || current.ino !== identity.ino) return false;
  await unlink(filename);
  return current.nlink === 1;
}

function parseLibrary(value: unknown): StoredLibrary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Partial<StoredLibrary>;
  if (stored.version !== 1 || !Array.isArray(stored.assets) || !stored.sources || typeof stored.sources !== "object" || Array.isArray(stored.sources)) return undefined;
  const ids = new Set<string>();
  if (!stored.assets.every((asset) => isLibraryAsset(asset) && !ids.has(asset.id) && Boolean(ids.add(asset.id)))) return undefined;
  if (!Object.entries(stored.sources).every(([source, id]) => Boolean(source) && typeof id === "string" && ids.has(id))) return undefined;
  const sources = new Map<string, string[]>();
  for (const [source, id] of Object.entries(stored.sources)) {
    const keys = sources.get(id) ?? [];
    keys.push(source);
    sources.set(id, keys);
  }
  return {
    ...(stored as StoredLibrary),
    assets: stored.assets.map((asset) => {
      const keys = sources.get(asset.id) ?? [];
      const inferred = keys.map(originFromSource);
      const known = inferred.find((origin) => origin === "generated") ?? inferred.find((origin) => origin !== "unknown");
      // Legacy source-less records were created by the upload endpoints.
      const origin = asset.origin && asset.origin !== "unknown" ? asset.origin : known ?? asset.origin ?? (keys.length ? "unknown" : "uploaded");
      return {
        ...asset,
        origin,
        purpose: asset.purpose ?? (keys.some((key) => key.startsWith("conversation-image:")) ? "reference" : "asset"),
        saved: asset.saved ?? origin !== "workspace",
      };
    }),
  };
}

function originFromSource(source?: string): LibraryAssetOrigin {
  if (source?.startsWith("tool:")) return "generated";
  if (source?.startsWith("conversation-image:")) return "uploaded";
  if (source?.startsWith("builtin:")) return "builtin";
  if (source?.startsWith("project:") || source?.startsWith("canvas:")) return "workspace";
  return "unknown";
}

function isLibraryAsset(value: unknown): value is LibraryAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<LibraryAsset>;
  return typeof asset.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(asset.id) && typeof asset.name === "string" && Boolean(asset.name) && !/[\\/\0-\x1f\x7f]/.test(asset.name) &&
    typeof asset.size === "number" && asset.size >= 0 &&
    (asset.contentSha256 === undefined || typeof asset.contentSha256 === "string" && /^[a-f0-9]{64}$/.test(asset.contentSha256)) &&
    (asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model") &&
    typeof asset.contentType === "string" && typeof asset.createdAt === "string" && Number.isFinite(Date.parse(asset.createdAt)) &&
    (asset.duration === undefined || typeof asset.duration === "number" && Number.isFinite(asset.duration) && asset.duration >= 0) &&
    [asset.width, asset.height].every((value) => value === undefined || Number.isInteger(value) && value > 0) &&
    (asset.prompt === undefined || typeof asset.prompt === "string") &&
    (asset.origin === undefined || ["generated", "uploaded", "workspace", "builtin", "unknown"].includes(asset.origin)) &&
    (asset.purpose === undefined || asset.purpose === "asset" || asset.purpose === "reference") &&
    (asset.saved === undefined || typeof asset.saved === "boolean") &&
    (asset.derivedFrom === undefined || isLibraryAssetDerivation(asset.derivedFrom)) &&
    (asset.generation === undefined || validGenerationProvenance(asset.generation)) &&
    (asset.model3d?.originalSha256 === undefined || typeof asset.model3d.originalSha256 === "string" && /^[a-f0-9]{64}$/.test(asset.model3d.originalSha256)) &&
    (asset.model3d?.preview === undefined || ["ready", "unavailable"].includes(asset.model3d.preview.status) && asset.model3d.preview.materialApproximation === true &&
      (asset.model3d.preview.status !== "ready" || typeof asset.model3d.preview.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.model3d.preview.sha256)));
}

const PUBLIC_STRING_VALUES: Record<string, readonly string[]> = {
  quality: ["auto", "low", "medium", "high", "xhigh", "max"], background: ["auto", "opaque", "transparent"],
  output_format: [...GPT_IMAGE_FORMATS, "mp4", "mov", "mp3", "wav", "pcm", "ogg_opus"], outputFormat: [...GPT_IMAGE_FORMATS, "mp4", "mov"],
  complexity: GPT_IMAGE_COMPLEXITIES, svgModel: GPT_IMAGE_SVG_MODELS, svgReasoningEffort: GPT_IMAGE_SVG_EFFORTS,
  response_format: ["url", "b64_json", "mp3", "wav", "pcm", "ogg_opus"], format: ["png", "jpeg", "mp3", "wav", "pcm", "ogg_opus", "mp4", "mov", "glb", "fbx"],
  imageSize: ["1K", "2K", "4K"], referenceMode: ["frame", "reference"], operation: ["speech", "dialogue", "sound-effect", "music", "image", "text", "remesh", "retexture", "animate"],
  thinkingLevel: ["minimal", "low", "medium", "high", "xhigh", "max"],
  texture_quality: ["fast", "standard", "detailed", "extreme"], geometry_quality: ["standard", "detailed"],
  rig_type: ["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"],
  spec: ["tripo", "mixamo", "actorcore", "unity", "unreal", "vrm"], out_format: ["glb", "fbx"],
};
const PUBLIC_NUMBER_KEYS = new Set(["frame_count", "frame_duration_ms", "n", "referenceCount", "referenceUrlCount", "referenceLocalCount", "referenceRequestBytes", "referenceOriginalRequestBytes", "referencePreparationVersion", "referenceBudgetBytes", "referenceBudgetPasses", "referenceBudgetConverted", "referenceBudgetResized", "referenceBudgetQuality", "referenceBudgetMaxEdge", "referenceJpegConverted", "referenceJpegSkipped", "referenceJpegTransparent", "referenceJpegLimited", "referenceJpegResized", "referenceJpegOriented", "referenceJpegQuality", "referenceJpegMaxEdge", "referencePngOptimized", "referencePngUnchanged", "referencePngUnsupported", "referencePngInvalid", "referencePngLimited", "referencePngBytesOriginal", "referencePngBytesSent", "output_compression", "duration", "seconds", "sample_rate", "sampleRate", "speech_rate", "speechRate", "requested_duration_seconds", "face_limit", "seed"]);
const PUBLIC_BOOLEAN_KEYS = new Set(["markedUp", "stream", "masked", "generateAudio", "generate_audio", "watermark", "quad", "smart_uv", "bake", "texture", "pbr", "animate_in_place", "export_with_geometry", "voiceDesign"]);
const PUBLIC_STRING_PATTERNS: Record<string, RegExp> = {
  referenceAssetId: /^[A-Za-z0-9_-]{1,120}$/, referenceSha256: /^[a-f0-9]{64}$/,
  size: /^(?:auto|\d{1,5}x\d{1,5}|\d{1,2}:\d{1,2})$/, aspectRatio: /^(?:adaptive|\d{1,2}:\d{1,2})$/, ratio: /^(?:adaptive|\d{1,2}:\d{1,2})$/,
  resolution: /^(?:480[pP]|720[pP]|768[pP]|1080[pP]|[124]K)$/,
  speaker: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/,
  texture_version: /^v\d\.\d-\d{8}$/,
};
function safeProvenanceString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u0020\\]/.test(value) &&
    !/(?:[a-z][a-z0-9+.-]*:\/\/|data:|bearer|(?:^|[?&])(?:key|token|access|signature|authorization)=)/i.test(value) && !containsKnownSensitiveValue(value);
}
function publicParameter(name: string, value: unknown): value is string | number | boolean {
  if (PUBLIC_NUMBER_KEYS.has(name)) return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
  if (PUBLIC_BOOLEAN_KEYS.has(name)) return typeof value === "boolean";
  if (!safeProvenanceString(value, 256)) return false;
  if (Object.hasOwn(PUBLIC_STRING_VALUES, name)) return PUBLIC_STRING_VALUES[name]!.includes(value);
  if (Object.hasOwn(PUBLIC_STRING_PATTERNS, name)) return PUBLIC_STRING_PATTERNS[name]!.test(value);
  return false;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

/** Deliberately drops request text, references, model duplicates, URLs and unknown fields. */
export function publicGenerationParameters(value: unknown): GenerationProvenance["parameters"] {
  if (!plainObject(value) || Object.keys(value).length > 64) throw new AssetLibraryError("Invalid generation parameters", 400);
  const result: GenerationProvenance["parameters"] = {};
  for (const [name, parameter] of Object.entries(value)) {
    if (!PUBLIC_NUMBER_KEYS.has(name) && !PUBLIC_BOOLEAN_KEYS.has(name) && !Object.hasOwn(PUBLIC_STRING_VALUES, name) && !Object.hasOwn(PUBLIC_STRING_PATTERNS, name)) continue;
    if (!publicParameter(name, parameter)) throw new AssetLibraryError("Invalid public generation parameter", 400);
    result[name] = parameter;
  }
  if (containsKnownSensitiveValue(JSON.stringify(result))) throw new AssetLibraryError("Protected data in generation parameters", 400);
  return result;
}

/** Copies only bounded, reviewed metadata; never include request bodies or credentials. */
export function normalizeGenerationProvenance(value: unknown): GenerationProvenance {
  const fail = () => new AssetLibraryError("Invalid generation provenance", 400);
  if (!plainObject(value) || Object.keys(value).some((key) => !["model", "protocol", "parameters", "taskId", "taskIds"].includes(key)) ||
      !safeProvenanceString(value.protocol, 80) || !/^[a-z0-9][a-z0-9._-]*$/i.test(value.protocol) ||
      value.model !== undefined && (!safeProvenanceString(value.model, 200) || !/^[a-z0-9~][a-z0-9~_.:/@-]*$/i.test(value.model)) || !plainObject(value.parameters)) throw fail();
  const parameters = publicGenerationParameters(value.parameters);
  if (Object.keys(parameters).length !== Object.keys(value.parameters).length) throw fail();
  const validTaskId = (id: unknown): id is string => safeProvenanceString(id, 256) && /^[a-z0-9][a-z0-9_.:-]*$/i.test(id);
  if (value.taskId !== undefined && !validTaskId(value.taskId) || value.taskIds !== undefined && (!Array.isArray(value.taskIds) || value.taskIds.length > 16 || !value.taskIds.every(validTaskId))) throw fail();
  return { ...(value.model === undefined ? {} : { model: value.model as string }), protocol: value.protocol, parameters,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId as string }), ...(value.taskIds === undefined ? {} : { taskIds: [...value.taskIds as string[]] }) };
}
function validGenerationProvenance(value: unknown): boolean {
  try { normalizeGenerationProvenance(value); return true; } catch { return false; }
}

export function isLibraryAssetDerivation(value: unknown): value is LibraryAssetDerivation {
  if (!value || typeof value !== "object") return false;
  const derivation = value as Partial<LibraryAssetDerivation>;
  const trim = derivation.trim as Partial<LibraryAssetDerivation["trim"]> | undefined;
  return typeof derivation.assetId === "string" && Boolean(derivation.assetId) &&
    Boolean(trim) && typeof trim === "object" &&
    typeof trim.start === "number" && Number.isFinite(trim.start) && trim.start >= 0 &&
    typeof trim.end === "number" && Number.isFinite(trim.end) && trim.end > trim.start;
}
