import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import type { JsonValue, ToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlenderWorkflow } from "../src/daemon/blender-tools.js";
import { blenderStaticReviewViews } from "../src/daemon/blender-production.js";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.js";
import {
  BlenderRunError,
  type BlenderRunInput,
  type BlenderRunResult,
} from "../src/daemon/blender-runner.js";
import {
  activePiToolNames,
  projectPiToolNames,
} from "../src/daemon/agent-tools.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { TripoModelReviews } from "../src/daemon/tripo-model-review.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";
import { model3DFixture } from "./model3d-fixture.js";
import { referencePng } from "./video-reference-png-fixture.js";
import {
  projectFiles,
  inspectProjectSourceBudget,
  transferPath,
  type RuntimeMedia,
} from "../src/daemon/isolated-project-files.js";
import { excludedFromProjectArchive } from "../src/daemon/project-archive.js";
import {
  AutoContinueTools,
  type RecoverableTool,
} from "../src/daemon/agent-auto-continue.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(blendHeader = "BLENDER17-01v0503", technicalChecksPassed = false, projectType: "web-game" | "general" | "interactive-story" | "asset-canvas" = "web-game", gateTripoReview = false) {
  const root = await realpath(
    await temporaryTestDirectory("ohmygame-blender-tools-"),
  );
  const library = new AssetLibrary(root);
  await library.load();
  const projects = new ProjectManager(root, library);
  await projects.load();
  const project = await projects.create("Blender assets", projectType);
  const privateRoot = path.join(root, "blender-jobs", project.id);
  const reviews = new TripoModelReviews(path.dirname(privateRoot), projects, library);
  const id: string = randomUUID();
  const directory = path.join(privateRoot, id),
    outputDirectory = path.join(directory, "output");
  for (const sub of ["output", "inputs", "scripts"])
    await mkdir(path.join(directory, sub), { recursive: true });
  await writeFile(
    path.join(project.workspacePath, "parts.json"),
    '{"parts":[]}',
  );
  await writeFile(path.join(directory, "inputs/parts.json"), '{"parts":[]}');
  await writeFile(
    path.join(directory, "scripts/pipeline.py"),
    "# Exact executed program\n",
  );
  const bundle = path.join(root, "bundle");
  await mkdir(bundle);
  for (const name of ["pipeline.py", "export_glb.py", "live_preview.py", "static_review.py"])
    await writeFile(path.join(bundle, name), "# bundled\n");
  const buffers = new Map([
    [
      "model.glb",
      await model3DFixture({ rigged: true, clips: ["Idle", "Walk"] }),
    ],
    [
      "scene.blend",
      Buffer.concat([Buffer.from(blendHeader), Buffer.alloc(3 * 1024 * 1024)]),
    ],
    [
      "report.json",
      Buffer.from(JSON.stringify({ technicalChecksPassed, humanReview: "pending" })),
    ],
  ]);
  for (const [name, bytes] of buffers)
    await writeFile(path.join(outputDirectory, name), bytes);
  const retained: BlenderRunResult = {
    id,
    directory,
    outputDirectory,
    log: "local fixture",
    files: [...buffers].map(([name, bytes]) => ({
      path: name,
      size: bytes.length,
    })),
  };
  const runner = {
    status: vi.fn(async () => ({
      available: true,
      executable: "/Applications/Blender.app/Contents/MacOS/Blender",
    })),
    run: vi.fn(async (input: BlenderRunInput) => {
      if (input.bundledScripts?.entry === "script.py")
        await writeFile(path.join(directory, "scripts/script.py"), input.bundledScripts.files["script.py"]!);
      if (input.bundledScripts?.files["static_review.py"])
        await writeFile(path.join(directory, "scripts/static_review.py"), input.bundledScripts.files["static_review.py"]);
      if (input.sourceOriginal)
        await writeFile(path.join(directory, "source-original.json"), JSON.stringify(input.sourceOriginal));
      if (input.workflowRequest)
        await writeFile(path.join(directory, "workflow.json"), JSON.stringify(input.workflowRequest));
      if (input.invocation)
        await writeFile(path.join(directory, "invocation.json"), JSON.stringify(input.invocation));
      return retained;
    }),
    readJob: vi.fn(async (requested: string) => {
      if (requested !== id) throw new Error("Unknown retained run");
      return retained;
    }),
    inspectJob: vi.fn(async () => ({
      id,
      status: "completed" as "completed" | "failed" | "interrupted",
      log: "local fixture",
    })),
  };
  const bindModel = vi.spyOn(projects, "ensureLibraryAsset");
  const enabled = vi.fn(() => true);
  const canvas = new CanvasStore(projects, library, {} as never);
  const presentReview = vi.fn(
    async (review: {
      runId: string;
      workflow: string;
      stage: string;
      boardId?: string;
      files: { path: string; nodeId: string }[];
    }) => canvas.presentLocalAssets(project.id, review.files.map(file => ({
      ...file, title: `${review.workflow} · ${review.stage} · ${path.basename(file.path)}`,
    })), review.boardId),
  );
  const workflow = new BlenderWorkflow({
    workspace: project.workspacePath,
    privateRoot,
    runner,
    resolveSourceAsset: (assetId, signal) => projects.blenderModelSource(project.id, assetId, signal),
    ...(gateTripoReview ? {
      requireTripoApproval: (assetId, sha256) => reviews.requireApproval(project.id, assetId, sha256),
      checkTripoInputPaths: (paths, signal) => reviews.checkDeclaredPaths(project.id, paths, signal),
    } : {}),
    enabled,
    bundledScriptsDirectory: bundle,
    mutate: (operation) => operation(),
    presentReview,
  });
  const guard = new AutoContinueTools(workflow.tools());
  const guardedTools = guard.wrap();
  const context = {
    sessionManager: { getSessionFile: () => path.join(root, "session.jsonl") },
  };
  const call = (
    name: string,
    args: unknown,
    callId: string = randomUUID(),
    signal?: AbortSignal,
  ) =>
    workflow
      .tools()
      .find((tool) => tool.name === name)!
      .execute(callId, args as never, signal, undefined, {} as never);
  const guardedCall = (name: string, args: unknown, callId: string) =>
    guardedTools
      .find((tool) => tool.name === name)!
      .execute(callId, args as never, undefined, undefined, context as never);
  return {
    root,
    library,
    project,
    projects,
    directory,
    outputDirectory,
    retained,
    runner,
    call,
    guardedCall,
    guard,
    context,
    workflow,
    enabled,
    bindModel,
    canvas,
    presentReview,
    buffers,
  };
}

type BlenderFixture = Awaited<ReturnType<typeof fixture>>;

const characterBrief = {
  goal: "Deliver the short-haired traveler from the concept sheet with an idle and walking animation.",
  route: "existing",
  visualCriteria: ["Keep the wide boots and the short, pointed haircut."],
  requireRig: true, requireTextures: true, requiredClips: ["Idle", "Walk"], maxTriangles: 10,
};
const views = ["front.png", "side.png", "back.png"];
const visualReview = { views, observations: "The short hair silhouette and wide boots remain distinct in all three views." };
const heroStage = { workflow: "hero", stage: "export", configPath: "parts.json", sourcePath: "source.glb", brief: characterBrief };
const staticPass = { verdict: "pass", notes: "Compared the original and candidate surfaces under the same camera and light." };
const staticReview = { silhouette: staticPass, normals: staticPass, sharpEdges: staticPass, textures: staticPass };

async function putOutput(f: BlenderFixture, name: string, bytes: Buffer) {
  await writeFile(path.join(f.outputDirectory, name), bytes);
  const output = f.retained.files.find(file => file.path === name);
  if (output) output.size = bytes.length;
  else f.retained.files.push({ path: name, size: bytes.length });
}

async function exportFixture(technicalChecksPassed = true) {
  const f = await fixture(undefined, technicalChecksPassed);
  const model = f.buffers.get("model.glb")!;
  await writeFile(path.join(f.project.workspacePath, "source.glb"), model);
  await writeFile(path.join(f.directory, "inputs", "source.glb"), model);
  await putOutput(f, "report.json", Buffer.from(JSON.stringify({
    stage: "export", technicalChecksPassed, checks: { roundtrip: { passed: technicalChecksPassed } },
  })));
  return f;
}

async function writeViews(f: BlenderFixture, names = views) {
  for (const [index, name] of names.entries())
    await putOutput(f, name, referencePng({ width: 128 + index }));
}

describe("controlled Blender project tools", () => {
  it("snapshots the bound original again when exporting its retained Tripo scene", async () => {
    const f = await exportFixture();
    const original = Buffer.from("; FBX 7.4.0 project file\n; synthetic retained model");
    const generation = { model: "fixture", protocol: "tripo-v3", parameters: {} };
    const asset = await f.library.add("character.fbx", original, { origin: "generated", modelPreview: f.buffers.get("model.glb")!, generation,
      model3d: { triangles: 1, rigged: false, textured: false, animations: [], generation } });
    const bound = await f.projects.materializeLibraryAsset(f.project.id, asset.id);
    await f.call("run_blender", {
      workflow: "hero", stage: "inspect", configPath: "parts.json", sourceAssetId: asset.id,
      brief: { ...characterBrief, route: "tripo" },
    });
    const scene = `assets/blender/hero/runs/${f.retained.id}/scene.blend`;
    const stage = { workflow: "hero", stage: "export", configPath: "parts.json", sourcePath: scene };
    f.runner.run.mockRejectedValueOnce(new BlenderRunError("Offline fixture captured the export inputs"));
    await expect(f.call("run_blender", stage)).rejects.toThrow("Offline fixture captured the export inputs");
    const invoked = f.runner.run.mock.calls[1]![0];
    const originalName = `source-${asset.id}.fbx`;
    expect(invoked.args).toEqual(["--stage", "export", "--config", "parts.json", "--input", scene, "--static-review-source", originalName]);
    expect(invoked.boundSource).toEqual({
      path: originalName, bytes: original, sha256: createHash("sha256").update(original).digest("hex"),
    });
    expect(invoked.workflowRequest).toMatchObject({ brief: { route: "tripo" } });
    expect(invoked.bundledScripts?.files).toHaveProperty("static_review.py");
    f.runner.run.mockRejectedValueOnce(new BlenderRunError("Offline fixture captured the static-review inputs"));
    await expect(f.call("run_blender", { ...stage, stage: "static-review" })).rejects.toThrow("Offline fixture captured the static-review inputs");
    const staticJob = f.runner.run.mock.calls[2]![0];
    expect(staticJob.args).toEqual(["--stage", "static-review", "--config", "parts.json", "--input", scene, "--static-review-source", originalName]);
    expect(staticJob.bundledExport).toBeUndefined();
    expect(staticJob.boundSource).toEqual(invoked.boundSource);
    await writeFile(path.join(f.project.workspacePath, bound.path), Buffer.from("altered"));
    await expect(f.call("run_blender", stage)).rejects.toThrow(/differs from its bound original/);
    expect(f.runner.run).toHaveBeenCalledTimes(3);
  });

  it.each(["missing report", "wrong original", "reported regression", "lost shading", "rebaked normals", "passed", "legacy final"] as const)(
    "uses the exact static evidence for a Tripo final (%s)", async scenario => {
      const f = await exportFixture();
      const sourceSha256 = "a".repeat(64);
      const legacy = scenario === "legacy final";
      await writeViews(f, [...views, ...blenderStaticReviewViews]);
      await writeFile(path.join(f.directory, "workflow.json"), JSON.stringify({
        ...heroStage, brief: { ...characterBrief, route: "tripo" }, reviewPresentation: "internal",
      }));
      await writeFile(path.join(f.directory, "source-original.json"), JSON.stringify({
        assetId: randomUUID(), sha256: sourceSha256, format: "fbx",
      }));
      if (!legacy)
        await writeFile(path.join(f.directory, "scripts/static_review.py"), "# retained review renderer\n");
      if (legacy) {
        const board = (await f.canvas.workspace(f.project.id)).boards[0]!;
        await writeFile(path.join(f.directory, "canvas-review.json"), JSON.stringify({
          boardId: board.id, reviewPresentation: "final", visualReview,
        }));
      } else if (scenario !== "missing report") {
        const rebaked = scenario === "rebaked normals";
        const lostShading = scenario === "lost shading" || rebaked;
        await putOutput(f, "static-review.json", Buffer.from(JSON.stringify({
          sourceSha256: scenario === "wrong original" ? "b".repeat(64) : sourceSha256,
          views: blenderStaticReviewViews,
          candidateArtifact: "model.glb",
          source: { triangles: 300, customNormalMeshes: 1, sharpEdges: 100, normalMaps: 0, normalMappedTriangles: 0 },
          candidate: { triangles: 10, customNormalMeshes: lostShading ? 0 : 1, sharpEdges: lostShading ? 0 : 55,
            normalMaps: rebaked ? 1 : 0, normalMappedTriangles: rebaked ? 10 : 0 },
          repairIssues: [],
        })));
      }
      const request = { runId: f.retained.id, reviewPresentation: "final" };
      if (scenario === "passed") {
        const unreviewed = (await f.call("recover_blender_run", { ...request, visualReview })).details!.blender;
        expect(unreviewed).toMatchObject({ presentationIssue: expect.stringContaining("Open all four paired static review renders") });
        expect(f.presentReview).not.toHaveBeenCalled();
      }
      const review = {
        views: [...views, ...blenderStaticReviewViews],
        observations: visualReview.observations,
        staticReview: scenario === "reported regression"
          ? { ...staticReview, silhouette: { verdict: "regressed", notes: "The rounded face has visible facets." } }
          : staticReview,
      };
      const input = { ...request, ...(legacy ? {} : { visualReview: review }) };
      const tool = f.workflow.tools().find(item => item.name === "recover_blender_run")!;
      const callId = "present-checked-run";
      const submission = { type: "toolCall", name: "recover_blender_run", id: callId, arguments: input };
      const productionPath = `assets/blender/hero/runs/${f.retained.id}`;
      const opens = blenderStaticReviewViews.map((name, index) => ({
        type: "toolCall", name: "read", id: `view-${index}`, arguments: { path: `${productionPath}/${name}` },
      }));
      const reads = await Promise.all(blenderStaticReviewViews.map(async (name, index) => ({
        role: "toolResult", toolName: "read", toolCallId: opens[index]!.id, isError: false,
        content: [{ type: "image", mimeType: "image/png", data: (await readFile(path.join(f.outputDirectory, name))).toString("base64") }],
      })));
      const assess = (messages: unknown[]) => tool.execute(callId, input as never, undefined, undefined, {
        sessionManager: { getBranch: () => messages.map(message => ({ type: "message", message })) },
      } as never);
      if (scenario === "passed") {
        const unviewed = await assess([{ role: "assistant", content: [...opens, submission] }, ...reads]);
        expect(unviewed.details!.blender).toMatchObject({ presentationIssue: expect.stringContaining("then make a separate final presentation call") });
        const staleReads = [{ ...reads[0]!, content: reads[1]!.content }, ...reads.slice(1)];
        const stale = await assess([{ role: "assistant", content: opens }, ...staleReads, { role: "assistant", content: [submission] }]);
        expect(stale.details!.blender).toMatchObject({ presentationIssue: expect.stringContaining("then make a separate final presentation call") });
        expect(f.presentReview).not.toHaveBeenCalled();
      }
      const result = (await assess([{ role: "assistant", content: opens }, ...reads, { role: "assistant", content: [submission] }])).details!.blender;
      if (scenario === "passed" || scenario === "rebaked normals" || legacy) {
        expect(result).toMatchObject({ review: "pending-human-review", presentedOnCanvas: true });
        expect(f.presentReview).toHaveBeenCalledOnce();
        expect(await f.call("recover_blender_run", { runId: f.retained.id })).toMatchObject({ details: { blender: result } });
      } else {
        const expected = scenario === "reported regression" ? "visible regression in silhouette"
          : scenario === "lost shading" ? "lost all authored normals and marked sharp edges"
          : "Regenerate the static review report";
        expect(result).toMatchObject({ review: "pending-agent-review", technicalChecksPassed: true,
          staticReviewIssue: expect.stringContaining(expected), presentationIssue: expect.stringContaining(expected) });
        expect(f.presentReview).not.toHaveBeenCalled();
        expect(f.bindModel).not.toHaveBeenCalled();
      }
      expect(f.runner.run).not.toHaveBeenCalled();
    },
  );

  it.each(["web-game", "general", "interactive-story", "asset-canvas"] as const)("hands off the bound original FBX and its digest for %s without using its triangulated preview", async (type) => {
    const { library, project, projects, call, runner, buffers, directory } = await fixture(undefined, false, type);
    const original = Buffer.from("; FBX 7.4.0 project file\n; synthetic retained model");
    const preview = buffers.get("model.glb")!;
    const generation = { model: "fixture", protocol: "tripo-v3", parameters: {} };
    const asset = await library.add("character.fbx", original, { origin: "generated", modelPreview: preview, generation,
      model3d: { triangles: 1, rigged: false, textured: false, animations: [], generation } });
    const bound = await projects.materializeLibraryAsset(project.id, asset.id);
    expect(bound.path.startsWith(".data/model-assets/")).toBe(type !== "asset-canvas");
    const request = { workflow: "character", stage: "clean", configPath: "parts.json", brief: { ...characterBrief, route: "tripo" }, sourceAssetId: asset.id };
    await expect(call("run_blender", { ...request, sourcePath: bound.path })).rejects.toThrow(/sourceAssetId or sourcePath/);
    await call("run_blender", request);
    const started = runner.run.mock.calls[0]![0];
    expect(started.bundledExport).toBeUndefined();
    expect(started.boundSource?.bytes.equals(original)).toBe(true);
    expect(started.args).toContain(`source-${asset.id}.fbx`);
    const sha256 = createHash("sha256").update(original).digest("hex");
    expect(JSON.parse(await readFile(path.join(directory, "source-original.json"), "utf8"))).toEqual({ assetId: asset.id, sha256, format: "fbx" });
    const delivered = path.join(project.workspacePath, "assets/blender/character/runs", path.basename(directory), "run.json");
    expect(JSON.parse(await readFile(delivered, "utf8")).sourceOriginal.sha256).toBe(sha256);
    const restored = await call("recover_blender_run", { runId: path.basename(directory) });
    expect(restored.details).toMatchObject({ blender: { sourceOriginal: { assetId: asset.id, sha256, format: "fbx" } } });
    await writeFile(path.join(project.workspacePath, bound.path), Buffer.from("changed"));
    await expect(call("run_blender", request)).rejects.toThrow(/differs from its bound original/);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("stages a game project's GLB above the private-original threshold instead of its runtime derivative", async () => {
    const { projects, project, library, call, runner } = await fixture();
    const io = new NodeIO();
    const document = await io.readBinary(await model3DFixture({ textured: false }));
    const positions = new Float32Array(180_000 * 3);
    for (let i = 0; i < positions.length; i += 9) { positions[i + 3] = 1; positions[i + 7] = 1; }
    document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.setArray(positions);
    const bytes = Buffer.from(await io.writeBinary(document));
    expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const asset = await library.add("geometry.glb", bytes, { origin: "uploaded" });
    const bound = await projects.materializeLibraryAsset(project.id, asset.id);
    expect(bound.path).toMatch(/^\.data\/model-assets\//);
    await call("run_blender", { workflow: "geometry", stage: "clean", sourceAssetId: asset.id, configPath: "parts.json", brief: characterBrief });
    expect(runner.run.mock.calls[0]?.[0].boundSource?.bytes.equals(bytes)).toBe(true);
  });

  it("requires user approval of the retained Tripo original before starting Blender", async () => {
    const { root, library, project, projects, call, guardedCall, guard, runner, buffers } = await fixture(undefined, false, "asset-canvas", true);
    const preview = buffers.get("model.glb")!;
    const generated = async (name: string, change: string, modelPreview?: Buffer) => {
      const original = Buffer.from(`; FBX 7.4.0 project file\n; ${change}`);
      const generation = { protocol: "tripo-v3", parameters: {} };
      const asset = await library.add(name, original, { origin: "generated", modelPreview, generation,
        model3d: { triangles: 1, rigged: false, textured: false, animations: [], generation } });
      return { asset, original, bound: await projects.materializeLibraryAsset(project.id, asset.id) };
    };
    const first = await generated("character.fbx", "first version", preview);
    const request = { workflow: "character", stage: "clean", configPath: "parts.json", brief: { ...characterBrief, route: "tripo" }, sourceAssetId: first.asset.id };
    const pathRequest = { ...request, sourceAssetId: undefined, brief: characterBrief, sourcePath: `./${first.bound.modelPreviewPath}` };
    const reviews = () => new TripoModelReviews(path.join(root, "blender-jobs"), projects, library);
    let deny: (decision: "deny") => void = () => { throw new Error("Missing review"); };
    const ask = vi.fn(() => new Promise<"deny">(resolve => { deny = resolve; }));
    const pending = reviews().review(project.id, first.asset.id, ask);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      assetId: first.asset.id, fbx: true, previewSha256: createHash("sha256").update(preview).digest("hex"),
    })));
    await expect(guardedCall("run_blender", request, "before-review")).rejects.toThrow(/Blender did not start/);
    expect(guard.stopRequested).toBe(false);
    await expect(call("run_blender", pathRequest)).rejects.toThrow(/Blender did not start/);
    deny("deny");
    expect(await pending).toBe("changes-requested");
    await expect(call("run_blender", request)).rejects.toThrow(/Blender did not start/);
    expect(runner.run).not.toHaveBeenCalled();

    const unavailable = await generated("unavailable.fbx", "no preview");
    const never = vi.fn();
    expect(await reviews().review(project.id, unavailable.asset.id, never)).toBe("preview-unavailable");
    expect(never).not.toHaveBeenCalled();
    const reviewed = await generated("character-revised.fbx", "revised version", preview);
    expect(await reviews().review(project.id, reviewed.asset.id, async () => "allow")).toBe("approved");
    expect(await reviews().review(project.id, reviewed.asset.id, never)).toBe("approved");
    expect(never).not.toHaveBeenCalled();
    await expect(call("run_blender", request)).rejects.toThrow(/Blender did not start/);
    await guardedCall("run_blender", { ...request, sourceAssetId: reviewed.asset.id }, "after-review");
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run.mock.calls[0]![0].boundSource?.bytes.equals(reviewed.original)).toBe(true);
  });

  it("refuses an unbound asset, a non-Tripo source claimed as Tripo, and a private caller path", async () => {
    const { library, project, projects, call, runner, buffers } = await fixture();
    const asset = await library.add("unrelated.glb", buffers.get("model.glb")!, { origin: "uploaded" });
    const other = await projects.create("Other project", "general");
    await projects.materializeLibraryAsset(other.id, asset.id);
    const request = { workflow: "character", stage: "clean", configPath: "parts.json", brief: { ...characterBrief, route: "tripo" }, sourceAssetId: asset.id };
    await expect(call("run_blender", request)).rejects.toThrow(/bound to this project/);
    await projects.materializeLibraryAsset(project.id, asset.id);
    await expect(call("run_blender", request)).rejects.toThrow(/Tripo generation provenance/);
    await expect(call("run_blender", { ...request, sourceAssetId: undefined, sourcePath: ".data/private.glb" })).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
    await call("run_blender", { ...request, brief: characterBrief });
    expect(runner.run.mock.calls[0]?.[0].boundSource?.bytes.equals(buffers.get("model.glb")!)).toBe(true);
  });

  it("keeps intermediate work available for Agent inspection and promotes the same checked run for final user review", async () => {
    const f = await exportFixture();
    await writeViews(f, [...views, "pose-1.png", "pose-2.png"]);
    const internal = (await f.call("run_blender", heroStage)).details!.blender;
    expect(internal).toMatchObject({
      reviewPresentation: "internal", review: "pending-agent-review", technicalChecksPassed: true,
      models: [{ originalPath: expect.stringContaining("assets/blender/hero/"), model: { animations: ["Idle", "Walk"] } }],
    });
    expect(internal).not.toHaveProperty("canvas");
    expect(internal).not.toHaveProperty("models.0.assetId");
    expect((await f.call("recover_blender_run", { runId: f.retained.id })).details!.blender).toEqual(internal);
    expect((await f.canvas.workspace(f.project.id)).assets).toHaveLength(0);
    expect(f.bindModel).not.toHaveBeenCalled();
    expect(f.presentReview).not.toHaveBeenCalled();
    const source = path.join(f.project.workspacePath, (internal as { directory: string }).directory);
    expect(await readFile(path.join(source, "front.png"))).toEqual(referencePng());
    const originalReceipt = await readFile(path.join(source, "run.json"));
    const input = { runId: f.retained.id, reviewPresentation: "final", visualReview };
    const final = (await f.call("recover_blender_run", input)).details!.blender;
    expect(final).toMatchObject({ reviewPresentation: "final", review: "pending-human-review", models: [{ assetId: expect.any(String) }] });
    const { canvas } = final as { canvas: { boardId: string; nodeIds: string[] } };
    expect(canvas.nodeIds).toHaveLength(4);
    expect((await f.canvas.board(f.project.id, canvas.boardId)).board.nodes).toMatchObject([
      { data: { mediaType: "model" } }, ...["front", "side", "back"].map(angle => ({
        title: expect.stringContaining(`${angle}.png`), data: { mediaType: "image" },
      })),
    ]);
    expect((await f.call("recover_blender_run", { runId: f.retained.id })).details!.blender).toEqual(final);
    expect((await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final" })).details!.blender).toEqual(final);
    expect((await f.canvas.board(f.project.id, canvas.boardId)).board.nodes).toHaveLength(4);
    expect(await readFile(path.join(source, "run.json"))).toEqual(originalReceipt);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("matches the original raw invocation on interrupted chat continuation while retaining the internal default", async () => {
    const f = await fixture();
    const input = { workflow: "hero", stage: "parts", configPath: "parts.json" };
    await f.guardedCall("run_blender", input, "original");
    const tool = f.workflow.tools().find(item => item.name === "run_blender") as RecoverableTool;
    const recovered = await tool.recoverAfterHttp500!("original", input, undefined, undefined, f.context as never);
    expect(recovered.details).toMatchObject({ blender: { reviewPresentation: "internal", review: "pending-agent-review" } });
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("settles a lost final presentation response from the exact retained run during automatic continuation", async () => {
    const f = await exportFixture();
    await writeViews(f);
    await f.call("run_blender", heroStage);
    const present = f.presentReview.getMockImplementation()!;
    f.presentReview.mockImplementationOnce(async review => {
      await present(review);
      throw new Error("connection lost after Canvas was saved");
    });
    const request = { runId: f.retained.id, reviewPresentation: "final", visualReview };
    await expect(f.guardedCall("recover_blender_run", request, "show-final")).rejects.toThrow("connection lost");
    await f.guard.prepare(new AbortController().signal);
    const { blender: delivered } = (await f.guardedCall("recover_blender_run", request, "show-final")).details as { blender: unknown };
    const { canvas } = delivered as { canvas: { boardId: string; nodeIds: string[] } };
    expect(delivered).toMatchObject({ reviewPresentation: "final", review: "pending-human-review" });
    expect((await f.canvas.board(f.project.id, canvas.boardId)).board.nodes.map(node => node.id)).toEqual(canvas.nodeIds);
    expect(canvas.nodeIds).toHaveLength(4);
    expect((await f.canvas.workspace(f.project.id)).assets).toHaveLength(4);
    expect(f.runner.run).toHaveBeenCalledOnce();

    f.runner.inspectJob.mockResolvedValue({ id: f.retained.id, status: "interrupted", log: "" });
    const tool = f.workflow.tools().find(item => item.name === "recover_blender_run") as RecoverableTool;
    await expect(tool.recoverAfterHttp500!("show-final", request, undefined, undefined, f.context as never)).rejects.toThrow("still unconfirmed");
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("restores an interrupted final presentation to its chosen board and keeps large pose sets off the final review", async () => {
    const f = await exportFixture();
    await writeViews(f, [...views, "pose1.png", "pose2.png", "pose3.png", "pose4.png"]);
    await f.call("run_blender", heroStage);
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Final asset" });
    const boardId = index.boards.at(-1)!.id;
    f.presentReview.mockRejectedValueOnce(new Error("Canvas is temporarily unavailable"));
    await expect(f.call("recover_blender_run", { runId: f.retained.id, boardId, reviewPresentation: "final", visualReview })).rejects.toThrow("temporarily unavailable");
    const recovered = (await f.call("recover_blender_run", { runId: f.retained.id })).details!.blender;
    expect(recovered).toMatchObject({ reviewPresentation: "final", canvas: { boardId, nodeIds: expect.arrayContaining([`blender-${f.retained.id}-0`]) } });
    expect((await f.canvas.workspace(f.project.id)).assets).toHaveLength(4);
    expect((await f.canvas.board(f.project.id, boardId)).board.nodes.map(node => node.title)).not.toEqual(expect.arrayContaining([expect.stringContaining("pose")]));
    await expect(f.call("recover_blender_run", {
      runId: f.retained.id, boardId: index.boards[0].id, reviewPresentation: "final",
    })).rejects.toThrow("original Blender review board changed");
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it.each(["failed report", "no model", "ambiguous model"])("keeps an unpresentable final candidate with the Agent (%s)", async issue => {
    const f = await exportFixture(issue !== "failed report");
    if (issue === "no model") f.retained.files = f.retained.files.filter(file => file.path !== "model.glb");
    if (issue === "ambiguous model") {
      const model = f.buffers.get("model.glb")!;
      await writeFile(path.join(f.outputDirectory, "other.glb"), model);
      f.retained.files.push({ path: "other.glb", size: model.length });
    }
    await writeViews(f);
    const input = heroStage;
    await expect(f.call("run_blender", { ...input, reviewPresentation: "final" })).rejects.toThrow("Invalid Blender workflow arguments");
    await f.call("run_blender", input);
    const blocked = (await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview })).details!.blender;
    expect(blocked).toMatchObject({
      review: "pending-agent-review", next: expect.stringContaining(issue === "failed report" ? "failed technical checks" : "exactly one"),
    });
    expect(blocked).not.toHaveProperty("canvas");
    expect(f.bindModel).not.toHaveBeenCalled();
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("keeps a GLB with no technical report available for inspection without promoting it", async () => {
    const f = await exportFixture();
    f.retained.files = f.retained.files.filter(file => file.path !== "report.json");
    await writeViews(f);
    const internal = (await f.call("run_blender", heroStage)).details!.blender;
    expect(internal).toMatchObject({ review: "pending-agent-review", models: [{ originalPath: expect.stringContaining("model.glb") }] });
    const candidate = (await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview })).details!.blender;
    expect(candidate).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.any(String) });
    expect(candidate).not.toHaveProperty("canvas");
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.library.list()).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it.each(["parts", "custom"])("keeps a %s stage internal even when its own report claims export success", async stage => {
    const f = await exportFixture();
    await writeViews(f);
    await writeFile(path.join(f.project.workspacePath, "build.py"), "# models a character");
    await f.call("run_blender", {
      stage, workflow: "hero", brief: { ...characterBrief, route: "procedural" },
      ...(stage === "custom" ? { scriptPath: "build.py" } : { configPath: "parts.json" }),
    });
    const result = (await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview })).details!.blender;
    expect(result).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.stringMatching(/export/i) });
    expect(result).not.toHaveProperty("canvas");
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it.each([
    { stage: "export", checks: {} },
    { stage: "export", checks: { roundtrip: { passed: false } } },
    { stage: "rig", checks: { roundtrip: { passed: true } } },
  ])("requires a successful reimport from the export report before final delivery (%j)", async report => {
    const f = await exportFixture();
    await writeViews(f);
    await putOutput(f, "report.json", Buffer.from(JSON.stringify({ ...report, technicalChecksPassed: true })));
    await f.call("run_blender", heroStage);
    const result = (await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview })).details!.blender;
    expect(result).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.stringMatching(/round.?trip|reimport/i) });
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("restores legacy checkpoints and previously published finals without manufacturing a new final from an unchecked run", async () => {
    const f = await fixture(undefined, true);
    const request = { workflow: "old-hero", stage: "parts", configPath: "parts.json" };
    await writeFile(path.join(f.directory, "invocation.json"), JSON.stringify({ callId: "old", request }));
    const input = { runId: f.retained.id };
    const legacy = (await f.call("recover_blender_run", input)).details!.blender as { directory: string; canvas: { boardId: string; nodeIds: string[] } };
    expect(legacy).toMatchObject({ reviewPresentation: "checkpoint", review: "pending-human-review" });
    const source = path.join(f.project.workspacePath, legacy.directory, "run.json");
    const bytes = await readFile(source);
    expect(JSON.parse(bytes.toString())).toMatchObject({ request, review: "pending-human-review" });
    expect(JSON.parse(bytes.toString()).request).not.toHaveProperty("reviewPresentation");
    expect(JSON.parse(await readFile(path.join(f.directory, "canvas-review.json"), "utf8"))).toEqual({ boardId: legacy.canvas.boardId });
    const blocked = (await f.call("recover_blender_run", { ...input, reviewPresentation: "final" })).details!.blender;
    expect(blocked).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.any(String) });
    expect((await f.call("recover_blender_run", input)).details!.blender).toEqual(legacy);

    // This is the historical receipt after that legacy release had already shown the final.
    await writeFile(path.join(f.directory, "canvas-review.json"), JSON.stringify({ boardId: legacy.canvas.boardId, reviewPresentation: "final" }));
    const final = (await f.call("recover_blender_run", input)).details!.blender;
    expect(final).toMatchObject({ canvas: legacy.canvas, reviewPresentation: "final", review: "pending-human-review" });
    expect((await f.call("recover_blender_run", input)).details!.blender).toEqual(final);
    expect((await f.call("recover_blender_run", { ...input, reviewPresentation: "checkpoint" })).details!.blender).toEqual(final);
    expect(await readFile(source)).toEqual(bytes);
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it.each([
    { defect: "required clip", model: { rigged: true, clips: ["Idle", "Run"] }, reason: /Walk/i },
    { defect: "missing skin", model: { rigged: false, clips: ["Idle", "Walk"] }, reason: /rig|skin/i },
    { defect: "missing texture", model: { rigged: true, textured: false, clips: ["Idle", "Walk"] }, reason: /textur/i },
    { defect: "triangle budget", model: { rigged: true, clips: ["Idle", "Walk"] }, reason: /triangle/i },
    { defect: "missing editable scene", model: { rigged: true, clips: ["Idle", "Walk"] }, reason: /blend|editable/i },
  ])("checks the exported model against the original character brief ($defect)", async ({ defect, model, reason }) => {
    const f = await exportFixture();
    let bytes = await model3DFixture(model);
    if (defect === "triangle budget") {
      const io = new NodeIO();
      const document = await io.readBinary(bytes);
      const mesh = document.getRoot().listMeshes()[0]!;
      mesh.addPrimitive(mesh.listPrimitives()[0]!.clone());
      bytes = Buffer.from(await io.writeBinary(document));
    }
    if (defect === "missing editable scene") f.retained.files = f.retained.files.filter(file => file.path !== "scene.blend");
    await putOutput(f, "model.glb", bytes);
    await writeViews(f);
    await f.call("run_blender", { ...heroStage, brief: { ...characterBrief, maxTriangles: 1 } });
    if (defect === "required clip") {
      await expect(f.call("recover_blender_run", {
        runId: f.retained.id, reviewPresentation: "final", visualReview,
        brief: { ...characterBrief, requiredClips: ["Idle", "Run"] },
      })).rejects.toThrow();
    }
    const result = (await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview })).details!.blender;
    expect(result).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.stringMatching(reason) });
    expect(result).not.toHaveProperty("canvas");
    expect(f.presentReview).not.toHaveBeenCalled();
    expect(f.library.list()).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("accepts a static flat-colour prop after review of its own views without character-only requirements", async () => {
    const f = await exportFixture();
    await putOutput(f, "model.glb", await model3DFixture({ textured: false }));
    await writeViews(f);
    const brief = { route: "existing", goal: "Finish a static, flat-colour roadside sign.", visualCriteria: ["Retain the wedge-shaped outline."] };
    await f.call("run_blender", { ...heroStage, workflow: "sign", brief });
    const request = { runId: f.retained.id, reviewPresentation: "final" };
    for (const review of [undefined, { ...visualReview, views: ["other-run-front.png"] }]) {
      const unreviewed = (await f.call("recover_blender_run", { ...request, ...(review ? { visualReview: review } : {}) })).details!.blender;
      expect(unreviewed).toMatchObject({ review: "pending-agent-review", presentationIssue: expect.stringMatching(/review|view|render|image/i) });
      expect(f.presentReview).not.toHaveBeenCalled();
    }
    const final = (await f.call("recover_blender_run", {
      ...request, visualReview: { views: ["front.png"], observations: "The sign retains the pointed wedge silhouette in the front view." },
    })).details!.blender;
    expect(final).toMatchObject({ review: "pending-human-review", models: [{ assetId: expect.any(String), model: { rigged: false, textured: false, animations: [] } }] });
    expect((await f.call("recover_blender_run", request)).details!.blender).toEqual(final);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("keeps the requested watertight requirement when an export uses the default topology policy", async () => {
    const f = await exportFixture();
    await writeViews(f);
    await putOutput(f, "report.json", Buffer.from(JSON.stringify({
      stage: "export", technicalChecksPassed: true,
      checks: { roundtrip: { passed: true }, topology: { policy: "inspect", boundaryEdges: 4 } },
    })));
    const exported = await f.call("run_blender", { ...heroStage, brief: { ...characterBrief, topologyPolicy: "watertight" } });
    expect(exported.details!.blender).toMatchObject({ deliveryIssue: expect.stringContaining("watertight") });
    const recovered = await f.call("recover_blender_run", { runId: f.retained.id, reviewPresentation: "final", visualReview });
    expect(recovered.details!.blender).toMatchObject({ presentationIssue: expect.stringContaining("watertight") });
    expect(f.presentReview).not.toHaveBeenCalled();
  });

  it("keeps a candidate out of the Library when its requested final board was deleted", async () => {
    const f = await exportFixture();
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Temporary board" });
    const deleted = index.boards.at(-1)!.id;
    await f.canvas.changeBoards(f.project.id, { type: "delete", boardId: deleted });
    await writeViews(f);
    await f.call("run_blender", heroStage);
    await expect(f.call("recover_blender_run", {
      runId: f.retained.id, reviewPresentation: "final", visualReview, boardId: deleted,
    })).rejects.toThrow("Canvas board not found");
    expect(f.library.list()).toHaveLength(0);
    expect(f.bindModel).not.toHaveBeenCalled();
    expect((await f.call("recover_blender_run", { runId: f.retained.id })).details!.blender)
      .toMatchObject({ review: "pending-agent-review", reviewPresentation: "internal" });
  });

  it("keeps a missing script correctable without launching or replaying a Blender job", async () => {
    const f = await fixture();
    const input = { workflow: "hero", stage: "custom", scriptPath: "missing.py" };
    await expect(f.guardedCall("run_blender", input, "missing-script")).rejects.toThrow("ENOENT");
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.guard.recoverySummary).toContain("not_executed (invalid_blender_input)");
    await f.guard.prepare(new AbortController().signal);
    await writeFile(path.join(f.project.workspacePath, "missing.py"), "# corrected local script");
    await expect(f.guardedCall("run_blender", input, "missing-script")).rejects.toThrow("ENOENT");
    expect(f.runner.run).not.toHaveBeenCalled();
    await f.guardedCall("run_blender", input, "corrected-script");
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  function scriptBatch(f: BlenderFixture) {
    const sessionManager = SessionManager.inMemory(f.project.workspacePath);
    const tools = [...createLocalAgentFileTools(f.project.workspacePath), ...f.workflow.tools()];
    const guard = new AutoContinueTools(tools);
    const guarded = guard.wrap();
    const begin = (...content: ToolCall[]) => sessionManager.appendMessage({
      role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "fixture",
      stopReason: "toolUse", timestamp: Date.now(), content,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const execute = async (call: ToolCall, signal?: AbortSignal) => {
      const tool = guarded.find(tool => tool.name === call.name)!;
      const receipt = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, timestamp: Date.now() };
      try {
        const result = await tool.execute(call.id, call.arguments, signal, undefined, { sessionManager } as never);
        sessionManager.appendMessage({ ...receipt, content: result.content, details: result.details as JsonValue, isError: false });
        return result;
      } catch (error) {
        sessionManager.appendMessage({ ...receipt, isError: true, content: [{ type: "text", text: String(error) }] });
        throw error;
      }
    };
    const toolCall = (name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id: randomUUID(), name, arguments: args });
    return {
      begin, execute, guard,
      write: (content: string) => toolCall("write", { path: "./scripts/pose.py", content }),
      edit: (oldText: string, newText: string) => toolCall("edit", { path: "scripts/pose.py", edits: [{ oldText, newText }] }),
      run: () => toolCall("run_blender", { workflow: "hero", stage: "custom", scriptPath: "scripts/pose.py" }),
    };
  }

  it("saves a new custom script in the run and stages exactly those saved bytes", async () => {
    const f = await fixture();
    const scriptPath = "scripts/new-pose.py";
    const content = "# new pose\n";
    const input = { workflow: "hero", stage: "custom", scriptPath, save: { content }, releaseReviewedImages: true };
    const delivered = await f.guardedCall("run_blender", input, "save-and-run");
    expect(await readFile(path.join(f.project.workspacePath, scriptPath), "utf8")).toBe(content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    expect(delivered.details).toMatchObject({ projectFileVersion: { path: scriptPath, sha256 }, executedScriptSha256: sha256 });
    expect(f.runner.run.mock.calls[0]![0].bundledScripts?.files["script.py"]).toBe(content);
    expect(f.runner.run.mock.calls[0]![0].workflowRequest).not.toHaveProperty("save");
    expect(f.runner.run.mock.calls[0]![0].invocation?.request).toEqual(input);
    expect((await f.guardedCall("run_blender", input, "save-and-run")).details).toEqual(delivered.details);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("applies only exact edits and binds the saved configuration to bundled execution", async () => {
    const f = await fixture();
    const configPath = "parts.json";
    const original = '{"size":1}';
    await writeFile(path.join(f.project.workspacePath, configPath), original);
    const edit = (oldText: string) => ({ workflow: "hero", stage: "parts", configPath, save: { edits: [{ oldText, newText: "2" }] } });
    await expect(f.call("run_blender", edit("missing"))).rejects.toThrow("oldText");
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.project.workspacePath, configPath), "utf8")).toBe(original);
    const updated = original.replace("1", "2");
    const run = f.runner.run.getMockImplementation()!;
    f.runner.run.mockImplementationOnce(async input => {
      await writeFile(path.join(f.directory, "inputs", configPath),
        await readFile(path.join(f.project.workspacePath, configPath)));
      return run(input);
    });
    const delivered = await f.call("run_blender", edit("1"));
    expect(await readFile(path.join(f.project.workspacePath, configPath), "utf8")).toBe(updated);
    const sha256 = createHash("sha256").update(updated).digest("hex");
    expect(delivered.details).toMatchObject({ projectFileVersion: { path: configPath, sha256 } });
    expect(f.runner.run.mock.calls[0]![0]).toMatchObject({
      inputs: [configPath], expectedInputSha256: { [configPath]: sha256 }, bundledScripts: { entry: "pipeline.py" },
    });
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("reports a retained save when Blender cannot start, without replaying the save", async () => {
    const f = await fixture();
    f.runner.run.mockRejectedValueOnce(new BlenderRunError("Blender is unavailable"));
    const scriptPath = "scripts/retained.py";
    const content = "# retained on startup failure";
    const input = { workflow: "hero", stage: "custom", scriptPath, save: { content } };
    const saved = await f.guardedCall("run_blender", input, "save-before-startup-failure");
    expect(saved.details).toMatchObject({
      blender: { status: "saved-not-run", message: expect.stringContaining("Blender is unavailable") },
      projectFileVersion: { path: scriptPath },
    });
    expect(await readFile(path.join(f.project.workspacePath, scriptPath), "utf8")).toBe(content);
    await f.guardedCall("run_blender", input, "save-before-startup-failure");
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("stages exactly the final successful Pi save and retains the original run ID across a retry", async () => {
    const f = await fixture();
    const b = scriptBatch(f);
    const initial = "\ufeff# first\n";
    const written = b.write(initial), edited = b.edit("first", "second"), run = b.run();
    b.begin(written, edited, run);
    await b.execute(written);
    await b.execute(edited);
    const result = await b.execute(run);
    expect(result.details).toMatchObject({ blender: { runId: f.retained.id, review: "pending-agent-review" } });
    expect(f.runner.run.mock.calls[0]![0].bundledScripts?.files["script.py"]).toBe(initial.replace("first", "second"));
    expect(result.details).toMatchObject({ executedScriptSha256: createHash("sha256").update(initial.replace("first", "second")).digest("hex") });
    await b.guard.prepare(new AbortController().signal);
    expect((await b.execute(run)).details).toEqual(result.details);
    const identical = b.write(initial.replace("first", "second")), duplicate = b.run();
    b.begin(identical, duplicate);
    await b.execute(identical);
    expect((await b.execute(duplicate)).details).toEqual(result.details);
    const failed = b.edit("missing", "typo"), blocked = b.run();
    b.begin(failed, blocked);
    await expect(b.execute(failed)).rejects.toThrow("oldText");
    await expect(b.execute(blocked)).rejects.toThrow("Save the script successfully");
    expect(f.runner.run).toHaveBeenCalledOnce();
    const newer = b.edit("second", "third"), revised = b.run();
    b.begin(newer, revised);
    await b.execute(newer);
    const second = await fixture();
    f.runner.run.mockImplementationOnce(input => second.runner.run(input));
    expect((await b.execute(revised)).details).toMatchObject({ blender: { runId: second.retained.id } });
    expect(f.runner.run.mock.calls[1]![0].bundledScripts?.files["script.py"]).toBe(initial.replace("first", "third"));
  });

  it("does not launch old code after an absent, failed, reordered, cancelled or externally superseded save", async () => {
    const f = await fixture();
    const b = scriptBatch(f);
    const old = b.write("# old");
    b.begin(old);
    await b.execute(old);
    const save = b.edit("old", "new"), fail = b.edit("missing", "replacement"), run = b.run();
    b.begin(save, fail, run);
    await b.execute(save);
    await expect(b.execute(fail)).rejects.toThrow("oldText");
    await expect(b.execute(run)).rejects.toThrow("Save the script successfully");
    const reversed = b.run();
    b.begin(reversed, b.edit("new", "last"));
    await expect(b.execute(reversed)).rejects.toThrow("Save the script successfully");
    const missing = b.run();
    b.begin(b.write("# pending"), missing);
    await expect(b.execute(missing)).rejects.toThrow("Save the script successfully");
    const replaced = b.edit("new", "saved"), cancelled = b.run(), superseded = b.run();
    b.begin(replaced, cancelled, superseded);
    await b.execute(replaced);
    await expect(b.execute(cancelled, AbortSignal.abort())).rejects.toThrow();
    await writeFile(path.join(f.project.workspacePath, "scripts/pose.py"), "# concurrent external save");
    await expect(b.execute(superseded)).rejects.toThrow("changed before execution");
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the original default review board after reordering (missing receipt=%s)", async missingReceipt => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json", reviewPresentation: "checkpoint" });
    const original = (response.details!.blender as { canvas: { boardId: string } }).canvas.boardId;
    expect(JSON.parse(await readFile(path.join(f.directory, "canvas-review.json"), "utf8"))).toEqual({ boardId: original });
    if (missingReceipt) await rm(path.join(f.directory, "canvas-review.json"));
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Other board" });
    const other = index.boards.at(-1)!.id;
    if (missingReceipt) await expect(f.call("recover_blender_run", {
      runId: f.retained.id, boardId: other, reviewPresentation: "checkpoint",
    })).rejects.toThrow("original Blender review board changed");
    await f.canvas.changeBoards(f.project.id, { type: "move", boardId: other, direction: -1 });
    const recovered = await f.call("recover_blender_run", { runId: f.retained.id });
    expect(recovered.details!.blender).toMatchObject({ canvas: { boardId: original } });
    expect((await f.canvas.board(f.project.id, original)).board.nodes).toHaveLength(1);
    expect((await f.canvas.board(f.project.id, other)).board.nodes).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("does not redirect a retained review after its original board is deleted", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json", reviewPresentation: "checkpoint" });
    const original = (response.details!.blender as { canvas: { boardId: string } }).canvas.boardId;
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Other board" });
    const other = index.boards.at(-1)!.id;
    await f.canvas.changeBoards(f.project.id, { type: "delete", boardId: original });
    await expect(f.call("recover_blender_run", { runId: f.retained.id })).rejects.toThrow("Canvas board not found");
    expect((await f.canvas.board(f.project.id, other)).board.nodes).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("preserves a user's replacement model instead of claiming the original review was restored", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json", reviewPresentation: "checkpoint" });
    const original = (response.details!.blender as { canvas: { boardId: string } }).canvas.boardId;
    await writeFile(path.join(f.project.workspacePath, "other.glb"), f.buffers.get("model.glb")!);
    const replacement = await f.projects.ensureLibraryAsset(f.project.id, "other.glb");
    const detail = await f.canvas.board(f.project.id, original);
    expect(detail.board.nodes[0].type).toBe("asset");
    if (detail.board.nodes[0].type !== "asset") throw new Error("Expected a review asset");
    expect(replacement).not.toBe(detail.board.nodes[0].data.assetId);
    detail.board.nodes[0].data.assetId = replacement;
    await f.canvas.saveBoard(f.project.id, detail.board, detail.revision);
    await expect(f.call("recover_blender_run", { runId: f.retained.id })).rejects.toThrow("changed its asset or type");
    expect((await f.canvas.board(f.project.id, original)).board.nodes).toMatchObject([{ data: { assetId: replacement } }]);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("refuses ambiguous review placement when a delivery receipt is missing", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json", reviewPresentation: "checkpoint" });
    const original = (response.details!.blender as { canvas: { boardId: string } }).canvas.boardId;
    await rm(path.join(f.directory, "canvas-review.json"));
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Copied review" });
    const other = await f.canvas.board(f.project.id, index.boards.at(-1)!.id);
    const source = await f.canvas.board(f.project.id, original);
    other.board.nodes = structuredClone(source.board.nodes);
    other.board.editorLayout.nodes = structuredClone(source.board.editorLayout.nodes);
    await f.canvas.saveBoard(f.project.id, other.board, other.revision);
    await expect(f.call("recover_blender_run", { runId: f.retained.id })).rejects.toThrow("multiple boards");
    expect((await f.canvas.board(f.project.id, original)).board.nodes).toHaveLength(1);
    expect((await f.canvas.board(f.project.id, other.board.id)).board.nodes).toHaveLength(1);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("publishes a requested checkpoint model to Canvas and recovers without replacing user edits", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
      reviewPresentation: "checkpoint",
    });
    const delivery = response.details!.blender as {
      canvas: { boardId: string; nodeIds: string[] };
    };
    const checkpoint = { runId: f.retained.id, boardId: delivery.canvas.boardId, reviewPresentation: "checkpoint" };
    await expect(f.call("recover_blender_run", { ...checkpoint, visualReview })).rejects.toThrow(/visualReview is only valid for final.*omit visualReview.*same runId/);
    await expect(f.call("recover_blender_run", { runId: checkpoint.runId, boardId: checkpoint.boardId })).rejects.toThrow(/Select a reviewPresentation.*boardId/);
    expect(f.runner.inspectJob).not.toHaveBeenCalled();
    expect((await f.call("recover_blender_run", checkpoint)).details!.blender).toMatchObject({ reviewPresentation: "checkpoint", canvas: delivery.canvas });
    expect(delivery.canvas.nodeIds).toEqual([`blender-${f.retained.id}-0`]);
    const detail = await f.canvas.board(f.project.id, delivery.canvas.boardId);
    expect(detail.board.nodes).toHaveLength(1);
    expect(detail.board.nodes[0]).toMatchObject({
      type: "asset",
      data: { mediaType: "model" },
    });
    detail.board.nodes[0].title = "My accepted candidate title";
    await f.canvas.saveBoard(f.project.id, detail.board, detail.revision);
    await f.call("recover_blender_run", { runId: f.retained.id });
    const recovered = await f.canvas.board(
      f.project.id,
      delivery.canvas.boardId,
    );
    expect(recovered.board.nodes).toHaveLength(1);
    expect(recovered.board.nodes[0].title).toBe("My accepted candidate title");
    const workspace = await f.canvas.workspace(f.project.id);
    expect(workspace.assets[0]).toMatchObject({
      mediaType: "model",
      canvasOnly: true,
    });
    expect(
      await readFile(
        path.join(f.project.workspacePath, workspace.assets[0].path),
      ),
    ).toEqual(f.buffers.get("model.glb"));
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("recovers Canvas publication failure on the original chosen board without rerunning", async () => {
    const f = await fixture();
    f.presentReview.mockRejectedValueOnce(
      new Error("Canvas write interrupted"),
    );
    const index = await f.canvas.changeBoards(f.project.id, {
      type: "create",
      name: "3D review",
    });
    const boardId = index.boards.at(-1)!.id;
    await expect(
      f.call("run_blender", {
        workflow: "hero",
        stage: "parts",
        configPath: "parts.json",
        reviewPresentation: "checkpoint",
        boardId,
      }),
    ).rejects.toThrow("is retained");
    const output = await f.call("recover_blender_run", {
      runId: f.retained.id,
    });
    expect(output.details!.blender).toMatchObject({ canvas: { boardId } });
    expect(
      (await f.canvas.board(f.project.id, boardId)).board.nodes,
    ).toHaveLength(1);
    expect(
      (await f.canvas.board(f.project.id, index.boards[0].id)).board.nodes,
    ).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });
  it.each([false, true])("publishes exact outputs, executed sources and a recoverable project model binding (desktop=%s)", async desktop => {
    vi.stubEnv("OHMYGAME_BLENDER_WINDOW_IPC", desktop ? "1" : undefined);
    const f = await fixture();
    if (desktop) Object.assign(f.retained, { liveView: { shown: true, updates: 3 } }); // A retained run from an older app.
    expect((await f.call("blender_status", {})).details!.blender).not.toHaveProperty("liveWorkWindow");
    const input = {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
      reviewPresentation: "checkpoint",
    };
    const output = await f.guardedCall("run_blender", input, "same-call");
    const data = (output.details as { blender: unknown }).blender as {
      runId: string;
      directory: string;
      technicalChecksPassed: boolean;
      review: string;
      models: Array<{ assetId: string; originalPath: string }>;
    };
    expect(data).toMatchObject({
      runId: f.retained.id,
      technicalChecksPassed: false,
      review: "checkpoint-presented",
    });
    expect(data).not.toHaveProperty("liveView");
    expect(f.runner.run.mock.calls[0]![0]).not.toHaveProperty("liveView");
    expect(f.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: ["parts.json"],
        args: ["--stage", "parts", "--config", "parts.json"],
        bundledScripts: {
          entry: "pipeline.py",
          files: {
            "pipeline.py": "# bundled\n",
            "export_glb.py": "# bundled\n",
            "live_preview.py": "# bundled\n",
          },
        },
      }),
      undefined,
    );
    for (const [name, bytes] of f.buffers)
      expect(
        await readFile(
          path.join(f.project.workspacePath, data.directory, name),
        ),
      ).toEqual(bytes);
    expect(
      await readFile(
        path.join(
          f.project.workspacePath,
          data.directory,
          "recipe/pipeline.py",
        ),
        "utf8",
      ),
    ).toBe("# Exact executed program\n");
    expect(
      await readFile(
        path.join(
          f.project.workspacePath,
          data.directory,
          "recipe/config.json",
        ),
        "utf8",
      ),
    ).toBe('{"parts":[]}');
    const resources = await f.projects.modelAssetResources(f.project.id, {
      assetId: data.models[0]!.assetId,
    });
    expect(resources).toMatchObject({
      ready: true,
      model: { animations: ["Idle", "Walk"] },
    });
    const runtime = resources as { runtimePath: string };
    const media: RuntimeMedia[] = [];
    const transferred = await projectFiles(f.project.workspacePath, media);
    expect(
      transferred.every((file) => !file.path.startsWith(data.directory)),
    ).toBe(true);
    expect(media.some((file) => file.path === runtime.runtimePath)).toBe(true);
    expect(
      (await inspectProjectSourceBudget(f.project.workspacePath)).overage
        .fileBytes,
    ).toBe(0);
    expect(() => transferPath(`${data.directory}/model.glb`)).toThrow(
      "get_model_asset",
    );
    expect(excludedFromProjectArchive(`${data.directory}/scene.blend`)).toBe(
      false,
    );
    expect(
      (await f.guardedCall("run_blender", input, "same-call")).details,
    ).toEqual(output.details);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(
      await f.call("recover_blender_run", { runId: f.retained.id }),
    ).toEqual(output);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
  });

  it("retains completed results after a binding failure and recovers without another Blender run", async () => {
    const f = await fixture();
    f.bindModel.mockRejectedValueOnce(
      new Error("Library temporarily unavailable"),
    );
    await expect(
      f.call("run_blender", {
        workflow: "crate",
        stage: "parts",
        configPath: "parts.json",
        reviewPresentation: "checkpoint",
      }),
    ).rejects.toThrow(`run ${f.retained.id} is retained`);
    const recovered = await f.call("recover_blender_run", {
      runId: f.retained.id,
    });
    expect(recovered.details!.blender).toMatchObject({ runId: f.retained.id });
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("stages custom Python with fixed bundled helpers and preserves each executed source", async () => {
    const f = await fixture();
    const custom = "import pipeline\nimport export_glb\nimport live_preview\n# project refinement\n";
    await writeFile(path.join(f.project.workspacePath, "pipeline.py"), custom);
    f.runner.run.mockImplementationOnce(async (input) => {
      expect(input).not.toHaveProperty("scriptPath");
      expect(input.bundledExport).toBeUndefined();
      expect(input.bundledScripts).toEqual({
        entry: "script.py",
        files: {
          "pipeline.py": "# bundled\n",
          "export_glb.py": "# bundled\n",
          "live_preview.py": "# bundled\n",
          "script.py": custom,
        },
      });
      for (const [name, content] of Object.entries(input.bundledScripts!.files))
        await writeFile(path.join(f.directory, "scripts", name), content);
      return f.retained;
    });
    const response = await f.call("run_blender", {
      workflow: "refined-hero",
      stage: "custom",
      scriptPath: "pipeline.py",
      configPath: "parts.json",
    });
    const { directory } = response.details!.blender as { directory: string };
    for (const [name, content] of [
      ["script.py", custom],
      ["pipeline.py", "# bundled\n"],
      ["export_glb.py", "# bundled\n"],
      ["live_preview.py", "# bundled\n"],
    ])
      expect(
        await readFile(
          path.join(f.project.workspacePath, directory, "recipe", name),
          "utf8",
        ),
      ).toBe(content);
  });

  it("preserves edited result files and refuses recovery to overwrite them", async () => {
    const f = await fixture();
    const output = await f.call("run_blender", {
      workflow: "crate",
      stage: "parts",
      configPath: "parts.json",
    });
    const directory = (output.details!.blender as { directory: string })
      .directory;
    const file = path.join(f.project.workspacePath, directory, "report.json");
    await writeFile(file, '{"manualNote":"keep me"}');
    await expect(
      f.call("recover_blender_run", { runId: f.retained.id }),
    ).rejects.toThrow("Preserving an edited Blender result");
    expect(await readFile(file, "utf8")).toBe('{"manualNote":"keep me"}');
  });

  it("rejects invalid configuration and private, linked or outside inputs before execution", async () => {
    const f = await fixture();
    await symlink(
      path.join(f.project.workspacePath, "parts.json"),
      path.join(f.project.workspacePath, "linked.json"),
    );
    for (const args of [
      { workflow: "../bad", stage: "parts", configPath: "parts.json" },
      { workflow: "crate", stage: "parts" },
      { workflow: "crate", stage: "custom", configPath: "parts.json" },
      { workflow: "crate", stage: "rig", configPath: "parts.json" },
      { workflow: "crate", stage: "parts", configPath: "../outside.json" },
      { workflow: "crate", stage: "parts", configPath: ".data/private.json" },
      { workflow: "crate", stage: "parts", configPath: "linked.json" },
      {
        workflow: "crate",
        stage: "parts",
        configPath: "parts.json",
        executable: "/bin/sh",
      },
    ])
      await expect(f.call("run_blender", args)).rejects.toThrow();
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("rejects invalid model output atomically and never binds a partial delivery", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.outputDirectory, "model.glb"),
      Buffer.alloc(f.buffers.get("model.glb")!.length),
    );
    await expect(
      f.call("run_blender", {
        workflow: "broken",
        stage: "parts",
        configPath: "parts.json",
      }),
    ).rejects.toThrow("is retained");
    expect(f.bindModel).not.toHaveBeenCalled();
    expect(
      await readdir(path.join(f.project.workspacePath, "assets/blender")).catch(
        () => [],
      ),
    ).toEqual([]);
  });

  it("does not publish failed or cancelled execution", async () => {
    const f = await fixture();
    f.runner.run.mockRejectedValueOnce(
      new BlenderRunError("cancelled", f.retained.id),
    );
    await expect(
      f.call("run_blender", {
        workflow: "cancelled",
        stage: "parts",
        configPath: "parts.json",
      }),
    ).rejects.toThrow(f.retained.id);
    f.runner.readJob.mockRejectedValueOnce(
      new BlenderRunError("No successful result", f.retained.id),
    );
    await expect(
      f.call("recover_blender_run", { runId: f.retained.id }),
    ).rejects.toThrow("No successful result");
    expect(f.bindModel).not.toHaveBeenCalled();
    const cancelled = AbortSignal.abort();
    await expect(
      f.call(
        "run_blender",
        { workflow: "cancelled", stage: "parts", configPath: "parts.json" },
        "cancelled-before-start",
        cancelled,
      ),
    ).rejects.toThrow();
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("returns retained failure diagnostics without publishing partial output", async () => {
    const f = await fixture();
    f.runner.inspectJob.mockResolvedValueOnce({
      id: f.retained.id,
      status: "failed",
      log: "Script failed at the rig stage",
    });
    expect(
      (await f.call("recover_blender_run", { runId: f.retained.id })).details!
        .blender,
    ).toMatchObject({
      status: "failed",
      published: false,
      log: "Script failed at the rig stage",
    });
    expect(f.runner.readJob).not.toHaveBeenCalled();
    expect(f.bindModel).not.toHaveBeenCalled();
  });

  it("settles a failed script, never replays its call, and permits corrected work after continuation", async () => {
    const f = await fixture();
    f.runner.run.mockRejectedValueOnce(
      new BlenderRunError("Blender exited with code 2", f.retained.id),
    );
    f.runner.inspectJob.mockResolvedValue({
      id: f.retained.id,
      status: "failed",
      log: "argparse: required input missing",
    });
    const input = {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
    };
    const failed = await f.guardedCall("run_blender", input, "original");
    expect(failed).toMatchObject({
      isError: true,
      details: { blender: { status: "failed", published: false } },
    });
    expect(f.bindModel).not.toHaveBeenCalled();
    await f.guard.prepare(new AbortController().signal);
    expect(await f.guardedCall("run_blender", input, "original")).toMatchObject(
      { isError: true },
    );
    expect(f.runner.run).toHaveBeenCalledOnce();
    await writeFile(
      path.join(f.project.workspacePath, "parts.json"),
      '{"parts":[],"corrected":true}',
    );
    await f.guardedCall("run_blender", input, "corrected");
    expect(f.runner.run).toHaveBeenCalledTimes(2);
  });

  it("recovers only the original conversation call after delivery fails, without restarting Blender", async () => {
    const f = await fixture();
    f.runner.run.mockImplementationOnce(async (input) => {
      await writeFile(
        path.join(f.directory, "invocation.json"),
        JSON.stringify(input.invocation),
      );
      return f.retained;
    });
    f.bindModel.mockRejectedValueOnce(new Error("binding interrupted"));
    const input = {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
      reviewPresentation: "checkpoint",
    };
    await expect(
      f.guardedCall("run_blender", input, "original"),
    ).rejects.toThrow("is retained");
    await f.guard.prepare(new AbortController().signal);
    expect(f.runner.run).toHaveBeenCalledOnce();
    const output = await f.guardedCall("run_blender", input, "original");
    expect((output.details as { blender: unknown }).blender).toMatchObject({
      runId: f.retained.id,
      workflow: "hero",
    });
    const tool = f.workflow
      .tools()
      .find((tool) => tool.name === "run_blender") as RecoverableTool;
    await expect(
      tool.recoverAfterHttp500!("original", input, undefined, undefined, {
        sessionManager: { getSessionFile: () => "another-session" },
      } as never),
    ).rejects.toThrow("could not be identified");
    await expect(
      tool.recoverAfterHttp500!(
        "original",
        { ...input, workflow: "other" },
        undefined,
        undefined,
        f.context as never,
      ),
    ).rejects.toThrow("could not be identified");
    f.runner.inspectJob.mockResolvedValue({
      id: f.retained.id,
      status: "interrupted",
      log: "",
    });
    await expect(
      tool.recoverAfterHttp500!(
        "original",
        input,
        undefined,
        undefined,
        f.context as never,
      ),
    ).rejects.toThrow("still unconfirmed");
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("does not share a call-ID cache across fresh conversation wrappers", async () => {
    const f = await fixture();
    await f.guardedCall(
      "run_blender",
      { workflow: "first", stage: "parts", configPath: "parts.json" },
      "tool_0",
    );
    f.runner.run.mockRejectedValueOnce(
      new Error("Second conversation reached Blender"),
    );
    await expect(
      f.call(
        "run_blender",
        { workflow: "second", stage: "parts", configPath: "parts.json" },
        "tool_0",
      ),
    ).rejects.toThrow("Second conversation reached Blender");
    expect(f.runner.run).toHaveBeenCalledTimes(2);
  });

  it("refuses non-Blender editable output before delivery", async () => {
    const f = await fixture();
    const bytes = Buffer.from(f.buffers.get("scene.blend")!);
    bytes[0] = 0xc2; // ASCII decoding would mask this to 'B'; the binary signature must be exact.
    await writeFile(path.join(f.outputDirectory, "scene.blend"), bytes);
    await expect(
      f.call("run_blender", {
        workflow: "invalid-source",
        stage: "parts",
        configPath: "parts.json",
      }),
    ).rejects.toThrow("Save editable Blender sources uncompressed");
    expect(f.bindModel).not.toHaveBeenCalled();
  });

  it("retains legacy Blender headers alongside the current 17-byte format", async () => {
    const f = await fixture("BLENDER-v405");
    const response = await f.call("run_blender", {
      workflow: "legacy",
      stage: "parts",
      configPath: "parts.json",
    });
    expect(response.details!.blender).toMatchObject({ runId: f.retained.id });
  });

  it("rejects compressed, truncated and unknown modern Blender headers", async () => {
    for (const header of [
      "BLENDER",
      "BLENDER17-01v050",
      "BLENDER16-01v0503",
      "BLENDER17-02v0503",
      "BLENDER17-01V0503",
      "\x1f\x8b",
      "\x28\xb5\x2f\xfd",
    ]) {
      const f = await fixture(header);
      await expect(
        f.call("run_blender", {
          workflow: "bad-header",
          stage: "parts",
          configPath: "parts.json",
        }),
      ).rejects.toThrow("Save editable Blender sources uncompressed");
      expect(f.bindModel).not.toHaveBeenCalled();
    }
  });

  it("exposes only read-only Blender status while planning", async () => {
    const f = await fixture();
    const names = ["blender_status", "run_blender", "recover_blender_run"];
    expect(activePiToolNames([], names)).toEqual(expect.arrayContaining(names));
    const planning = projectPiToolNames("planning", [], names);
    expect(planning).toContain("blender_status");
    expect(planning).not.toContain("run_blender");
    expect(planning).not.toContain("recover_blender_run");
    expect((await f.call("blender_status", {})).details!.blender).toMatchObject(
      { available: true, retainedRunIds: [f.retained.id] },
    );
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("respects disabled workflow settings, including a stale registered tool", async () => {
    const f = await fixture();
    const stale = f.workflow
      .tools()
      .find((tool) => tool.name === "run_blender")!;
    f.enabled.mockReturnValue(false);
    expect(f.workflow.tools().map((tool) => tool.name)).toEqual([
      "blender_status",
    ]);
    expect((await f.call("blender_status", {})).details!.blender).toMatchObject(
      { available: false, workflowEnabled: false },
    );
    await expect(
      stale.execute(
        "disabled",
        { workflow: "crate", stage: "parts", configPath: "parts.json" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Enable the bundled Blender");
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("carries the retained scene's brief and exact digest into the next stage", async () => {
    const f = await exportFixture();
    const parentId = randomUUID();
    const parentDirectory = path.join(path.dirname(f.directory), parentId);
    const parentOutput = path.join(parentDirectory, "output");
    const sourcePath = `assets/blender/hero/runs/${parentId}/scene.blend`;
    const source = path.join(f.project.workspacePath, sourcePath);
    const bytes = f.buffers.get("scene.blend")!;
    await mkdir(parentOutput, { recursive: true });
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(path.join(parentOutput, "scene.blend"), bytes);
    await writeFile(path.join(parentDirectory, "workflow.json"), JSON.stringify({ ...heroStage, stage: "rig" }));
    const childJob = f.runner.readJob.getMockImplementation()!;
    f.runner.readJob.mockImplementation(async id => id === parentId
      ? { id, directory: parentDirectory, outputDirectory: parentOutput, log: "", files: [{ path: "scene.blend", size: bytes.length }] }
      : childJob(id));
    const request = { workflow: "hero", stage: "export", sourcePath, configPath: "parts.json" };
    await expect(f.call("run_blender", { ...request, brief: { ...characterBrief, requiredClips: [] } })).rejects.toThrow(/different production brief/i);
    await expect(f.call("run_blender", { ...request, stage: "parts" })).rejects.toThrow(/parts|source/i);
    expect(f.runner.run).not.toHaveBeenCalled();

    const result = (await f.call("run_blender", request)).details!.blender;
    expect(result).toMatchObject({ brief: characterBrief, review: "pending-agent-review" });
    expect(f.runner.run.mock.calls[0]![0]).toMatchObject({
      bundledExport: true,
      workflowRequest: { ...request, brief: characterBrief }, expectedInputSha256: { [sourcePath]: createHash("sha256").update(bytes).digest("hex") },
    });
    expect((await f.call("recover_blender_run", { runId: f.retained.id })).details!.blender).toEqual(result);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("refuses a mismatched start route or a parts stage that would ignore the supplied source", async () => {
    const f = await exportFixture();
    for (const request of [
      { ...heroStage, brief: { ...characterBrief, route: "tripo" } },
      { ...heroStage, brief: { ...characterBrief, route: "procedural" } },
      { workflow: "hero", stage: "parts", configPath: "parts.json", brief: characterBrief },
      { workflow: "hero", stage: "parts", configPath: "parts.json", sourcePath: "source.glb" },
    ]) await expect(f.call("run_blender", request)).rejects.toThrow(/Tripo|procedural|source|parts/i);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.presentReview).not.toHaveBeenCalled();
  });
});
