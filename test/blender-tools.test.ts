import { randomUUID } from "node:crypto";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlenderWorkflow } from "../src/daemon/blender-tools.js";
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
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";
import { model3DFixture } from "./model3d-fixture.js";
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

async function fixture(blendHeader = "BLENDER17-01v0503") {
  const root = await realpath(
    await temporaryTestDirectory("ohmygame-blender-tools-"),
  );
  const library = new AssetLibrary(root);
  await library.load();
  const projects = new ProjectManager(root, library);
  await projects.load();
  const project = await projects.create("Blender assets", "web-game");
  const privateRoot = path.join(root, "blender-jobs", project.id);
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
  for (const name of ["pipeline.py", "export_glb.py", "live_preview.py"])
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
      Buffer.from('{"technicalChecksPassed":false,"humanReview":"pending"}'),
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
    run: vi.fn(async (_input: BlenderRunInput) => retained),
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
  const bindModel = vi.fn((file: string) =>
    projects.ensureLibraryAsset(project.id, file),
  );
  const enabled = vi.fn(() => true);
  const canvas = new CanvasStore(projects, library, {} as never);
  const presentReview = vi.fn(
    async (review: {
      runId: string;
      workflow: string;
      stage: string;
      boardId?: string;
      files: string[];
    }) => {
      const entries = [];
      for (const [index, file] of review.files.entries())
        entries.push({
          nodeId: `blender-${review.runId}-${index}`,
          assetId: await projects.ensureLibraryAsset(project.id, file),
          title: `${review.workflow} · ${review.stage} · ${path.basename(file)}`,
        });
      return canvas.presentLocalAssets(project.id, entries, review.boardId);
    },
  );
  const workflow = new BlenderWorkflow({
    workspace: project.workspacePath,
    privateRoot,
    runner,
    enabled,
    bundledScriptsDirectory: bundle,
    mutate: (operation) => operation(),
    bindModel,
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

describe("controlled Blender project tools", () => {
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

  it.each([false, true])("keeps the original default review board after reordering (missing receipt=%s)", async missingReceipt => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json" });
    const original = (response.details!.blender as { canvas: { boardId: string } }).canvas.boardId;
    expect(JSON.parse(await readFile(path.join(f.directory, "canvas-review.json"), "utf8"))).toEqual({ boardId: original });
    if (missingReceipt) await rm(path.join(f.directory, "canvas-review.json"));
    const index = await f.canvas.changeBoards(f.project.id, { type: "create", name: "Other board" });
    const other = index.boards.at(-1)!.id;
    await f.canvas.changeBoards(f.project.id, { type: "move", boardId: other, direction: -1 });
    const recovered = await f.call("recover_blender_run", { runId: f.retained.id });
    expect(recovered.details!.blender).toMatchObject({ canvas: { boardId: original } });
    expect((await f.canvas.board(f.project.id, original)).board.nodes).toHaveLength(1);
    expect((await f.canvas.board(f.project.id, other)).board.nodes).toHaveLength(0);
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("does not redirect a retained review after its original board is deleted", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json" });
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
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json" });
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
    const response = await f.call("run_blender", { workflow: "hero", stage: "parts", configPath: "parts.json" });
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

  it("automatically publishes a stage model to Canvas and recovers without replacing user edits", async () => {
    const f = await fixture();
    const response = await f.call("run_blender", {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
    });
    const delivery = response.details!.blender as {
      canvas: { boardId: string; nodeIds: string[] };
    };
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
    if (desktop) f.retained.liveView = { shown: true, updates: 3 };
    expect((await f.call("blender_status", {})).details!.blender).toMatchObject({ liveWorkWindow: desktop });
    const input = {
      workflow: "hero",
      stage: "parts",
      configPath: "parts.json",
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
      review: "pending-human-review",
    });
    if (desktop) expect(data).toMatchObject({ liveView: { shown: true, updates: 3 } });
    else expect(data).not.toHaveProperty("liveView");
    expect(f.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        liveView: desktop,
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
});
