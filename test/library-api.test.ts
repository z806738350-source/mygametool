import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCanvasNode, LibraryAsset, LibraryAssetSummary, ProjectState } from "../src/shared/contracts.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";
import { fbxFixture } from "./model3d-fixture.js";
import { referencePng } from "./video-reference-png-fixture.js";

type App = Awaited<ReturnType<typeof import("../src/daemon/app.js").createApp>>;
let createApp: typeof import("../src/daemon/app.js").createApp;
let ProjectManager: typeof import("../src/daemon/projects.js").ProjectManager;
const fixtures: { app: App; directory: string }[] = [];
beforeEach(async () => {
  vi.resetModules();
  ({ createApp } = await import("../src/daemon/app.js"));
  ({ ProjectManager } = await import("../src/daemon/projects.js"));
});
afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup(accessToken?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-filters-"));
  const app = createApp({ dataDirectory: directory, ...(accessToken ? { accessToken } : {}) });
  fixtures.push({ app, directory });
  return app;
}

async function upload(app: App, purpose: "asset" | "reference" = "asset"): Promise<LibraryAsset> {
  const response = await app.inject({ method: "POST", url: "/library/assets", payload: {
    name: "portrait.png", purpose,
    image: { mediaType: "image/png", data: referencePng().toString("base64") },
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

describe("checked Library content responses", () => {
  it("requires the local token for GET ranges and HEAD, and rejects untrusted Host and Origin", async () => {
    const token = "local-library-fixture-token";
    const app = await setup(token);
    const authorized = { authorization: `Bearer ${token}` };
    const upload = await app.inject({ method: "POST", url: "/library/assets", headers: authorized, payload: {
      name: "portrait.png", purpose: "asset", image: { mediaType: "image/png", data: referencePng().toString("base64") },
    } });
    expect(upload.statusCode, upload.body).toBe(201);
    const url = `/library/assets/${upload.json<LibraryAsset>().id}/content`;
    for (const method of ["GET", "HEAD"] as const) {
      expect((await app.inject({ method, url, headers: { range: "bytes=0-3" } })).statusCode).toBe(401);
      expect((await app.inject({ method, url: `${url}?sha256=${"0".repeat(64)}`, headers: { range: "bytes=0-3" } })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: { ...authorized, origin: "https://outside.example" } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { ...authorized, host: "outside.example" } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url, headers: { ...authorized, range: "bytes=0-3" } })).statusCode).toBe(206);
    expect((await app.inject({ method: "HEAD", url, headers: authorized })).statusCode).toBe(200);
  });

  it("serves authenticated byte ranges from a fully inspected original and preserves HEAD and If-Range", async () => {
    const app = await setup(), asset = await upload(app), url = `/library/assets/${asset.id}/content`;
    const original = (await app.inject(url)).rawPayload;
    const range = await app.inject({ url, headers: { range: "bytes=1-4" } });
    expect(range.statusCode, range.body).toBe(206);
    expect(range.rawPayload).toEqual(original.subarray(1, 5));
    expect(range.headers).toMatchObject({ "content-range": `bytes 1-4/${original.length}`, "accept-ranges": "bytes", "cache-control": "no-store" });
    const head = await app.inject({ method: "HEAD", url, headers: { range: "bytes=999999-" } });
    expect(head.statusCode).toBe(200); expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(original.length));
    const seek = await app.inject({ url, headers: { range: "bytes=-4", "if-range": range.headers.etag! } });
    expect(seek.statusCode).toBe(206); expect(seek.rawPayload).toEqual(original.subarray(-4));
    const changed = await app.inject({ url, headers: { range: "bytes=1-4", "if-range": '"old"' } });
    expect(changed.statusCode).toBe(200); expect(changed.rawPayload).toEqual(original);
    const beyond = await app.inject({ url, headers: { range: `bytes=${original.length}-` } });
    expect(beyond.statusCode).toBe(416); expect(beyond.headers["content-range"]).toBe(`bytes */${original.length}`);
    const bound = `${url}?sha256=${range.headers.etag!.slice(1, -1)}`;
    expect((await app.inject({ url: bound, headers: { range: "bytes=1-4" } })).rawPayload).toEqual(original.subarray(1, 5));
    for (const method of ["GET", "HEAD"] as const) expect((await app.inject({ method, url: `${url}?sha256=${"0".repeat(64)}` })).statusCode).toBe(409);
    expect((await app.inject(`${url}?sha256=invalid`)).statusCode).toBe(400);
  });

  it("does not let a cached small range or HEAD bypass a newly registered secret elsewhere", async () => {
    const app = await setup();
    const secret = `library-snapshot-secret-${randomUUID()}`;
    const contents = Buffer.from(`ID3safe-prefix:${"x".repeat(70_000)}:${secret}`);
    const response = await app.inject({ method: "POST", url: "/library/assets/upload?name=sample.mp3&mediaType=audio%2Fmpeg", headers: { "content-type": "application/octet-stream" }, payload: contents });
    expect(response.statusCode, response.body).toBe(201);
    const url = `/library/assets/${response.json<LibraryAsset>().id}/content`;
    expect((await app.inject({ url, headers: { range: "bytes=0-3" } })).statusCode).toBe(206);
    (await import("../src/shared/sensitive-values.js")).registerSensitiveValue(secret);
    for (const method of ["GET", "HEAD"] as const) {
      const refused = await app.inject({ method, url, headers: { range: "bytes=0-3" } });
      expect(refused.statusCode).toBe(403); expect(refused.body).not.toContain(secret);
    }
  });
});

describe("Local FBX preview API", () => {
  it("resolves only models explicitly added to the current game and exposes bounded local runtime resources", async () => {
    const app = await setup(), asset = await uploadFbx(app);
    expect((await app.inject({ method: "POST", url: `/library/assets/${asset.id}/model-preview` })).statusCode).toBe(200);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Model game", type: "web-game" } })).json<ProjectState>();
    const url = `/projects/${project.id}/model-assets/resolve`;
    expect((await app.inject({ method: "POST", url, payload: { assetId: asset.id } })).statusCode).toBe(403);
    const added = await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` });
    expect(added.statusCode, added.body).toBe(201); expect(added.json().modelRuntimePath).toMatch(/model\.gltf$/);
    const response = await app.inject({ method: "POST", url, payload: { assetId: asset.id } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().ready).toBe(true);
    expect(response.json().resources.every((file: { size: number }) => file.size <= 2 * 1024 * 1024)).toBe(true);
    expect((await app.inject(`/projects/${project.id}/model-assets`)).json()).toContainEqual(expect.objectContaining({ assetId: asset.id }));
    expect((await app.inject({ method: "POST", url, payload: { assetId: asset.id, path: "../outside.fbx" } })).statusCode).toBe(400);
  });
  async function uploadFbx(app: App, bytes = fbxFixture()) {
    const response = await app.inject({ method: "POST", url: "/library/assets/upload?name=quad.fbx&mediaType=application%2Fvnd.autodesk.fbx", headers: { "content-type": "application/octet-stream" }, payload: bytes });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<LibraryAsset>();
  }
  it("preserves the downloadable original, builds a local preview and keeps both across canvas save and rebuild", async () => {
    const app = await setup(), original = fbxFixture(), asset = await uploadFbx(app, original);
    const content = `/library/assets/${asset.id}/content`, rebuild = `/library/assets/${asset.id}/model-preview`;
    expect((await app.inject(content)).rawPayload).toEqual(original);
    expect((await app.inject(`${content}?preview=true`)).statusCode).toBe(409);
    const result = await app.inject({ method: "POST", url: rebuild });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().model3d.preview).toMatchObject({ status: "ready", materialApproximation: true });
    const preview = await app.inject(`${content}?preview=true`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers["content-type"]).toBe("model/gltf-binary");
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.rawPayload.subarray(0, 4).toString()).toBe("glTF");
    const canvas = await canvasFixture(app, result.json());
    const canvasPreview = `${canvas.base}/assets/${asset.id}/model-preview`;
    expect((await app.inject(canvasPreview)).rawPayload).toEqual(preview.rawPayload);
    expect((await app.inject({ method: "POST", url: canvasPreview })).statusCode).toBe(200);
    const manifest = JSON.parse(await readFile(path.join(canvas.project.workspacePath, "canvas/assets.json"), "utf8"));
    expect(await readFile(path.join(canvas.project.workspacePath, manifest.assets[asset.id].modelPreviewPath))).toEqual(preview.rawPayload);
    expect((await app.inject(content)).rawPayload).toEqual(original);
  });
  it("retains unsupported ASCII FBX without pretending there is a GLB", async () => {
    const app = await setup(), original = Buffer.from("; FBX 7.4.0 project file\n; unsupported fixture\n"), asset = await uploadFbx(app, original);
    const result = await app.inject({ method: "POST", url: `/library/assets/${asset.id}/model-preview` });
    expect(result.statusCode).toBe(422);
    expect(result.json().error).toContain("original is retained");
    expect((await app.inject(`/library/assets/${asset.id}/content`)).rawPayload).toEqual(original);
  });
  it.each(["changed", "hardlink"] as const)("refuses a %s preview while leaving the original available", async kind => {
    const app = await setup(), original = fbxFixture(), asset = await uploadFbx(app, original);
    expect((await app.inject({ method: "POST", url: `/library/assets/${asset.id}/model-preview` })).statusCode).toBe(200);
    const directory = fixtures.find(value => value.app === app)!.directory;
    const file = path.join(directory, "library", "files", `${asset.id}.preview.glb`);
    if (kind === "changed") { const bytes = await readFile(file); bytes[bytes.length - 1]! ^= 1; await writeFile(file, bytes); }
    else await link(file, `${file}.linked-fixture`);
    expect((await app.inject(`/library/assets/${asset.id}/content?preview=true`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject(`/library/assets/${asset.id}/content`)).rawPayload).toEqual(original);
  });
});

async function list(app: App): Promise<LibraryAssetSummary[]> {
  const response = await app.inject({ method: "GET", url: "/library/assets" });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function canvasFixture(app: App, asset: LibraryAsset, name = "Art") {
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name, type: "asset-canvas" } })).json<ProjectState>();
  const base = `/projects/${project.id}/canvas`;
  const workspace = (await app.inject({ method: "GET", url: `${base}/workspace` })).json();
  const boardUrl = `${base}/boards/${workspace.boards[0].id}`;
  let detail = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
  const save = async (nodes: AssetCanvasNode[]) => {
    detail.board.nodes = nodes;
    detail.board.edges = [];
    detail.board.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [node.id, node.position]));
    const response = await app.inject({ method: "PUT", url: boardUrl, payload: detail });
    expect(response.statusCode, response.body).toBe(200);
    detail = response.json();
  };
  await save([{ id: "asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: asset.mediaType } }]);
  const manifest = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/assets.json"), "utf8"));
  return { project, base, boardId: detail.board.id, localPath: manifest.assets[asset.id].path as string, save };
}

async function expectUnknownReferences(app: App, asset: LibraryAsset, reason: string, contentStatus = 200) {
  const references = await app.inject(`/library/assets/${asset.id}/references`);
  expect(references.statusCode, references.body).toBe(409);
  expect(references.headers["cache-control"]).toBe("no-store");
  expect(references.json().error).toContain(reason);
  expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
  const content = await app.inject(`/library/assets/${asset.id}/content`);
  expect(content.statusCode).toBe(contentStatus);
  if (contentStatus === 507) {
    expect(content.json().error).toMatch(/reservations.*unconfirmed|capacity|inspection/i);
    expect(content.rawPayload.includes(referencePng())).toBe(false);
  }
}

describe("Library provenance and project filters", () => {
  it("checks a healthy initialized Interactive Story without reporting unrelated assets as used", async () => {
    const app = await setup(), asset = await upload(app);
    const project = await app.inject({ method: "POST", url: "/projects", payload: { name: "Story", type: "interactive-story" } });
    expect(project.statusCode, project.body).toBe(201);
    const references = await app.inject(`/library/assets/${asset.id}/references`);
    expect(references.statusCode, references.body).toBe(200);
    expect(references.json()).toEqual([]);
  });

  it.each(["missing", "damaged", "symlink"] as const)("treats a %s Interactive Story graph as unknown", async (kind) => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Story", type: "interactive-story" } })).json<ProjectState>();
    const file = path.join(project.workspacePath, "graph.json");
    if (kind === "damaged") await writeFile(file, "{broken");
    else {
      await rename(file, `${file}.missing-fixture`);
      if (kind === "symlink") await symlink(`${file}.missing-fixture`, file);
    }
    await expectUnknownReferences(app, asset, "Cannot verify Library references");
    if (kind === "damaged") expect(await readFile(file, "utf8")).toBe("{broken");
  });

  it("refuses to trust project storage replaced with a symbolic link", async () => {
    const app = await setup(), asset = await upload(app);
    const directory = fixtures.find((fixture) => fixture.app === app)!.directory;
    const projects = path.join(directory, "projects"), empty = path.join(directory, "empty-fixture");
    await rename(projects, `${projects}.saved-fixture`);
    await mkdir(empty);
    await symlink(empty, projects, "dir");
    await expectUnknownReferences(app, asset, "Project storage is not a regular directory");
  });

  it.each(["unloaded directory", "non-directory", "symlink"] as const)("refuses to claim unused when project storage contains an unknown UUID %s", async (kind) => {
    const app = await setup(), asset = await upload(app);
    const directory = fixtures.find((fixture) => fixture.app === app)!.directory;
    const candidate = path.join(directory, "projects", randomUUID());
    if (kind === "unloaded directory") await mkdir(candidate);
    else if (kind === "non-directory") await writeFile(candidate, "Not a project directory");
    else await symlink(directory, candidate, "dir");
    await expectUnknownReferences(app, asset, "Cannot verify registered projects");
    await rename(candidate, `${candidate}.quarantined-fixture`);
    const recovered = await app.inject(`/library/assets/${asset.id}/references`);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toEqual([]);
  });

  it("does not overlook a damaged project skipped during startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-unknown-project-"));
    const project = await new ProjectManager(directory).create("Damaged");
    const metadata = path.join(path.dirname(project.workspacePath), "project.json");
    await writeFile(metadata, "{broken");
    const app = createApp({ dataDirectory: directory });
    fixtures.push({ app, directory });
    const asset = await upload(app);
    expect((await app.inject("/projects")).json()).toEqual([]);
    await expectUnknownReferences(app, asset, "has not been loaded");
    expect(await readFile(metadata, "utf8")).toBe("{broken");
  });

  it("treats a project with unavailable workspace at startup as unknown", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-library-unavailable-project-"));
    const project = await new ProjectManager(directory).create("Unavailable");
    await rename(project.workspacePath, `${project.workspacePath}.missing-fixture`);
    const app = createApp({ dataDirectory: directory });
    fixtures.push({ app, directory });
    const asset = await upload(app);
    expect((await app.inject(`/projects/${project.id}`)).json().workspaceAvailable).toBe(false);
    await expectUnknownReferences(app, asset, "Project workspace is unavailable", 507);
  });

  it.each(["missing", "non-directory", "symlink"] as const)("rechecks the workspace when it becomes %s after startup", async (kind) => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Changed" } })).json<ProjectState>();
    await rename(project.workspacePath, `${project.workspacePath}.saved-fixture`);
    if (kind === "non-directory") await writeFile(project.workspacePath, "Not a directory");
    if (kind === "symlink") await symlink(`${project.workspacePath}.saved-fixture`, project.workspacePath, "dir");
    await expectUnknownReferences(app, asset, "Cannot verify canvas references");
  });

  it.skipIf(process.platform === "win32")("refuses to claim unused when a loaded workspace cannot be read", async () => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Unreadable" } })).json<ProjectState>();
    await chmod(project.workspacePath, 0);
    try { await expectUnknownReferences(app, asset, "Cannot verify canvas references"); }
    finally { await chmod(project.workspacePath, 0o700); }
  });

  it("does not overlook a loaded project that disappears from project storage", async () => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Moved" } })).json<ProjectState>();
    const directory = path.dirname(project.workspacePath);
    await rename(directory, `${directory}.moved-fixture`);
    await expectUnknownReferences(app, asset, "missing from project storage");
  });

  it.each(["missing", "damaged", "changed type"] as const)("treats %s metadata in a loaded project as unknown", async (kind) => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Changed metadata" } })).json<ProjectState>();
    const file = path.join(path.dirname(project.workspacePath), "project.json");
    if (kind === "missing") await rename(file, `${file}.missing-fixture`);
    else if (kind === "damaged") await writeFile(file, "{broken");
    else { const metadata = JSON.parse(await readFile(file, "utf8")); await writeFile(file, JSON.stringify({ ...metadata, type: "asset-canvas" })); }
    await expectUnknownReferences(app, asset, "Cannot verify registered projects");
  });

  it("never caches unused or missing-asset reference responses", async () => {
    const app = await setup(), asset = await upload(app);
    const references = await app.inject(`/library/assets/${asset.id}/references`);
    expect(references.statusCode).toBe(200);
    expect(references.json()).toEqual([]);
    expect(references.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(204);
    const missing = await app.inject(`/library/assets/${asset.id}/references`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("releases deleted canvas nodes without deleting local media, provenance, or generation history", async () => {
    const app = await setup(), asset = await upload(app);
    const canvas = await canvasFixture(app, asset);
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toHaveLength(1);
    await canvas.save([]);
    const jobs = JSON.stringify([{ id: "old-generation", assetId: asset.id, status: "succeeded" }]);
    await writeFile(path.join(canvas.project.workspacePath, "canvas/jobs.json"), jobs);
    const metadataFile = path.join(canvas.project.workspacePath, ".data/assets.json");
    const manifestFile = path.join(canvas.project.workspacePath, "canvas/assets.json");
    const metadata = await readFile(metadataFile, "utf8"), manifest = await readFile(manifestFile, "utf8");
    expect(JSON.parse(metadata).libraryAssets[canvas.localPath]).toBe(asset.id);
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(204);
    expect(await readFile(path.join(canvas.project.workspacePath, canvas.localPath))).toEqual(referencePng());
    expect(await readFile(metadataFile, "utf8")).toBe(metadata);
    expect(await readFile(manifestFile, "utf8")).toBe(manifest);
    expect(await readFile(path.join(canvas.project.workspacePath, "canvas/jobs.json"), "utf8")).toBe(jobs);
    const reopened = await app.inject(`${canvas.base}/workspace`);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().assets).toContainEqual(expect.objectContaining({ id: asset.id, path: canvas.localPath }));
    expect(await list(app)).toEqual([]);
  });

  it("keeps another canvas project protected after the first project's node is removed", async () => {
    const app = await setup(), asset = await upload(app);
    const first = await canvasFixture(app, asset, "First"), second = await canvasFixture(app, asset, "Second");
    await first.save([]);
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toEqual([{ id: second.project.id, name: "Second", type: "asset-canvas" }]);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
  });

  it.each(["file", "folder", "text", "document", "document-dot", "document-parent", "table"] as const)("protects a remaining local path in a canvas %s after its asset node is removed", async (kind) => {
    const app = await setup(), asset = await upload(app);
    await app.inject({ method: "PATCH", url: `/library/assets/${asset.id}`, payload: { name: "duck rider" } });
    const canvas = await canvasFixture(app, asset), localPath = canvas.localPath;
    if (kind === "file" || kind === "folder") {
      await canvas.save([{ id: "file", type: "file", position: { x: 0, y: 0 }, data: kind === "file" ? { path: localPath } : { path: path.posix.dirname(localPath), directory: true } }]);
    } else if (kind === "text") {
      await canvas.save([{ id: "text", type: "text", position: { x: 0, y: 0 }, data: { text: `<img src="../../${localPath.split("/").map(encodeURIComponent).join("/")}">`, instruction: "" } }]);
    } else {
      await canvas.save([]);
      if (kind.startsWith("document")) {
        const document = (await app.inject({ method: "POST", url: `${canvas.base}/documents`, payload: { title: "Design" } })).json();
        const relativePath = localPath.split("/").map(encodeURIComponent).join("/");
        const link = kind === "document-dot" ? relativePath.replace("/", "/./") : kind === "document-parent" ? relativePath.replace("/", "/unused/../") : relativePath;
        await writeFile(path.join(canvas.project.workspacePath, "canvas/documents", `${document.document.id}.md`), `![Duck](../../${link})`);
      } else {
        const detail = (await app.inject({ method: "POST", url: `${canvas.base}/tables`, payload: { title: "Assets" } })).json();
        detail.table.rows.push({ id: "duck", cells: { [detail.table.columns[0].id]: localPath } });
        expect((await app.inject({ method: "PUT", url: `${canvas.base}/tables/${detail.table.id}`, payload: detail })).statusCode).toBe(200);
      }
    }
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
  });

  it.each(["prompts", "previews", "libraryAssets"])("refuses deletion when project asset metadata uses an invalid %s array", async (field) => {
    const app = await setup(), asset = await upload(app), canvas = await canvasFixture(app, asset);
    await canvas.save([]);
    const file = path.join(canvas.project.workspacePath, ".data/assets.json");
    const metadata = JSON.parse(await readFile(file, "utf8"));
    metadata[field] = [];
    await writeFile(file, JSON.stringify(metadata));
    const deleted = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(deleted.json().error).toContain("Cannot verify canvas references");
  });

  it("refuses deletion for an orphaned board even when its local asset manifests are empty", async () => {
    const app = await setup(), asset = await upload(app), canvas = await canvasFixture(app, asset);
    await writeFile(path.join(canvas.project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: {} }));
    await writeFile(path.join(canvas.project.workspacePath, ".data/assets.json"), JSON.stringify({ version: 1, prompts: {}, previews: {}, libraryAssets: {} }));
    const index = path.join(canvas.project.workspacePath, "canvas/index.json");
    await rename(index, `${index}.missing-fixture`);
    const deleted = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(deleted.json().error).toContain("Canvas index data is missing");
  });

  it.each(["metadata", "index", "board", "document", "table"] as const)("refuses deletion when canvas %s data cannot be verified", async (kind) => {
    const app = await setup(), asset = await upload(app), canvas = await canvasFixture(app, asset);
    await canvas.save([]);
    let file: string;
    if (kind === "metadata") file = path.join(canvas.project.workspacePath, ".data/assets.json");
    else if (kind === "index") file = path.join(canvas.project.workspacePath, "canvas/index.json");
    else if (kind === "board") file = path.join(canvas.project.workspacePath, "canvas/boards", `${canvas.boardId}.json`);
    else {
      const response = await app.inject({ method: "POST", url: `${canvas.base}/${kind}s`, payload: { title: "Missing" } });
      const detail = response.json();
      file = path.join(canvas.project.workspacePath, `canvas/${kind}s`, `${detail[kind].id}.${kind === "document" ? "md" : "json"}`);
    }
    if (kind === "metadata") await writeFile(file, "{broken");
    else await rename(file, `${file}.missing-fixture`);
    const deleted = await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` });
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(deleted.json().error).toContain("Cannot verify canvas references");
    expect((await app.inject(`/library/assets/${asset.id}/content`)).statusCode).toBe(200);
  });

  it("does not let an empty uninitialized asset canvas block unused Library deletion", async () => {
    const app = await setup(), asset = await upload(app);
    await app.inject({ method: "POST", url: "/projects", payload: { name: "Empty", type: "asset-canvas" } });
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(204);
  });

  it("continues protecting materialized files in game projects even without canvas nodes", async () => {
    const app = await setup(), asset = await upload(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Game", type: "web-game" } })).json<ProjectState>();
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` })).statusCode).toBe(201);
    expect((await app.inject(`/library/assets/${asset.id}/references`)).json()).toEqual([{ id: project.id, name: "Game", type: "web-game" }]);
    expect((await app.inject({ method: "DELETE", url: `/library/assets/${asset.id}` })).statusCode).toBe(409);
  });

  it("keeps upload provenance across projects and only saves project files explicitly", async () => {
    const app = await setup();
    const asset = await upload(app);
    const first = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Forest" } })).json<ProjectState>();
    const second = (await app.inject({ method: "POST", url: "/projects", payload: { name: "City" } })).json<ProjectState>();
    for (const project of [first, second]) {
      expect((await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` })).statusCode).toBe(201);
    }
    await writeFile(path.join(first.workspacePath, "sprite.png"), "project media");
    expect(await list(app)).toHaveLength(1);
    const saved = await app.inject({ method: "POST", url: `/projects/${first.id}/assets/library?path=sprite.png` });
    expect(saved.statusCode, saved.body).toBe(201);
    const assets = await list(app);
    expect(assets).toHaveLength(2);
    expect(assets.find((candidate) => candidate.id === asset.id)).toMatchObject({ origin: "uploaded", referenceOnly: false, projects: [{ id: first.id, name: "Forest" }, { id: second.id, name: "City" }] });
    expect(assets.find((candidate) => candidate.name === "sprite.png")).toMatchObject({ origin: "workspace", saved: true, projects: [{ id: first.id }] });
    expect(await list(app)).toEqual(assets);
    await app.inject({ method: "PATCH", url: `/projects/${first.id}`, payload: { name: "New Forest" } });
    expect((await list(app)).find((candidate) => candidate.id === asset.id)?.projects[0]?.name).toBe("New Forest");
  });

  it("keeps repeated saves stable and saves the latest contents after a project file changes", async () => {
    const app = await setup();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const file = path.join(project.workspacePath, "sprite.png");
    await writeFile(file, "first");
    const url = `/projects/${project.id}/assets/library?path=sprite.png`;
    const first = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    const repeated = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    expect(repeated.id).toBe(first.id);
    await writeFile(file, "changed");
    const changed = (await app.inject({ method: "POST", url })).json<LibraryAsset>();
    expect(changed.id).not.toBe(first.id);
    expect(changed).toMatchObject({ saved: true, origin: "workspace" });
    expect((await app.inject({ method: "GET", url: `/library/assets/${changed.id}/content` })).body).toBe("changed");
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/assets/library?path=../outside.png` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/library/assets/missing/save" })).statusCode).toBe(404);
  });

  it("distinguishes canvas reference inputs from materialized assets and standalone nodes", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Art", type: "asset-canvas" } })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject({ method: "GET", url: `${base}/workspace` })).json();
    const boardUrl = `${base}/boards/${workspace.boards[0].id}`;
    const detail = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    detail.board.nodes = [{ id: "image", type: "image", position: { x: 320, y: 0 }, data: { prompt: "Portrait", resolution: "1K", aspectRatio: "1:1", images: [{ type: "library", assetId: asset.id }] } }];
    detail.board.editorLayout.nodes = { image: { x: 320, y: 0 } };
    const saved = await app.inject({ method: "PUT", url: boardUrl, payload: detail });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ id: asset.id, referenceOnly: true, projects: [{ id: project.id }] });

    const asAsset = saved.json<CanvasBoardDetail>();
    asAsset.board.nodes.push({ id: "asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: "image" } });
    asAsset.board.editorLayout.nodes.asset = { x: 0, y: 0 };
    const promoted = await app.inject({ method: "PUT", url: boardUrl, payload: asAsset });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ id: asset.id, origin: "uploaded", referenceOnly: false });
  });

  it("promotes a reference explicitly added to a project", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    expect((await list(app))[0]?.referenceOnly).toBe(true);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const copied = await app.inject({ method: "POST", url: `/projects/${project.id}/library-assets/${asset.id}` });
    expect(copied.statusCode, copied.body).toBe(201);
    expect((await list(app))[0]).toMatchObject({ origin: "uploaded", purpose: "asset", referenceOnly: false });
  });

  it("inserts a local canvas image even when its Library link is stale", async () => {
    const app = await setup();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Design" } })).json();
    await writeFile(path.join(project.workspacePath, "portrait.png"), "local image");
    await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({
      version: 1, assets: { portrait: { name: "portrait.png", path: "portrait.png", libraryAssetId: "missing" } },
    }));
    const inserted = await app.inject({ method: "POST", url: `${base}/documents/${document.document.id}/images`, payload: { assetId: "portrait" } });
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect(inserted.json().document.markdown).toContain("![portrait.png](../../portrait.png)");
    expect(await list(app)).toEqual([]);
  });

  it("promotes a reference inserted into a document and keeps browsing available for a broken canvas", async () => {
    const app = await setup();
    const asset = await upload(app, "reference");
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json<ProjectState>();
    const base = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Design" } })).json();
    const inserted = await app.inject({ method: "POST", url: `${base}/documents/${document.document.id}/images`, payload: { assetId: asset.id } });
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect((await list(app))[0]).toMatchObject({ purpose: "asset", referenceOnly: false, projects: [{ id: project.id }] });
    await writeFile(path.join(project.workspacePath, "canvas", "index.json"), "broken");
    expect((await list(app))[0]?.id).toBe(asset.id);
  });
});
