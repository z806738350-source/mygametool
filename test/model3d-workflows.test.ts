import { MESHY_DISABLED_MESSAGE } from "../src/shared/disabled-media-providers.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  readModelResources,
  storeModelResources,
} from "../src/daemon/model-resources.js";
import { projectFiles } from "../src/daemon/isolated-project-files.js";
import { listWorkspaceFiles } from "../src/daemon/workspace.js";
import {
  createAgentTools,
  activePiToolNames,
} from "../src/daemon/agent-tools.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  MeshyProvider,
  TripoProvider,
  Hyper3DProvider,
} from "./local-secure-provider-fixtures.js";
import { ProviderModels3D } from "../src/daemon/provider-models3d.js";
import {
  hasAttempted3DTask,
  hasSaved3DTask,
  model3DJournal,
} from "../src/daemon/model3d-journal.js";
import {
  inspectModel3D,
  modelFacingPositiveZ,
} from "../src/daemon/model3d-inspect.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { normalizeModelUsages } from "../src/shared/custom-models.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";
import type { CustomProviderDetails } from "../src/shared/contracts.js";
import { MODEL3D_CONNECTION_ID } from "../src/shared/model3d-operations.js";
import { resolveModel3DConnection } from "../src/shared/generation-config.js";
import { TEST_GLB, model3DFixture, fbxFixture } from "./model3d-fixture.js";
import {
  createFbxPreview,
  inspectFbx,
  FBX_MEDIA_TYPE,
} from "../src/daemon/fbx-preview.js";
import {
  exportProjectArchive,
  importProjectArchive,
} from "../src/daemon/project-archive.js";
import { checkCanvasWorkspace } from "../src/daemon/canvas-check.js";
import {
  ensureCanvasAssets,
  canvasLibraryAsset,
} from "../src/daemon/canvas-assets.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-workflows-"));
  directories.push(value);
  return value;
}
const meshyModel = { provider: "meshy", id: "meshy-t2" },
  tripoModel = { provider: "tripo", id: "P1-20260311" };
const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };
const artifact = "http://127.0.0.1:43199/result.glb";

describe("Game model resources", () => {
  it("retains an oversized GLB without relaxing the existing runtime-media budget", async () => {
    const root = await directory(),
      library = new AssetLibrary(root);
    await library.load();
    const io = new NodeIO(),
      document = await io.readBinary(TEST_GLB);
    document
      .getRoot()
      .listTextures()[0]!
      .setImage(Buffer.alloc(32 * 1024 * 1024 + 1));
    const bytes = Buffer.from(await io.writeBinary(document)),
      asset = await library.add("oversized.glb", bytes);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const resources = await storeModelResources(workspace, asset, bytes);
    expect(resources).toMatchObject({
      ready: false,
      resources: [],
      error: expect.stringContaining(
        "existing 32 MiB runtime media file limit",
      ),
    });
    expect(resources.runtimePath).toBeUndefined();
    expect(
      (await readFile(path.join(workspace, resources.originalPath))).equals(
        bytes,
      ),
    ).toBe(true);
  });

  it("lets a new Agent resolve a large PBR result into verified runtime media without another generation", async () => {
    const root = await directory(),
      library = new AssetLibrary(root);
    await library.load();
    const io = new NodeIO(),
      document = await io.readBinary(
        await model3DFixture({ rigged: true, clips: ["Walk"] }),
      );
    const texture = document.getRoot().listTextures()[0]!;
    texture.setImage(
      Buffer.concat([
        Buffer.from(texture.getImage()!),
        Buffer.alloc(2 * 1024 * 1024),
      ]),
    );
    const bytes = Buffer.from(await io.writeBinary(document)),
      asset = await library.add("large-pbr.glb", bytes);
    const projects = new ProjectManager(root, library);
    await projects.load();
    const project = await projects.create("PBR", "web-game");
    await projects.materializeLibraryAsset(project.id, asset.id);
    const generate = vi.fn(),
      runner = new ToolRunner(root, { generate });
    await runner.load();
    try {
      const resolve = createAgentTools(project, runner, projects).find(
        (tool) => tool.name === "get_model_asset",
      )!;
      const result = await resolve.execute(
        "inspect",
        { assetId: asset.id },
        undefined,
        undefined,
        {} as never,
      );
      const resources = JSON.parse(
        result.content[0]?.type === "text" ? result.content[0].text : "{}",
      );
      expect(resources).toMatchObject({
        ready: true,
        runtimeMode: "media",
        model: {
          rigged: true,
          animationClips: [{ name: "Walk", durationSeconds: 1, channels: 1 }],
        },
      });
      expect(
        (
          await readFile(
            path.join(project.workspacePath, resources.runtimePath),
          )
        ).equals(bytes),
      ).toBe(true);
      const media: import("../src/daemon/isolated-project-files.js").RuntimeMedia[] =
        [];
      const source = await projectFiles(project.workspacePath, media);
      expect(media).toContainEqual(
        expect.objectContaining({
          path: resources.runtimePath,
          size: bytes.length,
        }),
      );
      expect(
        source.every(
          (file) => Buffer.from(file.data, "base64").length <= 2 * 1024 * 1024,
        ),
      ).toBe(true);
      expect(generate).not.toHaveBeenCalled();
      await writeFile(
        path.join(project.workspacePath, resources.runtimePath),
        "damaged",
      );
      await expect(
        readModelResources(project.workspacePath, asset.id),
      ).rejects.toThrow("integrity");
      const repaired = await projects.modelAssetResources(project.id, {
        assetId: asset.id,
        rebuildPreview: true,
      });
      expect(repaired).toMatchObject({
        ready: true,
        runtimePath: resources.runtimePath,
      });
      expect(
        (
          await readFile(
            path.join(project.workspacePath, resources.originalPath),
          )
        ).equals(bytes),
      ).toBe(true);
      const saved = JSON.parse(
        await readFile(
          path.join(
            project.workspacePath,
            "assets/models",
            `${asset.id}.model.json`,
          ),
          "utf8",
        ),
      );
      saved.runtimePath = "assets/files/models/elsewhere.glb";
      await writeFile(
        path.join(
          project.workspacePath,
          "assets/models",
          `${asset.id}.model.json`,
        ),
        JSON.stringify(saved),
      );
      await expect(
        readModelResources(project.workspacePath, asset.id),
      ).rejects.toThrow();
    } finally {
      await runner.close();
    }
  });

  it("separates an interleaved large GLB into bounded standard glTF without relaxing isolated transfer limits", async () => {
    const root = await directory(),
      doc = new Document(),
      buffer = doc.createBuffer(),
      count = 150_000;
    const position = doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array(count * 3))
        .setBuffer(buffer),
      uv = doc
        .createAccessor()
        .setType("VEC2")
        .setArray(new Float32Array(count * 2))
        .setBuffer(buffer);
    const primitive = doc
        .createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("TEXCOORD_0", uv),
      mesh = doc.createMesh().addPrimitive(primitive);
    doc.createScene().addChild(doc.createNode().setMesh(mesh));
    const bytes = Buffer.from(await new NodeIO().writeBinary(doc));
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    const library = new AssetLibrary(root);
    await library.load();
    const asset = await library.add("large.glb", bytes);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const resources = await storeModelResources(workspace, asset, bytes);
    expect(resources.ready).toBe(true);
    expect(
      resources.resources.every((file) => file.size <= 2 * 1024 * 1024),
    ).toBe(true);
    const files = await projectFiles(workspace);
    expect(files.some((file) => file.path.startsWith(".data"))).toBe(false);
    expect(
      files.every(
        (file) => Buffer.from(file.data, "base64").length <= 2 * 1024 * 1024,
      ),
    ).toBe(true);
    const json = JSON.parse(
        await readFile(path.join(workspace, resources.runtimePath!), "utf8"),
      ),
      binary: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const file of resources.resources.filter((file) =>
      file.path.endsWith(".bin"),
    ))
      binary[path.basename(file.path)] = new Uint8Array(
        await readFile(path.join(workspace, file.path)),
      );
    const restored = await new NodeIO().readJSON({ json, resources: binary });
    expect(
      restored
        .getRoot()
        .listAccessors()
        .find((a) => a.getType() === "VEC3")
        ?.getCount(),
    ).toBe(count);
    expect(
      await readFile(path.join(workspace, resources.originalPath)),
    ).toEqual(bytes);
    await writeFile(
      path.join(workspace, resources.resources[0]!.path),
      "damaged",
    );
    await expect(readModelResources(workspace, asset.id)).rejects.toThrow(
      "integrity",
    );
    const rebuilt = await storeModelResources(
      workspace,
      asset,
      bytes,
      undefined,
      true,
    );
    expect(rebuilt.ready).toBe(true);
    expect(rebuilt.runtimePath).toBe(resources.runtimePath);
  });

  it("scopes Agent model access to the current project, repairs locally and reopens/export-imports its pair", async () => {
    const root = await directory(),
      library = new AssetLibrary(root);
    await library.load();
    const original = fbxFixture(),
      preview = await createFbxPreview(original),
      asset = await library.add("quad.fbx", original, {
        modelPreview: preview,
      });
    const projects = new ProjectManager(root, library);
    await projects.load();
    const project = await projects.create("Game", "web-game"),
      other = await projects.create("Other", "web-game");
    const runner = new ToolRunner(root, { generate: vi.fn() });
    await runner.load();
    const tools = createAgentTools(project, runner, projects),
      resolver = tools.find((tool) => tool.name === "get_model_asset")!;
    expect(
      activePiToolNames(
        [],
        tools.map((tool) => tool.name),
      ),
    ).toContain("get_model_asset");
    await expect(
      resolver.execute(
        "read",
        { assetId: asset.id },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("does not match a model bound to this project") });
    await projects.materializeLibraryAsset(project.id, asset.id);
    expect(
      (
        await listWorkspaceFiles(project.workspacePath, { assets: true })
      ).filter((file) => file.mediaType === "model"),
    ).toEqual([
      expect.objectContaining({
        libraryAssetId: asset.id,
        path: expect.stringMatching(/original\.fbx$/),
        previewPath: expect.stringMatching(/\.glb$/),
      }),
    ]);
    expect(
      (await listWorkspaceFiles(other.workspacePath, { assets: true })).some(
        (file) => file.mediaType === "model",
      ),
    ).toBe(false);
    const resolved = await resolver.execute(
      "read",
      { assetId: asset.id },
      undefined,
      undefined,
      {} as never,
    );
    const resources = JSON.parse(
      resolved.content[0]?.type === "text" ? resolved.content[0].text : "{}",
    );
    expect(resources?.ready).toBe(true);
    const runtime = JSON.parse(
      await readFile(
        path.join(project.workspacePath, resources.runtimePath),
        "utf8",
      ),
    );
    expect(runtime.images[0]).toMatchObject({
      uri: expect.stringMatching(/^texture-\d+\.png$/),
    });
    expect(runtime.images[0].bufferView).toBeUndefined();
    const adoption = vi.spyOn(projects, "ensureLibraryAsset"), materialize = vi.spyOn(projects, "materializeLibraryAsset");
    const denied = await projects.modelAssetResources(other.id, { assetId: asset.id }).catch(error => error);
    expect(denied).toMatchObject({ statusCode: 403, message: expect.stringContaining("does not match a model bound to this project") });
    expect(getToolPreflightFailure(denied)).toEqual({ effect: "none", reason: "invalid_model_reference", disposition: "correctable" });
    expect(adoption).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled();
    expect(await projects.modelAssetResources(other.id)).toEqual([]);
    adoption.mockRestore(); materialize.mockRestore();
    const store = new CanvasStore(projects, library, runner);
    await store.workspace(project.id);
    await ensureCanvasAssets(project, projects, library, [asset.id]);
    const archive = await exportProjectArchive(project, { library }),
      chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));
    const target = await directory(),
      importedLibrary = new AssetLibrary(target);
    await importedLibrary.load();
    const importedProjects = new ProjectManager(target, importedLibrary);
    await importedProjects.load();
    const restored = await importProjectArchive(
      importedProjects,
      Buffer.concat(chunks),
    );
    expect(
      (
        await listWorkspaceFiles(restored.workspacePath, { assets: true })
      ).filter((file) => file.mediaType === "model"),
    ).toHaveLength(1);
    expect(
      await importedProjects.modelAssetResources(restored.id, {
        assetId: asset.id,
      }),
    ).toMatchObject({ ready: true });
    const reopened = new ProjectManager(root, library);
    await reopened.load();
    expect(
      await reopened.modelAssetResources(project.id, { assetId: asset.id }),
    ).toMatchObject({ ready: true });
    await writeFile(
      path.join(project.workspacePath, resources.resources[0].path),
      "broken runtime part",
    );
    expect(
      await projects.modelAssetResources(project.id, { assetId: asset.id }),
    ).toMatchObject({ ready: true });
    const content = await library.content(asset.id, true);
    await writeFile(content.absolutePath, "broken preview");
    await expect(
      projects.modelAssetResources(project.id, { assetId: asset.id }),
    ).rejects.toThrow("integrity");
    const repaired = await projects.modelAssetResources(project.id, {
      assetId: asset.id,
      rebuildPreview: true,
    });
    expect(repaired).toMatchObject({ ready: true });
    expect(
      await readFile((await library.content(asset.id)).absolutePath),
    ).toEqual(original);
  });

  it("returns an FBX extension from the Agent generation branch without producing a mislabeled public GLB", async () => {
    const root = await directory(),
      library = new AssetLibrary(root);
    await library.load();
    const projects = new ProjectManager(root, library);
    await projects.load();
    const project = await projects.create("Game", "web-game");
    const runner = new ToolRunner(
      root,
      { generate: vi.fn() },
      {
        generate: async () => ({
          bytes: fbxFixture(),
          mediaType: FBX_MEDIA_TYPE,
        }),
      },
      undefined,
      library,
    );
    await runner.load();
    const generator = createAgentTools(project, runner, projects).find(
      (tool) => tool.name === "generate_3d_asset",
    )!;
    const result = await generator.execute(
      "model",
      { operation: "text", prompt: "goose" },
      undefined,
      undefined,
      {} as never,
    );
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toMatch(/FBX original saved to .*\.fbx/);
    expect(text).not.toMatch(/FBX original saved to [^ ]+\.glb/);
    const bindings = await projects.modelAssetResources(project.id);
    expect(bindings).toEqual([
      expect.objectContaining({
        originalPath: expect.stringMatching(/\.fbx$/),
      }),
    ]);
  });
});

describe("FBX originals and local GLB previews", () => {
  it.each([false, true])(
    "converts a bounded embedded quad FBX (wide=%s) without losing the source",
    async (wide) => {
      const original = fbxFixture({ wide });
      expect(inspectFbx(original)).toEqual({
        centimeters: 100,
        polygons: 1,
        quads: 1,
      });
      const preview = await createFbxPreview(original),
        document = await new NodeIO().readBinary(preview);
      expect(await inspectModel3D(preview)).toMatchObject({
        triangles: 2,
        textured: true,
      });
      expect(document.getRoot().getExtras()).toMatchObject({
        triangulatedPreview: true,
        quadTopologyPreserved: false,
        materialApproximation: true,
      });
      const dangerous = Buffer.from(original),
        offset =
          dangerous.indexOf("PolygonVertexIndex") + "PolygonVertexIndex".length;
      dangerous.writeUInt32LE(2_000_000_000, offset + 1);
      expect(() => inspectFbx(dangerous)).toThrow("limits");
      const cancelled = AbortSignal.abort();
      await expect(createFbxPreview(original, cancelled)).rejects.toThrow();
    },
  );

  it("stores a real FBX and GLB preview through the tool, reopens them, and exports/imports both without generation", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const original = fbxFixture(),
      request = tripoService(original),
      provider = new TripoProvider(() => "fake-fbx-key", request, 0);
    const runner = new ToolRunner(
      location,
      { generate: vi.fn() },
      provider,
      undefined,
      library,
    );
    await runner.load();
    const input = {
      model: { provider: "tripo", id: "v3.1-20260211" },
      images: [image],
      targetPolycount: 30_000,
      options: { quad: true },
    };
    const run = await runner.runPrepared("image-to-3d", input, undefined, {
      recoveryId: "quad-fixture",
    });
    expect(run.files.map((file) => file.name)).toEqual([
      "model-original.fbx",
      "model-preview.glb",
    ]);
    const asset = library.get(run.files[0]!.assetId!)!;
    expect(asset).toMatchObject({
      contentType: FBX_MEDIA_TYPE,
      saved: true,
      model3d: { triangles: 2, preview: { status: "ready" } },
    });
    expect(
      await readFile((await library.content(asset.id)).absolutePath),
    ).toEqual(original);
    expect(
      await inspectModel3D(
        await readFile((await library.content(asset.id, true)).absolutePath),
      ),
    ).toMatchObject({ triangles: 2, textured: true });
    const reopened = new AssetLibrary(location);
    await reopened.load();
    await reopened.rename(asset.id, "Renamed quad");
    await reopened.save(asset.id);
    const projects = new ProjectManager(location, reopened);
    await projects.load();
    const project = await projects.create("Quad assets", "asset-canvas");
    const sourceStore = new CanvasStore(projects, reopened, runner);
    await sourceStore.workspace(project.id);
    const manifest = await ensureCanvasAssets(project, projects, reopened, [
        asset.id,
      ]),
      entry = manifest.assets[asset.id]!;
    expect(
      await readFile(path.join(project.workspacePath, entry.path)),
    ).toEqual(original);
    expect(entry.modelPreviewPath).toMatch(/\.glb$/);
    const stream = await exportProjectArchive(project, { library: reopened }),
      chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const newLocation = await directory(),
      newLibrary = new AssetLibrary(newLocation);
    await newLibrary.load();
    const newProjects = new ProjectManager(newLocation, newLibrary);
    await newProjects.load();
    const restored = await importProjectArchive(
      newProjects,
      Buffer.concat(chunks),
    );
    expect(await checkCanvasWorkspace(restored.workspacePath)).toEqual({
      ok: true,
      issues: [],
    });
    const restoredId = await canvasLibraryAsset(restored, newLibrary, asset.id);
    expect(
      await readFile((await newLibrary.content(restoredId)).absolutePath),
    ).toEqual(original);
    expect(
      await inspectModel3D(
        await readFile(
          (await newLibrary.content(restoredId, true)).absolutePath,
        ),
      ),
    ).toMatchObject({ triangles: 2 });
    const calls = request.mock.calls.length;
    request.mockRejectedValue(new Error("provider is offline"));
    const offline = await runner.runPrepared("image-to-3d", input, undefined, {
      recoveryId: "quad-fixture",
      model3DRecoveryOnly: true,
    });
    expect(offline.files[0]?.mediaType).toBe(FBX_MEDIA_TYPE);
    expect(request.mock.calls).toHaveLength(calls);
    expect(
      posts(request).filter(([url]) => !String(url).endsWith("/files")),
    ).toHaveLength(1);
  });

  it("keeps an original when conversion fails and rebuilds only locally from a retained convertible original", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const unsupported = fbxFixture({ externalTexture: true }),
      request = tripoService(unsupported);
    const runner = new ToolRunner(
      location,
      { generate: vi.fn() },
      new TripoProvider(() => "fake-key", request, 0),
      undefined,
      library,
    );
    await runner.load();
    const run = await runner.runPrepared("image-to-3d", {
      model: { provider: "tripo", id: "v3.1-20260211" },
      images: [image],
      options: { quad: true },
    });
    expect(run.files).toHaveLength(1);
    const id = run.files[0]!.assetId!;
    expect(library.get(id)).toMatchObject({
      model3d: { preview: { status: "unavailable" } },
    });
    expect(await readFile((await library.content(id)).absolutePath)).toEqual(
      unsupported,
    );
    await expect(library.content(id, true)).rejects.toThrow(
      "original is retained",
    );
    const convertible = await library.add("retained.fbx", fbxFixture());
    const calls = request.mock.calls.length;
    await library.rebuildModelPreview(convertible.id);
    expect(request.mock.calls).toHaveLength(calls);
    expect(
      await inspectModel3D(
        await readFile(
          (await library.content(convertible.id, true)).absolutePath,
        ),
      ),
    ).toMatchObject({ triangles: 2 });
    expect(
      await readFile((await library.content(convertible.id)).absolutePath),
    ).toEqual(fbxFixture());
    const cached = new AssetLibrary(location);
    await cached.load();
    expect(cached.get(convertible.id)?.model3d?.preview?.status).toBe("ready");
  });
});

function tripoService(bytes = TEST_GLB, rigType = "biped") {
  let taskNumber = 0,
    uploadNumber = 0;
  const endpoints = new Map<string, string>();
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target === artifact) return new Response(new Uint8Array(bytes));
    if (target.endsWith("/files"))
      return Response.json({
        code: 0,
        data: { file_token: `file-${++uploadNumber}` },
      });
    if (target.endsWith("/account/balance"))
      return Response.json({ code: 0, data: { balance: 80, frozen: 10 } });
    if (init?.method === "POST") {
      const id = `task-${++taskNumber}`;
      endpoints.set(id, target);
      return Response.json({ code: 0, data: { task_id: id } });
    }
    const id = target.split("/").at(-1)!;
    return Response.json({
      code: 0,
      data: {
        status: "success",
        output: endpoints.get(id)?.endsWith("rig-check")
          ? { riggable: true, rig_type: rigType }
          : { model_url: artifact },
      },
    });
  });
}
function kunpoTripoService(bytes = TEST_GLB) {
  const service = tripoService(bytes);
  return vi.fn<typeof fetch>(async (url, init) =>
    /\/v1\/tasks\/[^/]+\/artifacts$/.test(new URL(String(url)).pathname)
      ? Response.json({ artifacts: [{ key: "model", content_url: artifact }] })
      : service(url, init),
  );
}
function hyperService() {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target === artifact) return new Response(new Uint8Array(TEST_GLB));
    if (target.endsWith("rodin") || target.endsWith("rodin_texture_only"))
      return Response.json({
        uuid: "rodin-task",
        jobs: { subscription_key: "private-subscription" },
        error: [],
      });
    if (target.endsWith("status"))
      return Response.json({ jobs: [{ status: "Done" }] });
    if (target.endsWith("check_balance"))
      return Response.json({ balance: 4.5 });
    return Response.json({ list: [{ name: "model.glb", url: artifact }] });
  });
}
const posts = (request: ReturnType<typeof tripoService>) =>
  request.mock.calls.filter(([, init]) => init?.method === "POST");

describe("3D operation contracts", () => {
  it("rejects old Meshy preview/refine relay configurations before a credential or request is used", async () => {
    const request = vi.fn<typeof fetch>(),
      apiKey = vi.fn(),
      location = await directory();
    const provider = new MeshyProvider(apiKey, request, 0, () => true, {
      baseUrl: "http://127.0.0.1:43199/openapi/v1",
      authentication: "none",
      headers: { "x-relay": "retained" },
      settings: MODEL_3D_PRESETS.meshy[0]!.settings,
    });
    await expect(
      provider.generate({
        model: { provider: "relay", id: "meshy-t2" },
        images: [],
        operation: "text",
        prompt: "A knight",
        execution: await model3DJournal(location, "text"),
      }),
    ).rejects.toMatchObject({
      message: MESHY_DISABLED_MESSAGE,
      statusCode: 403,
      notSubmitted: true,
    });
    expect(apiKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(location)).toEqual([]);
  });
  it.each(["image", "text"] as const)(
    "rejects former Meshy T2.5 %s generation instead of validating or submitting it",
    async (operation) => {
      const request = vi.fn<typeof fetch>(),
        provider = new MeshyProvider(
          () => {
            throw new Error("Credentials must remain unread");
          },
          request,
          0,
        );
      await expect(
        provider.generate({
          model: { provider: "meshy", id: "meshy-t2.5" },
          operation,
          images: [],
          targetPolycount: 30_001,
        }),
      ).rejects.toMatchObject({
        message: MESHY_DISABLED_MESSAGE,
        statusCode: 403,
        notSubmitted: true,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("rejects Meshy relay libraries, rigging and balances without reaching the configured endpoint", async () => {
    const request = vi.fn<typeof fetch>(),
      provider = new MeshyProvider(
        () => undefined,
        request,
        0,
        () => true,
        { baseUrl: "not-even-a-url", authentication: "none" },
      );
    for (const result of [
      provider.animations(),
      provider.animate({ model: TEST_GLB, actionIds: [0] }),
      provider.accountBalance(),
    ])
      await expect(result).rejects.toMatchObject({
        message: MESHY_DISABLED_MESSAGE,
        statusCode: 403,
      });
    expect(request).not.toHaveBeenCalled();
  });
  it("generates Tripo text without uploading images and uses a separate texture model version", async () => {
    const request = tripoService(),
      provider = new TripoProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      );
    await provider.generate({
      model: tripoModel,
      operation: "text",
      prompt: "A stone tower",
      images: [],
    });
    expect(posts(request)[0]![0]).toBe(
      "http://127.0.0.1:43199/v3/generation/text-to-model",
    );
    request.mockClear();
    await provider.generate({
      model: tripoModel,
      operation: "retexture",
      source: TEST_GLB,
      prompt: "Mossy stone",
      images: [],
      options: { textureModel: "v3.5-20260815", textureQuality: "fast" },
    });
    const body = JSON.parse(
      String(
        request.mock.calls.find(([url]) =>
          String(url).endsWith("/models/texture"),
        )![1]!.body,
      ),
    );
    expect(body).toMatchObject({
      model: "v3.5-20260815",
      input: expect.stringMatching(/^file-/),
      texture_prompt: { text: "Mossy stone" },
      texture_quality: "fast",
    });
  });
  it("bakes multiple Tripo clips after rig-check and refuses Meshy IDs before uploading", async () => {
    const bytes = await model3DFixture({
        rigged: true,
        clips: ["Idle", "Walk"],
      }),
      request = tripoService(bytes);
    const provider = new TripoProvider(
      () => "workflow-fake-credential-20261028",
      request,
      0,
    );
    await expect(
      provider.animate({ model: TEST_GLB, actionIds: [0] }),
    ).rejects.toThrow("selected Tripo rig");
    expect(request).not.toHaveBeenCalled();
    const result = await provider.animate({
      model: TEST_GLB,
      actionIds: ["preset:idle", "preset:walk"],
      options: { animateInPlace: true },
    });
    expect((await inspectModel3D(result.bytes)).animations).toEqual([
      "Idle",
      "Walk",
    ]);
    const retarget = JSON.parse(
      String(
        request.mock.calls.find(([url]) =>
          String(url).endsWith("/animations/retarget"),
        )![1]!.body,
      ),
    );
    expect(retarget).toMatchObject({
      model: "v3.0-20260909",
      out_format: "glb",
      export_with_geometry: true,
      animate_in_place: true,
    });
    expect(posts(request).map(([url]) => String(url).split("/v3/")[1])).toEqual(
      [
        "files",
        "animations/rig-check",
        "animations/rig",
        "animations/retarget",
      ],
    );
  });
  it.each(["v2.5-20260210", "v3.0-20260909"] as const)(
    "uses %s creature presets and stops when rig-check finds another rig type",
    async (rigModel) => {
      const request = tripoService(TEST_GLB, "quadruped"),
        provider = new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        );
      const options = { rigModel, rigType: "quadruped" as const };
      if (rigModel === "v3.0-20260909") {
        await expect(
          provider.animations(undefined, undefined, options),
        ).rejects.toThrow("use v2.5 for non-human rigs");
        await expect(
          provider.animate({
            model: TEST_GLB,
            actionIds: ["preset:quadruped:walk"],
            options,
          }),
        ).rejects.toThrow("use v2.5 for non-human rigs");
        expect(request).not.toHaveBeenCalled();
        return;
      }
      expect(
        await provider.animations(undefined, undefined, options),
      ).toMatchObject([{ id: "preset:quadruped:walk" }]);
      await provider.animate({
        model: TEST_GLB,
        actionIds: ["preset:quadruped:walk"],
        options,
      });
      request.mockClear();
      await expect(
        provider.animate({ model: TEST_GLB, actionIds: ["preset:idle"] }),
      ).rejects.toThrow("quadruped");
      expect(
        request.mock.calls.some(([url]) =>
          String(url).endsWith("/animations/rig"),
        ),
      ).toBe(false);
    },
  );
  it("runs Tripo v3 humanoid presets through the tool and rejects legacy action IDs before upload", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const bytes = await model3DFixture({
      rigged: true,
      clips: ["Idle", "Walk"],
    });
    const source = await library.add("hero.glb", TEST_GLB),
      request = tripoService(bytes);
    const provider = new TripoProvider(
      () => "workflow-fake-credential-20261028",
      request,
      0,
    );
    const providers = new ProviderModels3D({
      runtime: async () => {
        throw new Error("Native animation needs no custom runtime");
      },
      meshy: {
        generator: new MeshyProvider(() => undefined),
        configured: () => false,
      },
      tripo: { generator: provider, configured: () => true },
      customProviders: async () => [],
      nativeModels: (id) => [...MODEL_3D_PRESETS[id]],
      isEnabled: () => true,
      isVisible: () => true,
      defaultModel: () => undefined,
    });
    const runner = new ToolRunner(
      location,
      { generate: vi.fn() },
      providers,
      undefined,
      library,
    );
    await runner.load();
    const options = {
      rigModel: "v3.0-20260909" as const,
      rigType: "biped" as const,
    };
    try {
      expect(
        await provider.animations(undefined, undefined, options),
      ).toContainEqual(expect.objectContaining({ id: "preset:walk" }));
      const actionIds = ["preset:idle", "preset:walk"];
      const run = await runner.run("animate-3d", {
        assetId: source.id,
        model: tripoModel,
        actionIds,
        options,
      });
      const output = library.get(run.files[0]!.assetId!)!;
      expect(output.model3d?.generation).toEqual(output.generation);
      expect(output.generation).toEqual(run.generation);
      expect(output.model3d?.animations).toEqual(["Idle", "Walk"]);
      expect(output.generation?.parameters).not.toHaveProperty("animations");
      expect(
        await readFile((await library.content(output.id)).absolutePath),
      ).toEqual(bytes);
      const projects = new ProjectManager(location, library);
      await projects.load();
      const project = await projects.create(
          "Animation provenance",
          "asset-canvas",
        ),
        store = new CanvasStore(projects, library, runner);
      try {
        const boardId = (await store.workspace(project.id)).boards[0]!.id;
        const board = await store.board(project.id, boardId);
        board.board.nodes.push({
          id: "animation",
          type: "animate-3d",
          position: { x: 10, y: 20 },
          data: {
            source: { type: "library", assetId: source.id },
            assetId: output.id,
            model: tripoModel,
            options,
            heightMeters: 1.7,
            actionIds,
          },
        });
        board.board.editorLayout.nodes.animation = { x: 10, y: 20 };
        const saved = await store.saveBoard(
          project.id,
          board.board,
          board.revision,
        );
        expect(
          (await store.workspace(project.id)).assets.find(
            (asset) => asset.id === output.id,
          )?.model3d?.generation,
        ).toEqual(output.generation);
        saved.board.nodes[0]!.position.x = 30;
        saved.board.editorLayout.nodes.animation!.x = 30;
        const resaved = await store.saveBoard(
          project.id,
          saved.board,
          saved.revision,
        );
        expect(resaved.board.nodes[0]).toMatchObject({
          position: { x: 30, y: 20 },
          data: { assetId: output.id, actionIds },
        });
        expect(
          (await readCanvasAssets(project.workspacePath)).assets[output.id]
            ?.model3d?.animations,
        ).toEqual(["Idle", "Walk"]);
        expect(
          await readFile((await library.content(source.id)).absolutePath),
        ).toEqual(TEST_GLB);
      } finally {
        await store.close();
      }
      const rig = request.mock.calls.find(([url]) =>
        String(url).endsWith("/animations/rig"),
      )!;
      expect(JSON.parse(String(rig[1]!.body))).toMatchObject({
        model: options.rigModel,
        rig_type: "biped",
        spec: "tripo",
        out_format: "glb",
      });
      const retarget = request.mock.calls.find(([url]) =>
        String(url).endsWith("/animations/retarget"),
      )!;
      expect(JSON.parse(String(retarget[1]!.body))).toMatchObject({
        animations: ["preset:idle", "preset:walk"],
      });
      request.mockClear();
      await expect(
        provider.animate({
          model: TEST_GLB,
          actionIds: ["preset:biped:walk"],
          options,
        }),
      ).rejects.toThrow("selected Tripo rig");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await runner.close();
    }
  });
  it("sends the required singular Hyper3D image/model fields and text prompts without images", async () => {
    const request = hyperService(),
      provider = new Hyper3DProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      ),
      model = { provider: "hyper3d", id: MODEL_3D_PRESETS.hyper3d[0]!.id };
    await provider.generate({
      model,
      operation: "retexture",
      images: [image],
      source: TEST_GLB,
      prompt: "Gold",
      pbr: true,
    });
    const form = posts(request)[0]![1]!.body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("model")).toBeInstanceOf(Blob);
    expect(form.get("material")).toBe("PBR");
    expect(form.get("prompt")).toBe("Gold");
    expect(
      form.has("images") || form.has("tier") || form.has("quality_override"),
    ).toBe(false);
    request.mockClear();
    await provider.generate({
      model,
      operation: "text",
      images: [],
      prompt: "A tree",
    });
    expect((posts(request)[0]![1]!.body as FormData).get("prompt")).toBe(
      "A tree",
    );
    request.mockClear();
    await expect(
      provider.generate({
        model,
        operation: "retexture",
        images: [],
        source: TEST_GLB,
        prompt: "Gold",
      }),
    ).rejects.toThrow("one reference image");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses remesh operation versions and triangle GLB output constraints", async () => {
    const tripo = tripoService();
    await new TripoProvider(
      () => "workflow-fake-credential-20261028",
      tripo,
      0,
    ).generate({
      model: tripoModel,
      operation: "remesh",
      source: TEST_GLB,
      images: [],
      targetPolycount: 20_000,
    });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({
      model: "v3.0",
      face_limit: 20_000,
      quad: false,
      bake: true,
    });
    await new TripoProvider(
      () => "workflow-fake-credential-20261028",
      tripo,
      0,
    ).generate({
      model: tripoModel,
      operation: "remesh",
      source: TEST_GLB,
      images: [],
    });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({
      face_limit: 4_000,
    });
    await new TripoProvider(
      () => "workflow-fake-credential-20261028",
      tripo,
      0,
    ).generate({
      model: tripoModel,
      operation: "remesh",
      source: TEST_GLB,
      images: [],
      targetPolycount: 500,
    });
    expect(JSON.parse(String(posts(tripo).at(-1)![1]!.body))).toMatchObject({
      face_limit: 500,
    });
    tripo.mockClear();
    for (const targetPolycount of [499, 20_001, 30_000]) {
      await expect(
        new TripoProvider(
          () => "workflow-fake-credential-20261028",
          tripo,
          0,
        ).generate({
          model: tripoModel,
          operation: "remesh",
          source: TEST_GLB,
          images: [],
          targetPolycount,
        }),
      ).rejects.toThrow("500 and 20000");
    }
    expect(tripo).not.toHaveBeenCalled();
  });
  it("queries implemented own-key balances while refusing Meshy", async () => {
    const meshy = vi.fn<typeof fetch>();
    await expect(
      new MeshyProvider(() => undefined, meshy, 0).accountBalance(),
    ).rejects.toMatchObject({
      message: MESHY_DISABLED_MESSAGE,
      statusCode: 403,
    });
    expect(meshy).not.toHaveBeenCalled();
    expect(
      await new TripoProvider(
        () => "workflow-fake-credential-20261028",
        tripoService(),
        0,
      ).accountBalance(),
    ).toEqual({ balance: 80, frozen: 10 });
    expect(
      await new Hyper3DProvider(
        () => "workflow-fake-credential-20261028",
        hyperService(),
        0,
      ).accountBalance(),
    ).toEqual({ balance: 4.5 });
  });
});

describe("durable 3D tasks and asset preflight", () => {
  it.each(["missing", "empty", "corrupt", "linked"])(
    "refuses %s recovery records before any provider request",
    async (state) => {
      const location = await directory(),
        file = path.join(location, "existing.json");
      if (state === "empty" || state === "corrupt")
        await writeFile(file, state === "empty" ? "{}" : "not JSON", {
          mode: 0o600,
        });
      if (state === "linked") {
        const target = path.join(location, "private.json");
        await writeFile(target, "{}", { mode: 0o600 });
        await symlink(target, file);
      }
      const request = tripoService(),
        provider = new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        );
      await expect(
        (async () =>
          provider.generate({
            model: tripoModel,
            images: [image],
            execution: await model3DJournal(location, "existing", true),
          }))(),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("keeps an uncertain or unreadable 3D task blocked, including a secondary stage", async () => {
    const location = await directory();
    expect(await hasAttempted3DTask(location, "rig")).toBe(false);
    const journal = await model3DJournal(location, "rig");
    await expect(
      journal.submitted("rig", "scope", {}, async () => {
        throw new Error("connection lost");
      }),
    ).rejects.toThrow();
    expect(await hasAttempted3DTask(location, "rig")).toBe(true);
    expect(await hasSaved3DTask(location, "rig")).toBe(false);
    const stages = await model3DJournal(location, "stages");
    await stages.submitted("source-upload", "scope", {}, async () => ({
      token: "upload",
    }));
    expect(await hasSaved3DTask(location, "stages")).toBe(false);
    await stages.submitted("rig-check", "scope", {}, async () => ({
      taskId: "known",
    }));
    expect(await hasSaved3DTask(location, "stages")).toBe(true);
    await writeFile(path.join(location, "rig.json"), "{");
    expect(await hasAttempted3DTask(location, "rig")).toBe(true);
  });

  it("does not create a recovery directory or task when its original journal is missing", async () => {
    const location = path.join(await directory(), "missing"),
      create = vi.fn();
    const recovery = await model3DJournal(location, "lost", true);
    await expect(
      recovery.submitted("generate", "scope", {}, create),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
    await expect(stat(location)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a simultaneous duplicate journal from creating later stages", async () => {
    const location = await directory(),
      first = await model3DJournal(location, "parallel"),
      duplicate = await model3DJournal(location, "parallel");
    const upload = vi.fn().mockResolvedValue({ token: "fake-upload" }),
      generate = vi.fn().mockResolvedValue({ taskId: "fake-task" });
    await first.submitted("upload", "scope", {}, upload);
    await duplicate.submitted("upload", "scope", {}, upload);
    await expect(
      duplicate.submitted("generate", "scope", {}, generate),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(duplicate.recoveryOnly).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    await first.submitted("generate", "scope", {}, generate);
    expect(upload).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(["scope", "input"])(
    "rejects changed %s without modifying the saved stages",
    async (changed) => {
      const location = await directory(),
        original = await model3DJournal(location, "changed"),
        create = vi.fn().mockResolvedValue({ taskId: "fake-task" });
      await original.submitted(
        "generate",
        "original",
        { prompt: "Tower" },
        create,
      );
      const before = await readFile(
        path.join(location, "changed.json"),
        "utf8",
      );
      const recovery = await model3DJournal(location, "changed", true);
      await expect(
        recovery.submitted(
          "generate",
          changed === "scope" ? "different" : "original",
          { prompt: changed === "input" ? "Castle" : "Tower" },
          create,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(create).toHaveBeenCalledOnce();
      expect(await readFile(path.join(location, "changed.json"), "utf8")).toBe(
        before,
      );
    },
  );

  it.each(["rig-check", "rig", "animation"])(
    "cancels and resumes Tripo at %s without submitting an unrecorded next stage",
    async (stage) => {
      const location = await directory(),
        request = tripoService(),
        respond = request.getMockImplementation()!;
      const controller = new AbortController();
      let polling = false,
        blockedId: string | undefined,
        pause = true;
      const endpoint = stage === "animation" ? "retarget" : stage;
      request.mockImplementation(async (url, init) => {
        const target = String(url);
        const response = await respond(url, init);
        if (
          init?.method === "POST" &&
          target.endsWith(`/animations/${endpoint}`)
        )
          blockedId = (await response.clone().json()).data.task_id;
        if (pause && blockedId && target.endsWith(`/tasks/${blockedId}`)) {
          polling = true;
          return new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(init.signal.reason);
            else
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
          });
        }
        return response;
      });
      const provider = new TripoProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      );
      const input = { model: TEST_GLB, actionIds: ["preset:idle"] };
      const running = provider.animate(
        { ...input, execution: await model3DJournal(location, stage) },
        controller.signal,
      );
      const stopped = expect(running).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.waitFor(() => expect(polling).toBe(true));
      controller.abort();
      await stopped;
      const before = await readFile(
          path.join(location, `${stage}.json`),
          "utf8",
        ),
        paidPosts = posts(request).length;
      pause = false;
      const resumed = provider.animate({
        ...input,
        execution: await model3DJournal(location, stage, true),
      });
      if (stage === "animation")
        expect((await resumed).bytes).toEqual(TEST_GLB);
      else await expect(resumed).rejects.toThrow("unrecorded stage");
      expect(posts(request)).toHaveLength(paidPosts);
      expect(await readFile(path.join(location, `${stage}.json`), "utf8")).toBe(
        before,
      );
    },
  );

  it("retries standalone 3D jobs without paying when the original journal disappeared", async () => {
    const location = await directory(),
      request = tripoService(),
      respond = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (url, init) =>
      String(url) === artifact && fail
        ? new Response("offline", { status: 503 })
        : respond(url, init),
    );
    const runner = new ToolRunner(
      location,
      { generate: vi.fn() },
      new TripoProvider(() => "workflow-fake-credential-20261028", request, 0),
    );
    try {
      await runner.load();
      const original = runner.start("image-to-3d", {
        model: tripoModel,
        images: [image],
      });
      await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
      const journals = path.join(location, "tools", "model3d-tasks"),
        file = path.join(journals, (await readdir(journals))[0]!);
      await rename(file, `${file}.held`);
      fail = false;
      const recovery = await runner.retryJob(original.id);
      expect(recovery.model3DRecoveryOnly).toBe(true);
      await vi.waitFor(() =>
        expect(runner.jobs()[0]).toMatchObject({
          status: "failed",
          error: expect.stringContaining("unrecorded stage"),
        }),
      );
      await expect(runner.retryJob(original.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await runner.retryJob(recovery.id);
      await vi.waitFor(() =>
        expect(runner.jobs()[0]).toMatchObject({
          status: "failed",
          model3DRecoveryOnly: true,
        }),
      );
      expect(posts(request)).toHaveLength(2);
      // A distinct Generate action is explicit new work, rather than recovery.
      runner.start("image-to-3d", { model: tripoModel, images: [image] });
      await vi.waitFor(() =>
        expect(runner.jobs()[0]?.status).toBe("succeeded"),
      );
      expect(posts(request)).toHaveLength(4);
      expect(await readFile(`${file}.held`, "utf8")).toContain("fingerprint");
    } finally {
      await runner.close();
    }
  });
  it.each(["tripo", "hyper3d"] as const)(
    "resumes %s downloads after recreating the journal without new paid submissions",
    async (protocol) => {
      const location = await directory();
      const request = protocol === "tripo" ? tripoService() : hyperService();
      const original = request.getMockImplementation()!;
      let failed = false;
      request.mockImplementation(async (url, init) => {
        if (String(url) === artifact && !failed) {
          failed = true;
          return new Response("offline", { status: 503 });
        }
        return original(url, init);
      });
      const provider =
        protocol === "tripo"
          ? new TripoProvider(
              () => "workflow-fake-credential-20261028",
              request,
              0,
            )
          : new Hyper3DProvider(
              () => "workflow-fake-credential-20261028",
              request,
              0,
            );
      const model = {
          provider: protocol,
          id: MODEL_3D_PRESETS[protocol][0]!.id,
        },
        input = { model, images: [image] };
      await expect(
        provider.generate({
          ...input,
          execution: await model3DJournal(location, "recovery"),
        }),
      ).rejects.toThrow("download failed");
      const before = posts(request).filter(
        ([url]) =>
          !String(url).endsWith("/status") &&
          !String(url).endsWith("/download"),
      ).length;
      const result = await provider.generate({
        ...input,
        execution: await model3DJournal(location, "recovery"),
      });
      expect(result.bytes).toEqual(TEST_GLB);
      expect(
        posts(request).filter(
          ([url]) =>
            !String(url).endsWith("/status") &&
            !String(url).endsWith("/download"),
        ),
      ).toHaveLength(before);
      const content = await readFile(
        path.join(location, "recovery.json"),
        "utf8",
      );
      expect(content).not.toContain('"key"');
      if (process.platform !== "win32")
        expect(
          (await stat(path.join(location, "recovery.json"))).mode & 0o777,
        ).toBe(0o600);
    },
  );
  it("blocks an ambiguous Tripo submission and a changed connection instead of paying again", async () => {
    const location = await directory(),
      request = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("lost POST response"));
    const input = {
      model: tripoModel,
      operation: "text" as const,
      prompt: "Tower",
      images: [],
    };
    await expect(
      new TripoProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      ).generate({
        ...input,
        execution: await model3DJournal(location, "ambiguous"),
      }),
    ).rejects.toThrow("Could not reach");
    await expect(
      new TripoProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      ).generate({
        ...input,
        execution: await model3DJournal(location, "ambiguous"),
      }),
    ).rejects.toThrow("could not be confirmed");
    await expect(
      new TripoProvider(
        () => "workflow-changed-credential-20261028",
        request,
        0,
      ).generate({
        ...input,
        execution: await model3DJournal(location, "ambiguous"),
      }),
    ).rejects.toThrow("connection or input changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps submitted Tripo rig stages across a failed download", async () => {
    const location = await directory(),
      bytes = await model3DFixture({ rigged: true, clips: ["Idle"] });
    const request = tripoService(),
      original = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (url, init) =>
      String(url) === artifact
        ? fail
          ? new Response("offline", { status: 503 })
          : new Response(new Uint8Array(bytes))
        : original(url, init),
    );
    const input = { model: TEST_GLB, actionIds: ["preset:idle"] };
    await expect(
      new TripoProvider(
        () => "workflow-fake-credential-20261028",
        request,
        0,
      ).animate({
        ...input,
        execution: await model3DJournal(location, "animation"),
      }),
    ).rejects.toThrow("download failed");
    fail = false;
    expect(
      (
        await new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        ).animate({
          ...input,
          execution: await model3DJournal(location, "animation"),
        })
      ).bytes,
    ).toEqual(bytes);
    expect(posts(request)).toHaveLength(4);
  });
  it("reuses retained Tripo bytes after local parser rejection without polling an expired task", async () => {
    const location = await directory(),
      invalid = Buffer.from(TEST_GLB);
    invalid.fill(32, 20, 28);
    const request = tripoService(invalid),
      input = {
        model: tripoModel,
        operation: "text" as const,
        prompt: "Tower",
        images: [],
      };
    const provider = new TripoProvider(
      () => "workflow-fake-credential-20261028",
      request,
      0,
    );
    const result = await provider.generate({
      ...input,
      execution: await model3DJournal(location, "retained"),
    });
    await expect(inspectModel3D(result.bytes)).rejects.toThrow();
    const calls = request.mock.calls.length;
    request.mockImplementation(async () => {
      throw new Error("All former endpoints expired");
    });
    expect(
      (
        await provider.generate({
          ...input,
          execution: await model3DJournal(location, "retained", true),
        })
      ).bytes,
    ).toEqual(invalid);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(posts(request)).toHaveLength(1);
  });
  it("retains historical Meshy batch files but refuses remote or cached adapter recovery", async () => {
    const location = await directory(),
      journal = await model3DJournal(location, "historical");
    await journal.submitted("rig", "old-meshy-scope", {}, async () => ({
      taskId: "old-rig",
    }));
    await journal.submitted("animation-0", "old-meshy-scope", {}, async () => ({
      taskId: "old-animation",
    }));
    await journal.result!(
      "animation-result-a",
      "old-animation",
      async () => TEST_GLB,
    );
    const originals = new Map(
      await Promise.all(
        (await readdir(location)).map(
          async (name) =>
            [name, await readFile(path.join(location, name))] as const,
        ),
      ),
    );
    const request = vi.fn<typeof fetch>(),
      apiKey = vi.fn(),
      provider = new MeshyProvider(apiKey, request, 0);
    await expect(
      provider.animate({
        model: TEST_GLB,
        actionIds: [0, 1],
        execution: await model3DJournal(location, "historical", true),
      }),
    ).rejects.toMatchObject({
      message: MESHY_DISABLED_MESSAGE,
      notSubmitted: true,
    });
    expect(request).not.toHaveBeenCalled();
    expect(apiKey).not.toHaveBeenCalled();
    expect((await readdir(location)).sort()).toEqual(
      [...originals.keys()].sort(),
    );
    for (const [name, bytes] of originals)
      expect(await readFile(path.join(location, name))).toEqual(bytes);
  });
  it("reopens an explicit Tripo animation workflow after a failed download without duplicate submissions", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const bytes = await model3DFixture({
        rigged: true,
        clips: ["Idle", "Walk"],
      }),
      request = tripoService(bytes),
      respond = request.getMockImplementation()!;
    let failed = false;
    request.mockImplementation(async (url, init) => {
      if (String(url) === artifact && !failed) {
        failed = true;
        return new Response("offline", { status: 503 });
      }
      return respond(url, init);
    });
    const makeRunner = () =>
        new ToolRunner(
          location,
          { generate: vi.fn() },
          new TripoProvider(
            () => "workflow-fake-credential-20261028",
            request,
            0,
          ),
          undefined,
          library,
        ),
      runner = makeRunner();
    await runner.load();
    const first = runner.start("animate-3d", {
      assetId: source.id,
      model: tripoModel,
      actionIds: ["preset:idle", "preset:walk"],
    });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    await runner.close();
    const submitted = posts(request).length;
    const restarted = makeRunner();
    await restarted.load();
    try {
      await restarted.retryJob(first.id);
      await vi.waitFor(() =>
        expect(restarted.jobs()[0]?.status).toBe("succeeded"),
      );
    } finally {
      await restarted.close();
    }
    expect(posts(request)).toHaveLength(submitted);
    expect(submitted).toBe(4);
    expect(
      library.list().find((asset) => asset.id !== source.id)?.model3d
        ?.animations,
    ).toEqual(["Idle", "Walk"]);
  });
  it("preserves geometry, skin and clip channels when rotating the source +X axis to local +Z", async () => {
    const source = await model3DFixture({ rigged: true, clips: ["Walk"] });
    const bytes = await modelFacingPositiveZ(source, "+X"),
      document = await new NodeIO().readBinary(bytes);
    expect(await inspectModel3D(bytes)).toMatchObject({
      triangles: 1,
      textured: true,
      rigged: true,
      animations: ["Walk"],
    });
    const direction = document
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === "Forward axis +Z")!
      .getRotation();
    expect(direction[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(
      document
        .getRoot()
        .listAnimations()[0]!
        .listChannels()[0]!
        .getTargetNode()
        ?.getName(),
    ).toBe("Root");
    await expect(inspectModel3D(Buffer.from("not a model"))).rejects.toThrow(
      "Invalid GLB",
    );
  });
  it("preserves shared root membership in every scene during axis normalization", async () => {
    const io = new NodeIO(),
      document = await io.readBinary(
        await model3DFixture({ rigged: true, clips: ["Walk"] }),
      );
    const [character, joint] = document
      .getRoot()
      .listScenes()[0]!
      .listChildren();
    document
      .createScene("Shared character")
      .addChild(character!)
      .addChild(joint!);
    document.createScene("Character only").addChild(character!);
    const result = await io.readBinary(
      await modelFacingPositiveZ(
        Buffer.from(await io.writeBinary(document)),
        "+X",
      ),
    );
    const scenes = result.getRoot().listScenes();
    expect(
      scenes.map((scene) =>
        scene
          .listChildren()
          .map((parent) => parent.listChildren()[0]!.getName()),
      ),
    ).toEqual([["Character", "Root"], ["Character", "Root"], ["Character"]]);
    expect(scenes[0]!.listChildren()[0]).toBe(scenes[1]!.listChildren()[0]);
    expect(scenes[0]!.listChildren()[0]).toBe(scenes[2]!.listChildren()[0]);
    expect(
      result.getRoot().listAnimations()[0]!.listChannels()[0]!.getTargetNode(),
    ).toBe(scenes[1]!.listChildren()[1]!.listChildren()[0]);
  });
  it("rejects retired Meshy animation and preserves the untextured source metadata", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const source = await library.add(
      "model.glb",
      await model3DFixture({ textured: false }),
    );
    const original = structuredClone(library.get(source.id));
    const animate = vi.fn(),
      runner = new ToolRunner(
        location,
        { generate: vi.fn() },
        { generate: vi.fn(), animate },
        undefined,
        library,
      );
    await runner.load();
    await expect(
      runner.run("animate-3d", { assetId: source.id, actionIds: [0], model: { provider: "meshy", id: "meshy-7.1" } }),
    ).rejects.toThrow(MESHY_DISABLED_MESSAGE);
    expect(animate).not.toHaveBeenCalled();
    expect(library.get(source.id)).toEqual(original);
  });
  it("reloads standalone Kunpo Tripo history and resumes the paid task on retry", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const request = kunpoTripoService(),
      original = request.getMockImplementation()!;
    let failing = true;
    request.mockImplementation(async (url, init) =>
      String(url).endsWith("/tasks/task-1") && failing
        ? Promise.reject(new Error("offline"))
        : original(url, init),
    );
    const makeRunner = () =>
      new ToolRunner(
        location,
        { generate: vi.fn() },
        new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
          () => true,
          {
            baseUrl: "http://127.0.0.1:43199/tripo/v3",
            apiKey: "synthetic-unused",
          },
        ),
        undefined,
        library,
      );
    const runner = makeRunner();
    await runner.load();
    const job = runner.start("image-to-3d", {
      model: tripoModel,
      images: [image],
    });
    await vi.waitFor(() => expect(runner.jobs()[0]?.status).toBe("failed"));
    await runner.close();
    const restarted = makeRunner();
    await restarted.load();
    failing = false;
    await restarted.retryJob(job.id);
    await vi.waitFor(() =>
      expect(restarted.jobs()[0]?.status).toBe("succeeded"),
    );
    expect(posts(request)).toHaveLength(2);
    expect(
      request.mock.calls.some(([url]) =>
        /\/v1\/tasks\/task-1\/artifacts$/.test(String(url)),
      ),
    ).toBe(true);
    expect(restarted.jobs()[0]).not.toHaveProperty("recoveryId");
    expect(library.list()[0]).toMatchObject({
      model3d: {
        triangles: 1,
        textured: true,
        forwardAxis: "+X",
        provider: "tripo",
        operation: "image",
      },
    });
    await restarted.close();
  });
});

describe("3D jobs and persistence failures", () => {
  it("refuses new and repeated Meshy tool jobs without changing an existing source asset", async () => {
    const location = await directory(),
      library = new AssetLibrary(location);
    await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const request = vi.fn<typeof fetch>(),
      apiKey = vi.fn(),
      runner = new ToolRunner(
        location,
        { generate: vi.fn() },
        new MeshyProvider(apiKey, request, 0),
        undefined,
        library,
      );
    await runner.load();
    try {
      for (const actionIds of [[0], [30]])
        await expect(
          runner.run("animate-3d", {
            assetId: source.id,
            model: meshyModel,
            actionIds,
          }),
        ).rejects.toThrow(MESHY_DISABLED_MESSAGE);
      expect(request).not.toHaveBeenCalled();
      expect(apiKey).not.toHaveBeenCalled();
      expect(
        await readFile((await library.content(source.id)).absolutePath),
      ).toEqual(TEST_GLB);
      expect(library.list()).toHaveLength(1);
    } finally {
      await runner.close();
    }
  });
  it("reports history write failures without submitting generation and can retry after storage recovers", async () => {
    const location = await directory(),
      generate = vi
        .fn()
        .mockResolvedValue({
          bytes: Buffer.from("image"),
          mediaType: "image/png",
        });
    const runner = new ToolRunner(location, { generate });
    await runner.load();
    const file = path.join(location, "tools", "jobs.json");
    await mkdir(file);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = runner.start("generate-image", { prompt: "Icon" });
      await vi.waitFor(() => {
        expect(runner.jobs()[0]?.status).toBe("failed");
        expect(report).toHaveBeenCalled();
      });
      expect(generate).not.toHaveBeenCalled();
      expect(
        (await readdir(path.dirname(file))).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
      await rm(file, { recursive: true });
      await runner.retryJob(job.id);
      await vi.waitFor(() =>
        expect(runner.jobs()[0]?.status).toBe("succeeded"),
      );
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      await runner.close();
      report.mockRestore();
    }
  });
  it("handles cancellation and shutdown when generation history becomes unwritable", async () => {
    const location = await directory();
    const generate = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const runner = new ToolRunner(location, { generate });
    await runner.load();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const job = runner.start("generate-image", { prompt: "Icon" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalled());
      const file = path.join(location, "tools", "jobs.json");
      await rm(file);
      await mkdir(file);
      expect(runner.cancelJob(job.id).status).toBe("cancelled");
      await vi.waitFor(() => expect(report).toHaveBeenCalled());
      await expect(runner.close()).resolves.toBeUndefined();
    } finally {
      await runner.close();
      report.mockRestore();
    }
  });
});

describe("operation capability discovery", () => {
  it.each(["tripo", "hyper3d"] as const)(
    "processes GLBs through the %s connection independently of geometry versions and face counts",
    async (provider) => {
      const location = await directory(),
        library = new AssetLibrary(location);
      await library.load();
      const source = await library.add("source.glb", TEST_GLB);
      const request = provider === "tripo" ? tripoService() : hyperService();
      const models = new ProviderModels3D({
        runtime: async () => {
          throw new Error("Native processing needs no custom runtime");
        },
        meshy: {
          generator: new MeshyProvider(
            () => "workflow-fake-credential-20261028",
            request,
            0,
          ),
          configured: () => false,
        },
        tripo: {
          generator: new TripoProvider(
            () => "workflow-fake-credential-20261028",
            request,
            0,
          ),
          configured: () => provider === "tripo",
        },
        hyper3d: {
          generator: new Hyper3DProvider(
            () => "workflow-fake-credential-20261028",
            request,
            0,
          ),
          configured: () => provider === "hyper3d",
        },
        customProviders: async () => [],
        nativeModels: (id) => [...MODEL_3D_PRESETS[id]],
        isEnabled: () => true,
        isVisible: () => false,
        defaultModel: () => undefined,
      });
      const runner = new ToolRunner(
        location,
        { generate: vi.fn() },
        models,
        undefined,
        library,
      );
      await runner.load();
      for (const id of [
        MODEL3D_CONNECTION_ID,
        MODEL_3D_PRESETS[provider].at(-1)!.id,
      ]) {
        const run = await runner.run("image-to-3d", {
          model: { provider, id },
          operation: "retexture",
          sourceAssetId: source.id,
          images: provider === "hyper3d" ? [image] : [],
          ...(provider === "hyper3d" ? {} : { prompt: "Stone" }),
          targetPolycount: 1_200_000,
        });
        expect(library.get(run.files[0]!.assetId!)?.model3d).toMatchObject({
          provider,
          operation: "retexture",
        });
      }
      await runner.close();
    },
  );
  it("keeps animation available with hidden generation models and requires custom opt-in", async () => {
    const location = await directory(),
      runtime = await ModelRuntime.create({
        authPath: path.join(location, "auth.json"),
        modelsPath: path.join(location, "models.json"),
        modelsStorePath: path.join(location, "catalog.json"),
        allowModelNetwork: false,
      });
    const request = vi.fn<typeof fetch>();
    const providers = new ProviderModels3D({
      runtime: async () => runtime,
      meshy: {
        generator: new MeshyProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        ),
        configured: () => true,
      },
      tripo: {
        generator: new TripoProvider(
          () => "workflow-fake-credential-20261028",
          tripoService(),
          0,
        ),
        configured: () => true,
      },
      hyper3d: {
        generator: new Hyper3DProvider(
          () => "workflow-fake-credential-20261028",
          hyperService(),
          0,
        ),
        configured: () => true,
      },
      customProviders: async () => [],
      nativeModels: (provider) => [...MODEL_3D_PRESETS[provider]],
      isEnabled: () => true,
      isVisible: () => false,
      defaultModel: () => undefined,
    });
    expect((await providers.catalog()).models).toHaveLength(0);
    const connections = await providers.operationModels();
    expect(connections.map(({ provider, id }) => ({ provider, id }))).toEqual([
      { provider: "tripo", id: MODEL3D_CONNECTION_ID },
      { provider: "hyper3d", id: MODEL3D_CONNECTION_ID },
    ]);
    for (const provider of ["tripo", "hyper3d"] as const) {
      for (const definition of MODEL_3D_PRESETS[provider]) {
        const ref = { provider, id: definition.id };
        expect(resolveModel3DConnection(ref, connections)).toMatchObject({
          provider,
          id: MODEL3D_CONNECTION_ID,
        });
        expect(
          await providers.resolveOperationModel(ref, "retexture"),
        ).toMatchObject({ provider, id: MODEL3D_CONNECTION_ID });
      }
    }
    expect(
      await providers.resolveOperationModel(
        { provider: "meshy", id: MODEL3D_CONNECTION_ID },
        "image",
      ),
    ).toBeUndefined();
    await expect(providers.animations(undefined, meshyModel)).rejects.toThrow(
      MESHY_DISABLED_MESSAGE,
    );
    expect((await providers.animations(undefined, tripoModel))[0]!.id).toMatch(
      /^preset:/,
    );
    expect(
      await providers.resolveOperationModel(tripoModel, "animate"),
    ).toBeDefined();
    expect(
      await providers.resolveOperationModel(
        { provider: "hyper3d", id: MODEL3D_CONNECTION_ID },
        "animate",
      ),
    ).toBeUndefined();
    await expect(providers.balance(meshyModel)).rejects.toThrow(
      MESHY_DISABLED_MESSAGE,
    );
    expect(request).not.toHaveBeenCalled();
    const settings = MODEL_3D_PRESETS.tripo[0]!.settings;
    expect(
      normalizeModelUsages({
        "3d": { ...settings, operations: ["text", "animate", "retexture"] },
      })?.["3d"]?.operations,
    ).toContain("animate");
    expect(() =>
      normalizeModelUsages({
        "3d": {
          ...MODEL_3D_PRESETS.hyper3d[0]!.settings,
          operations: ["animate"],
        },
      }),
    ).toThrow();
  });
  it("filters persisted custom Meshy adapters and refuses old auth or endpoint changes without resolving credentials", async () => {
    const getAuth = vi.fn(),
      runtime = {
        hasConfiguredAuth: vi.fn(() => true),
        getAuth,
      } as unknown as ModelRuntime;
    const settings = {
      ...MODEL_3D_PRESETS.meshy[0]!.settings,
      operations: ["animate" as const],
    };
    const definition = normalizeCustomProviderModel(
      {
        id: "connection",
        name: "Geometry",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
        supportsImages: false,
      },
      "openai-completions",
      "http://127.0.0.1:43199/v1",
    );
    const custom: CustomProviderDetails = {
      id: "studio",
      name: "Studio",
      baseUrl: "http://127.0.0.1:43199/v1",
      authentication: "api_key",
      api: "openai-completions",
      hiddenModelIds: ["connection"],
      models: [{ ...definition, usages: { "3d": settings } }],
    };
    const request = vi.fn<typeof fetch>(),
      providers = new ProviderModels3D({
        runtime: async () => runtime,
        customProviders: async () => [custom],
        nativeModels: (id) => [...MODEL_3D_PRESETS[id]],
        isEnabled: () => true,
        isVisible: () => true,
        defaultModel: () => undefined,
        request,
      });
    const ref = { provider: custom.id, id: "connection" };
    for (const base of [
      "http://127.0.0.1:43199/v1",
      "http://127.0.0.1:43200/v1",
    ]) {
      custom.baseUrl = base;
      expect((await providers.catalog()).models).toEqual([]);
      expect(await providers.operationModels()).toEqual([]);
      await expect(
        providers.animate({
          model: TEST_GLB,
          providerModel: ref,
          actionIds: [0],
        }),
      ).rejects.toMatchObject({
        message: MESHY_DISABLED_MESSAGE,
        notSubmitted: true,
      });
      await expect(providers.animations(undefined, ref)).rejects.toThrow(
        MESHY_DISABLED_MESSAGE,
      );
    }
    expect(getAuth).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("canvas 3D recovery", () => {
  it("shares confirmed Tripo stages when a copied project retries while the original is polling", async () => {
    const location = await directory(),
      library = new AssetLibrary(location),
      projects = new ProjectManager(location, library);
    const request = tripoService(),
      respond = request.getMockImplementation()!;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let originalPolling = false,
      previewPolls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/tasks/task-1") && ++previewPolls === 1) {
        originalPolling = true;
        await blocked;
      }
      return respond(url, init);
    });
    const tools = new ToolRunner(
      location,
      { generate: vi.fn() },
      new TripoProvider(() => "workflow-fake-credential-20261028", request, 0),
      undefined,
      library,
    );
    const store = new CanvasStore(projects, library, tools);
    const phases = () =>
      posts(request).map(([url]) => String(url).split("/v3/")[1]);
    try {
      await Promise.all([library.load(), projects.load(), tools.load()]);
      const source = await projects.create("Source", "asset-canvas");
      const boardId = (await store.workspace(source.id)).boards[0]!.id;
      const board = await store.board(source.id, boardId);
      board.board.nodes.push({
        id: "model",
        type: "model-3d",
        position: { x: 0, y: 0 },
        data: {
          operation: "text",
          prompt: "Tower",
          images: [],
          model: tripoModel,
          targetPolycount: 1000,
          texture: true,
          pbr: false,
        },
      });
      board.board.editorLayout.nodes.model = { x: 0, y: 0 };
      await store.saveBoard(source.id, board.board, board.revision);
      const original = await store.generateNode(source.id, boardId, "model");
      await vi.waitFor(() => expect(originalPolling).toBe(true));
      const copy = await projects.duplicate(source.id);
      expect((await store.jobs(copy.id))[0]?.status).toBe("cancelled");
      const sourceHistory = JSON.parse(
        await readFile(
          path.join(source.workspacePath, "canvas/jobs.json"),
          "utf8",
        ),
      );
      const copyHistory = JSON.parse(
        await readFile(
          path.join(copy.workspacePath, "canvas/jobs.json"),
          "utf8",
        ),
      );
      expect(copyHistory[0].recoveryId).toBe(sourceHistory[0].recoveryId);
      await store.retry(copy.id, original.id);
      await vi.waitFor(async () =>
        expect((await store.jobs(copy.id))[0]?.status).toBe("succeeded"),
      );
      expect(phases()).toEqual(["generation/text-to-model"]);
      unblock();
      await vi.waitFor(async () =>
        expect((await store.jobs(source.id))[0]?.status).toBe("succeeded"),
      );
      expect(phases()).toEqual(["generation/text-to-model"]);
      expect(phases()).toEqual(["generation/text-to-model"]);
    } finally {
      unblock();
      await store.close();
      await tools.close();
    }
  });
  it.each([false, true])(
    "resumes a retexture after reopening without new tasks (journal temporarily absent: %s)",
    async (missingJournal) => {
      const location = await directory(),
        library = new AssetLibrary(location),
        projects = new ProjectManager(location, library);
      const request = tripoService(),
        original = request.getMockImplementation()!;
      let failed = true;
      request.mockImplementation(async (url, init) =>
        String(url).endsWith("/tasks/task-1") && failed
          ? Promise.reject(new Error("offline"))
          : original(url, init),
      );
      const tools = new ToolRunner(
        location,
        { generate: vi.fn() },
        new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        ),
        undefined,
        library,
      );
      await Promise.all([library.load(), projects.load(), tools.load()]);
      const project = await projects.create("3D workflow", "asset-canvas"),
        store = new CanvasStore(projects, library, tools);
      const workspace = await store.workspace(project.id),
        boardId = workspace.boards[0]!.id;
      const source = await library.add("source.glb", TEST_GLB, {
        model3d: {
          triangles: 1,
          textured: true,
          rigged: false,
          animations: [],
          forwardAxis: "+X",
        },
      });
      const board = await store.board(project.id, boardId);
      board.board.nodes.push({
        id: "texture",
        type: "model-3d",
        position: { x: 0, y: 0 },
        data: {
          operation: "retexture",
          prompt: "Gold",
          source: { type: "library", assetId: source.id },
          model: tripoModel,
          images: [],
          targetPolycount: 4000,
          texture: true,
          pbr: false,
        },
      });
      board.board.editorLayout.nodes.texture = { x: 0, y: 0 };
      await store.saveBoard(project.id, board.board, board.revision);
      const job = await store.generateNode(project.id, boardId, "texture");
      await vi.waitFor(async () =>
        expect((await store.jobs(project.id))[0]?.status).toBe("failed"),
      );
      await store.close();
      await tools.close();
      failed = false;
      const restartedTools = new ToolRunner(
        location,
        { generate: vi.fn() },
        new TripoProvider(
          () => "workflow-fake-credential-20261028",
          request,
          0,
        ),
        undefined,
        library,
      );
      await restartedTools.load();
      const reopened = new CanvasStore(projects, library, restartedTools);
      if (missingJournal) {
        const saved = JSON.parse(
          await readFile(
            path.join(project.workspacePath, "canvas/jobs.json"),
            "utf8",
          ),
        )[0];
        const file = path.join(
          location,
          "tools",
          "model3d-tasks",
          `${saved.recoveryId}.json`,
        );
        await rename(file, `${file}.held`);
        await reopened.retry(project.id, job.id);
        await vi.waitFor(async () =>
          expect((await reopened.jobs(project.id))[0]).toMatchObject({
            status: "failed",
            model3DRecoveryOnly: true,
            error: expect.stringContaining("unrecorded stage"),
          }),
        );
        expect(posts(request)).toHaveLength(2);
        expect(
          (await reopened.board(project.id, boardId)).board.nodes.find(
            (node) => node.id === "texture",
          )!.data,
        ).not.toHaveProperty("assetId");
        await rename(`${file}.held`, file);
      }
      await reopened.retry(
        project.id,
        (await reopened.jobs(project.id))[0]!.id,
      );
      await vi.waitFor(async () =>
        expect((await reopened.jobs(project.id))[0]?.status).toBe("succeeded"),
      );
      expect(posts(request)).toHaveLength(2);
      const output = (
        await reopened.board(project.id, boardId)
      ).board.nodes.find((node) => node.id === "texture")!;
      expect("assetId" in output.data && output.data.assetId).toBeTruthy();
      const manifest = await readCanvasAssets(project.workspacePath);
      expect(
        Object.values(manifest.assets).some(
          (asset) =>
            asset.model3d?.operation === "retexture" &&
            asset.model3d?.forwardAxis === "+X",
        ),
      ).toBe(true);
      expect((await reopened.jobs(project.id))[0]).not.toHaveProperty(
        "recoveryId",
      );
      await reopened.close();
      await restartedTools.close();
    },
  );
});

describe("bounded GLB parsing", () => {
  const rewrite = (bytes: Buffer, change: (json: any) => void, replacementBin?: Buffer) => {
    const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString("utf8", 20, 20 + length));
    const bin = replacementBin ?? bytes.subarray(28 + length), encoded: Buffer[] = [];
    change(json);
    const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(padded);
    const head = Buffer.alloc(20); head.write("glTF"); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + padded.length + bin.length, 8); head.writeUInt32LE(padded.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
    const binaryHead = Buffer.alloc(8); binaryHead.writeUInt32LE(bin.length); binaryHead.writeUInt32LE(0x004e4942, 4);
    encoded.push(head, padded, binaryHead, bin); return Buffer.concat(encoded);
  };
  it("rejects zero-base and duplicate-reference allocation amplification before constructing native arrays", async () => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const zero = rewrite(TEST_GLB, json => { json.accessors.push({ componentType: 5126, count: 12_000_000, type: "VEC3" }); });
    expect(() => preflightGlb(zero)).toThrow("128 MiB");
    const copies = rewrite(TEST_GLB, json => { json.accessors = Array.from({ length: 200 }, () => ({ componentType: 5126, count: 90_000, type: "VEC3" })); });
    expect(() => preflightGlb(copies)).toThrow("128 MiB");
    const overflowing = rewrite(TEST_GLB, json => { json.accessors.push({ componentType: 5126, count: Number.MAX_SAFE_INTEGER, type: "MAT4" }); });
    expect(() => preflightGlb(overflowing)).toThrow("integer");
  });
  it("counts each image reference and sparse base copy without deduplicating its source view", async () => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const images = rewrite(TEST_GLB, json => { json.buffers = [{ byteLength: 1024 * 1024 }]; json.bufferViews = [{ buffer: 0, byteLength: 1024 * 1024 }]; json.accessors = []; json.images = Array.from({ length: 129 }, () => ({ bufferView: 0, mimeType: "image/png" })); }, Buffer.alloc(1024 * 1024));
    expect(() => preflightGlb(images)).toThrow("128 MiB");
    const baseBin = TEST_GLB.subarray(28 + TEST_GLB.readUInt32LE(12));
    const sparse = rewrite(TEST_GLB, json => { const index = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: baseBin.length, byteLength: 4 }); json.buffers[0].byteLength = baseBin.length + 4; json.accessors.push({ bufferView: 0, componentType: 5126, count: 1, type: "SCALAR", sparse: { count: 1, indices: { bufferView: index, componentType: 5121 }, values: { bufferView: 0 } } }); }, Buffer.concat([baseBin, Buffer.alloc(4)]));
    expect(preflightGlb(sparse).summary.sparseAllocationBytes).toBe(9);
  });
  it.each(["https://example.invalid/model.bin", "file:///private/secret", "data:application/octet-stream;base64,AA=="])("refuses external resources %s", async uri => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.buffers[0].uri = uri; }))).toThrow("external and data URIs");
  });
  it("rejects malformed view ranges, sparse references, hierarchy cycles and unmodeled nested codecs", async () => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0].byteOffset = json.bufferViews[json.accessors[0].bufferView].byteLength; }))).toThrow("own buffer view");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.nodes[0].children = [0]; }))).toThrow("hierarchy");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0 } }; }))).toThrow("extension");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors.push({ componentType: 5123, count: 1, type: "MAT3" }); }))).toThrow("Padded");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0].sparse = { count: 1, indices: { componentType: 5121, bufferView: 0, byteOffset: 1_000_000 }, values: { bufferView: 0 } }; }))).toThrow("own buffer view");
  });
  it.each([["componentType", "5126"], ["type", ["VEC3"]], ["type", "toString"]])("refuses coerced accessor enum %s", async (key, value) => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0][key as string] = value; }))).toThrow("accessor layout");
  });
  it.each(["type", "componentType", "count", "normalized", "extensions", "extras"])("refuses sparse spread overrides %s before NodeIO", async key => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const value = key === "type" ? "MAT4" : key === "componentType" ? 5130 : key === "count" ? 1_000_000 : key === "normalized" ? true : {};
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0].sparse = { count: 1, indices: { componentType: 5121, bufferView: 0 }, values: { bufferView: 0, [key]: value } }; }))).toThrow("sparse GLB fields");
    if (key !== "componentType") expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0].sparse = { count: 1, indices: { componentType: 5121, bufferView: 0, [key]: value }, values: { bufferView: 0 } }; }))).toThrow("sparse GLB fields");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors[0].sparse = { count: 1, indices: { componentType: 5121, bufferView: 0 }, values: { bufferView: 0 }, [key]: value }; }))).toThrow();
  });
  it("does not let the reader inherit a parent offset that was absent from a sparse resource range", async () => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.accessors.push({ bufferView: 0, byteOffset: 4, componentType: 5126, count: 1, type: "SCALAR", sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 0 } } }); }))).toThrow("offset defaults");
  });
  it("bounds hierarchy depth even when children precede their parents in the node array", async () => {
    const { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const bytes = rewrite(TEST_GLB, json => { json.nodes = Array.from({ length: 300 }, (_, index) => index ? { children: [index - 1] } : {}); json.scenes = [{ nodes: [299] }]; });
    expect(() => preflightGlb(bytes)).toThrow("excessive GLB node hierarchy");
    expect(() => preflightGlb(rewrite(TEST_GLB, json => { json.nodes[1].children = [0]; }))).toThrow("scene root");
  });
  it("preserves morph accessors, textures, joints and clip data through split and axis wrappers", async () => {
    const { inspectAndSplitModel3D } = await import("../src/daemon/model3d-inspect.js"), { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const io = new NodeIO(), doc = await io.readBinary(await model3DFixture({ rigged: true, clips: ["Idle"] })), root = doc.getRoot(), buffer = root.listBuffers()[0]!, mesh = root.listMeshes()[0]!, primitive = mesh.listPrimitives()[0]!;
    const deltas = doc.createAccessor().setType("VEC3").setArray(new Float32Array([0,0,0,0,0,0.1,0,0,0.2])).setBuffer(buffer);
    primitive.addTarget(doc.createPrimitiveTarget().setAttribute("POSITION", deltas)); mesh.setWeights([0]);
    const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0,1])).setBuffer(buffer), output = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0,1])).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
    doc.createAnimation("Morph").addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(root.listNodes().find(node => node.getMesh())!).setTargetPath("weights").setSampler(sampler));
    const bytes = Buffer.from(await io.writeBinary(doc)), before = Buffer.from(bytes), split = await inspectAndSplitModel3D(bytes);
    expect(split.metadata).toMatchObject({ textured: true, rigged: true, animations: ["Idle", "Morph"] });
    expect(split.preflight).toMatchObject({ textureDecoding: "not-performed" });
    const files = split.resources!, restored = await io.readJSON({ json: JSON.parse(files.get("model.gltf")!.toString()), resources: Object.fromEntries([...files].filter(([name]) => name !== "model.gltf").map(([name, bytes]) => [name, new Uint8Array(bytes)])) });
    expect(restored.getRoot().listMeshes()[0]!.listPrimitives()[0]!.listTargets()[0]!.getAttribute("POSITION")!.getArray()).toEqual(deltas.getArray());
    expect(Buffer.from(restored.getRoot().listTextures()[0]!.getImage()!)).toEqual(Buffer.from(root.listTextures()[0]!.getImage()!));
    expect(restored.getRoot().listSkins()[0]!.listJoints().map(node => node.getName())).toEqual(["Root"]);
    const faced = await modelFacingPositiveZ(bytes, "+X");
    expect(Buffer.from(preflightGlb(faced).bin)).toEqual(Buffer.from(preflightGlb(bytes).bin)); expect(bytes).toEqual(before);
  });
  it("preserves optional WebP and its distinct PNG fallback without NodeIO preread mutating the original JSON", async () => {
    const { default: sharp } = await import("sharp"), { inspectAndSplitModel3D } = await import("../src/daemon/model3d-inspect.js"), { preflightGlb } = await import("../src/daemon/glb-preflight.js");
    const original = preflightGlb(TEST_GLB), png = original.json.bufferViews[original.json.images[0].bufferView], image = original.bin.subarray(png.byteOffset ?? 0, (png.byteOffset ?? 0) + png.byteLength);
    const pngBytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const webp = await sharp(pngBytes).webp({ lossless: true }).toBuffer(), base = Buffer.concat([Buffer.from(original.bin), pngBytes, Buffer.alloc((4 - pngBytes.length % 4) % 4)]), binary = Buffer.concat([base, webp, Buffer.alloc((4 - webp.length % 4) % 4)]);
    const bytes = rewrite(TEST_GLB, json => { const fallback = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: original.bin.length, byteLength: pngBytes.length }); json.images[0].bufferView = fallback; const view = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: base.length, byteLength: webp.length }); json.buffers[0].byteLength = binary.length; json.images.push({ bufferView: view, mimeType: "image/webp" }); json.extensionsUsed = ["EXT_texture_webp"]; json.textures[0].extensions = { EXT_texture_webp: { source: 1 } }; }, binary);
    const faced = preflightGlb(await modelFacingPositiveZ(bytes, "+X"));
    expect(faced.json.textures[0]).toMatchObject({ source: 0, extensions: { EXT_texture_webp: { source: 1 } } });
    const split = await inspectAndSplitModel3D(bytes), json = JSON.parse(split.resources!.get("model.gltf")!.toString());
    expect(json.textures[0]).toMatchObject({ source: 0, extensions: { EXT_texture_webp: { source: 1 } } });
    expect(split.resources!.get(json.images[0].uri)).toEqual(pngBytes); expect(split.resources!.get(json.images[1].uri)).toEqual(webp);
  });
  it("reuses SHA metadata across Buffer copies, returns defensive metadata, and never caches source bodies", async () => {
    const { Worker } = await import("node:worker_threads"), stop = vi.spyOn(Worker.prototype, "terminate");
    const bytes = rewrite(TEST_GLB, json => { json.asset.generator = "bounded metadata cache fixture"; });
    try {
      const first = await inspectModel3D(bytes); first.animations.push("caller edit");
      expect((await inspectModel3D(Buffer.from(bytes))).animations).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { stop.mockRestore(); }
  });
  it("rejects mutation or scanner-policy changes while queued and refuses SharedArrayBuffer inputs", async () => {
    const { registerSensitiveValue } = await import("../src/shared/sensitive-values.js");
    const bytes = rewrite(TEST_GLB, json => { json.asset.generator = "mutable GLB input"; });
    const pending = inspectModel3D(bytes); bytes[bytes.length - 1] ^= 1;
    await expect(pending).rejects.toThrow("changed during inspection");
    const next = inspectModel3D(rewrite(TEST_GLB, json => { json.asset.generator = "policy revision fixture"; }));
    registerSensitiveValue("glb-policy-canary-not-in-model-20261110");
    await expect(next).rejects.toThrow("policy changed");
    const shared = Buffer.from(new SharedArrayBuffer(TEST_GLB.length)); shared.set(TEST_GLB);
    await expect(inspectModel3D(shared)).rejects.toThrow("Invalid GLB");
  });
  it("cancels active and queued workers without allowing later workers to overlap", async () => {
    const first = new AbortController(), queued = new AbortController();
    const a = inspectModel3D(rewrite(TEST_GLB, json => { json.asset.generator = "cancel active"; }), first.signal);
    const b = inspectModel3D(rewrite(TEST_GLB, json => { json.asset.generator = "cancel queued"; }), queued.signal);
    const aRejected = expect(a).rejects.toThrow("active cancelled"), bRejected = expect(b).rejects.toThrow("queued cancelled");
    await expect(inspectModel3D(rewrite(TEST_GLB, json => { json.asset.generator = "third queue entry"; }))).rejects.toThrow("queue is full");
    await new Promise(resolve => setTimeout(resolve, 5));
    queued.abort(new Error("queued cancelled")); first.abort(new Error("active cancelled"));
    await Promise.all([aRejected, bRejected]);
    expect(await inspectModel3D(rewrite(TEST_GLB, json => { json.asset.generator = "after cancelled workers"; }))).toMatchObject({ triangles: 1 });
  });
  it("retains the original and emits no derived model metadata when cancelled", async () => {
    const workspace = await directory(), controller = new AbortController();
    controller.abort(new Error("cancel before model publication"));
    await expect(storeModelResources(workspace, { id: "cancelled-model", contentType: "model/gltf-binary" } as never, TEST_GLB, undefined, false, controller.signal)).rejects.toThrow("cancel before");
    expect(await readdir(workspace)).toEqual([]);
  });
  it.each(["write", "identity"])("keeps durable originals but does not publish ready metadata after cancellation during private metadata %s", async stage => {
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"), controller = new AbortController(), workspace = await directory();
    vi.resetModules(); vi.doMock("node:fs/promises", () => ({ ...filesystem, open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      if (String(args[0]).endsWith(".tmp")) { const write = handle.writeFile.bind(handle); handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => { await write(...input); if (stage === "write") controller.abort(new Error("cancel metadata commit")); }; }
      return handle;
    }, lstat: async (...args: Parameters<typeof filesystem.lstat>) => {
      const info = await filesystem.lstat(...args);
      if (stage === "identity" && String(args[0]).endsWith(".tmp")) controller.abort(new Error("cancel metadata commit"));
      return info;
    } }));
    try {
      const { storeModelResources: store } = await import("../src/daemon/model-resources.js");
      await expect(store(workspace, { id: "cancel-metadata", contentType: "model/gltf-binary" } as never, TEST_GLB, undefined, false, controller.signal)).rejects.toThrow("cancel metadata commit");
      expect((await readdir(path.join(workspace, "assets/models"))).filter(name => name.endsWith(".tmp") || name.endsWith(".model.json"))).toEqual([]);
      const sha = (await import("node:crypto")).createHash("sha256").update(TEST_GLB).digest("hex");
      expect(await readFile(path.join(workspace, `.data/model-assets/${sha}/${sha}.glb`))).toEqual(TEST_GLB);
    } finally { vi.doUnmock("node:fs/promises"); vi.resetModules(); }
  });

  it("never deletes a colliding metadata staging path it did not create", async () => {
    const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"), workspace = await directory(); let collision: string | undefined;
    vi.resetModules(); vi.doMock("node:fs/promises", () => ({ ...filesystem, open: async (...args: Parameters<typeof filesystem.open>) => {
      if (String(args[0]).endsWith(".tmp")) { collision = String(args[0]); await filesystem.writeFile(collision, "other-owner-temporary", { flag: "wx" }); throw Object.assign(new Error("metadata staging collision"), { code: "EEXIST" }); }
      return filesystem.open(...args);
    } }));
    try {
      const fresh = await import("../src/daemon/model-resources.js");
      await expect(fresh.storeModelResources(workspace, { id: "collision", contentType: "model/gltf-binary" } as never, TEST_GLB)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(collision!, "utf8")).toBe("other-owner-temporary");
    } finally { vi.doUnmock("node:fs/promises"); vi.resetModules(); }
  });
  it.each(["timeout", "startup", "frame"])("bounds worker %s failures without exposing raw third-party messages", async scenario => {
    const { EventEmitter } = await import("node:events"); let stopped = 0;
    class FailedWorker extends EventEmitter {
      stdout = { resume() {} }; stderr = { resume() {} };
      constructor() { super(); if (scenario === "startup") throw new Error("private-worker-path-canary"); if (scenario === "frame") queueMicrotask(() => this.emit("message", { ok: true, result: { private: "private-worker-path-canary" } })); }
      terminate() { stopped++; return Promise.resolve(0); }
    }
    vi.resetModules(); vi.doMock("node:worker_threads", () => ({ Worker: FailedWorker }));
    if (scenario === "timeout") vi.useFakeTimers();
    try {
      const fresh = await import("../src/daemon/model3d-inspect.js"), result = fresh.inspectModel3D(TEST_GLB).catch(error => error);
      if (scenario === "timeout") await vi.advanceTimersByTimeAsync(30_001);
      const cause = await result;
      expect(cause).toBeInstanceOf(Error); expect(cause.message).not.toContain("canary"); expect(fresh.isModel3DParserUncertain(cause)).toBe(false);
      expect(cause.message).toContain(scenario === "timeout" ? "timed out" : "Invalid GLB"); expect(stopped).toBe(scenario === "startup" ? 0 : 1);
    } finally { vi.useRealTimers(); vi.doUnmock("node:worker_threads"); vi.resetModules(); }
  });
  it("does not use an unbounded multi-document animation writer", async () => {
    const { mergeAnimationClips } = await import("../src/daemon/merge-animations.js");
    expect(await mergeAnimationClips([TEST_GLB])).toBe(TEST_GLB);
    await expect(mergeAnimationClips([TEST_GLB, TEST_GLB])).rejects.toThrow("unsupported");
  });
  it("latches unconfirmed worker termination and never exposes third-party error messages", async () => {
    const { EventEmitter } = await import("node:events"); let created = 0;
    class UncertainWorker extends EventEmitter {
      stdout = { resume() {} }; stderr = { resume() {} };
      constructor(_url: URL, readonly options: any) { super(); created++; expect(options.env).toEqual({}); expect(options.transferList).toHaveLength(1); queueMicrotask(() => this.emit("error", new Error("protected-worker-error-canary"))); }
      terminate() { return Promise.reject(new Error("protected-termination-canary")); }
    }
    vi.resetModules(); vi.doMock("node:worker_threads", () => ({ Worker: UncertainWorker }));
    try {
      const fresh = await import("../src/daemon/model3d-inspect.js");
      const cause = await fresh.inspectModel3D(TEST_GLB).catch(error => error);
      expect(fresh.isModel3DParserUncertain(cause)).toBe(true);
      expect(cause.message).toContain("shutdown could not be confirmed"); expect(cause.message).not.toContain("canary");
      await expect(fresh.inspectModel3D(TEST_GLB)).rejects.toThrow("blocked"); expect(created).toBe(1);
      const freshResources = await import("../src/daemon/model-resources.js"), workspace = await directory();
      await expect(freshResources.storeModelResources(workspace, { id: "uncertain", contentType: "model/gltf-binary" } as never, TEST_GLB)).rejects.toThrow("blocked");
      const originals = await readdir(path.join(workspace, ".data/model-assets")); expect(originals).toHaveLength(1);
      expect(await readFile(path.join(workspace, ".data/model-assets", originals[0]!, `${originals[0]}.glb`))).toEqual(TEST_GLB);
      await expect(stat(path.join(workspace, "assets/models/uncertain.model.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.doUnmock("node:worker_threads"); vi.resetModules(); }
  });
});
