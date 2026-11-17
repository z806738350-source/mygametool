import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  BlenderRunError,
  type BlenderRunner,
  type BlenderRunResult,
} from "./blender-runner.js";
import { CanvasError } from "./canvas-files.js";
import { writeAtomically } from "./checkpoint-objects.js";
import { localAgentPath } from "./agent-local-files.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { inspectModel3D } from "./model3d-inspect.js";
import { isFbxArtifact } from "./fbx-preview.js";
import { validateRasterReturn } from "./isolated-raster-returns.js";
import {
  confirmBlenderRunFailure,
  toolPreflightError,
} from "./agent-tool-errors.js";
import type { RecoverableTool } from "./agent-auto-continue.js";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const stages = [
  "parts",
  "clean",
  "joints",
  "rig",
  "animate",
  "export",
  "custom",
] as const;
const boardIdParameter = Type.Optional(Type.String({
  pattern: "^[a-zA-Z0-9_-]{1,100}$",
  description: "Canvas board for user review; use the current board when known.",
}));
const checkpointPresentation = Type.Literal("checkpoint", { description: "Show progress the user requested or a concrete decision the Agent needs from them." });
const finalPresentation = Type.Literal("final", { description: "Show the inspected, delivery-ready model for the user's final decision." });
const recoverParameters = Type.Object({
  runId: Type.String({ pattern: UUID.source }),
  reviewPresentation: Type.Optional(Type.Union([checkpointPresentation, finalPresentation])),
  boardId: boardIdParameter,
}, { additionalProperties: false });
const canvasReviewReceipt = Type.Object({
  boardId: boardIdParameter,
  requestedBoardId: boardIdParameter,
  reviewPresentation: Type.Optional(Type.Union([checkpointPresentation, finalPresentation])),
});
const runParameters = Type.Object(
  {
    workflow: Type.String({
      pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Stable asset/workflow name, such as village-crate or hero.",
    }),
    stage: Type.Union([
      Type.Literal("parts"),
      Type.Literal("clean"),
      Type.Literal("joints"),
      Type.Literal("rig"),
      Type.Literal("animate"),
      Type.Literal("export"),
      Type.Literal("custom"),
    ]),
    configPath: Type.Optional(
      Type.String({
        maxLength: 240,
        description:
          "Project-relative JSON configuration. Required for bundled stages.",
      }),
    ),
    sourcePath: Type.Optional(
      Type.String({
        maxLength: 240,
        description: "Preserved project GLB or preceding stage's scene.blend.",
      }),
    ),
    scriptPath: Type.Optional(
      Type.String({
        maxLength: 240,
        description:
          "Project Python script, only for custom. Parse arguments AFTER sys.argv's '--' separator: --input-dir, --output-dir, optional --input and --config. Input paths retain project subdirectories; open Path(args.input_dir) / args.input, not glob('*.blend').",
      }),
    ),
    inputs: Type.Optional(
      Type.Array(Type.String({ maxLength: 240 }), {
        maxItems: 30,
        description:
          "Additional project files the script needs. Unlisted files are inaccessible.",
      }),
    ),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
    reviewPresentation: Type.Optional(Type.Union([
      Type.Literal("internal", { description: "Default. Retain files for the Agent to inspect and refine." }),
      checkpointPresentation,
    ])),
    boardId: boardIdParameter,
  },
  { additionalProperties: false },
);
type RunRequest = Static<typeof runParameters>;
type RecoveryRequest = Static<typeof recoverParameters>;
type Runner = Pick<BlenderRunner, "run" | "status" | "readJob" | "inspectJob">;
type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

export interface BlenderToolsOptions {
  workspace: string;
  privateRoot: string;
  bundledScriptsDirectory: string;
  runner: Runner;
  enabled?: () => boolean;
  mutate: Mutate;
  touch?: () => Promise<unknown>;
  presentReview?: (review: {
    runId: string;
    workflow: string;
    stage: string;
    boardId?: string;
    files: { path: string; nodeId: string }[];
  }) => Promise<{ boardId: string; nodeIds: string[]; assetsByPath: Record<string, string> }>;
}

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: { blender: value },
});

/** Project-bound jobs retain editable sources; publication never replaces an earlier run. */
export class BlenderWorkflow {
  constructor(private readonly options: BlenderToolsOptions) {}

  tools() {
    const recover = (input: unknown, signal?: AbortSignal, requireTerminal = false) => this.options.mutate(async () => {
      signal?.throwIfAborted();
      this.#assertEnabled();
      if (!Check(recoverParameters, input) || (input.boardId && !input.reviewPresentation))
        throw toolPreflightError("Use a retained Blender run ID and select a presentation when specifying a board.", "invalid_blender_input");
      return this.#recover(input.runId, signal, requireTerminal, input);
    });
    return [
      defineTool({
        name: "blender_status",
        label: "Check Blender",
        description:
          "Check the local controlled Blender capability and list retained run IDs. No Blender process or model request is started.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async (_id, _input, signal) => {
          signal?.throwIfAborted();
          const entries = await readdir(this.options.privateRoot).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            },
          );
          const status = await this.options.runner.status();
          const workflowEnabled = this.options.enabled?.() !== false;
          return result({
            ...status,
            workflowEnabled,
            liveWorkWindow: process.env.OHMYGAME_BLENDER_WINDOW_IPC === "1",
            available: status.available && workflowEnabled,
            ...(!workflowEnabled
              ? {
                  reason:
                    "Enable the bundled Blender plugin and Blender Assets skill for this project before running stages.",
                }
              : {}),
            retainedRunIds: entries
              .filter((name) => UUID.test(name))
              .slice(-64),
            stages,
            humanReview:
              "The Agent inspects intermediate reports, rendered views and motion, corrects defects, then asks the user for final artistic acceptance. Show intermediate checkpoints for requested progress or a decision that genuinely needs the user.",
          });
        },
      }),
      Object.assign(
        defineTool<typeof runParameters, { blender: unknown }>({
          name: "run_blender",
          label: "Run Blender stage",
          description:
            "Run one reproducible local Blender stage. Read blender-assets and its pipeline reference first. Use Tripo only for a needed initial organic mesh. Intermediate runs default to internal: inspect the retained reports and actual renders, fix defects, and continue without interrupting the user. Use recover_blender_run with reviewPresentation=final to show a checked candidate without rerunning; use checkpoint when the user asks to see progress or a specific decision truly needs their input. Custom Python can import bundled pipeline and export_glb helpers and only access declared input snapshots and the private output directory.",
          parameters: runParameters,
          execute: async (callId, input, signal, _update, context) => {
            if (!Check(runParameters, input))
              throw toolPreflightError(
                "Invalid Blender workflow arguments",
                "invalid_blender_input",
              );
            this.#assertEnabled();
            // Session AutoContinueTools owns call replay; IDs may recur in other conversations.
            const sessionFile = context?.sessionManager?.getSessionFile?.();
            return this.options.mutate(() =>
              this.#run(
                { ...input, reviewPresentation: input.reviewPresentation ?? "internal" },
                signal,
                sessionFile
                  ? { callId, sessionFile, request: input }
                  : undefined,
              ),
            );
          },
        }),
        {
          recoverAfterHttp500: async (
            ...call: Parameters<ToolDefinition["execute"]>
          ) => {
            const [callId, input, signal, , context] = call;
            signal?.throwIfAborted();
            this.#assertEnabled();
            const sessionFile = context?.sessionManager?.getSessionFile?.();
            if (!sessionFile)
              throw new Error(
                "The original Blender conversation is unavailable; no replacement was started",
              );
            const matches: string[] = [];
            for (const id of await readdir(this.options.privateRoot)) {
              if (!UUID.test(id)) continue;
              const file = path.join(
                this.options.privateRoot,
                id,
                "invocation.json",
              );
              const bytes = await readSafeProjectFile(
                this.options.privateRoot,
                file,
                64 * 1024,
              ).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return;
                throw error;
              });
              if (!bytes) continue;
              const saved = JSON.parse(bytes.toString("utf8"));
              if (
                saved.callId === callId &&
                saved.sessionFile === sessionFile &&
                isDeepStrictEqual(saved.request, input)
              )
                matches.push(id);
            }
            if (matches.length !== 1)
              throw new Error(
                "The exact original Blender run could not be identified; no replacement was started",
              );
            return this.options.mutate(() =>
              this.#recover(matches[0], signal, true),
            );
          },
        } satisfies Pick<RecoverableTool, "recoverAfterHttp500">,
      ),
      Object.assign(defineTool({
        name: "recover_blender_run",
        label: "Recover Blender result",
        description:
          "Recover a retained Blender run with its recorded review presentation. To present already-inspected files from that exact run on Canvas, explicitly select final for the user's final decision, or checkpoint for a requested preview or a decision requiring the user. This reuses the retained files and never starts Blender again.",
        parameters: recoverParameters,
        execute: (_id, input, signal) => recover(input, signal),
      }), {
        recoverAfterHttp500: (_id, input, signal) => recover(input, signal, true),
      } satisfies Pick<RecoverableTool, "recoverAfterHttp500">),
    ].filter(
      (tool) =>
        tool.name === "blender_status" || this.options.enabled?.() !== false,
    );
  }

  #assertEnabled() {
    if (this.options.enabled?.() === false)
      throw new Error(
        "Enable the bundled Blender plugin and Blender Assets skill for this project before running stages",
      );
  }

  async #recover(runId: string, signal?: AbortSignal, requireTerminal = false, presentation?: RecoveryRequest) {
    signal?.throwIfAborted();
    const diagnostic = await this.options.runner.inspectJob(runId);
    if (diagnostic.status === "failed")
      return confirmBlenderRunFailure(
        {
          ...result({
            runId,
            ...diagnostic,
            published: false,
            next: "This local script has stopped. Inspect its retained log, correct the script or configuration, and use a new call for corrected work. Do not repeat the original call or regenerate the initial model.",
          }),
          isError: true,
        },
        runId,
      );
    if (diagnostic.status !== "completed") {
      if (requireTerminal)
        throw new Error(
          "The original Blender run is still unconfirmed; no replacement was started",
        );
      return result({ runId, ...diagnostic, published: false });
    }
    const run = await this.options.runner.readJob(runId);
    return this.#publish(run, await this.#request(run), signal, presentation);
  }

  async #run(
    input: RunRequest,
    signal?: AbortSignal,
    invocation?: { callId: string; sessionFile: string; request: unknown },
  ) {
    signal?.throwIfAborted();
    if (
      input.stage === "custom"
        ? !input.scriptPath
        : !!input.scriptPath || !input.configPath
    )
      throw toolPreflightError(
        "Custom stages require scriptPath; bundled stages require configPath and do not accept scriptPath",
        "invalid_blender_input",
      );
    if (
      input.stage !== "parts" &&
      input.stage !== "custom" &&
      !input.sourcePath
    )
      throw toolPreflightError(
        "This stage requires the preceding sourcePath",
        "invalid_blender_input",
      );
    if (
      (input.configPath && !input.configPath.endsWith(".json")) ||
      (input.scriptPath && !input.scriptPath.endsWith(".py")) ||
      (input.sourcePath && !/\.(?:glb|blend)$/i.test(input.sourcePath))
    )
      throw toolPreflightError(
        "Use JSON configuration, a Python script, and a GLB or Blender source",
        "invalid_blender_input",
      );
    const inputs = [
      ...new Set(
        [input.configPath, input.sourcePath, ...(input.inputs ?? [])].filter(
          (value): value is string => !!value,
        ),
      ),
    ];
    const files: Record<string, string> = {};
    try {
      for (const filename of [
        ...inputs,
        ...(input.scriptPath ? [input.scriptPath] : []),
      ])
        await localAgentPath(this.options.workspace, filename);
      if (input.scriptPath)
        files["script.py"] = (
          await readSafeProjectFile(
            this.options.workspace,
            await localAgentPath(this.options.workspace, input.scriptPath),
            512 * 1024,
          )
        ).toString("utf8");
    } catch (error) {
      // These reads precede job creation; missing input is correctable, not an unknown run.
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw toolPreflightError((error as Error).message, "invalid_blender_input");
      throw error;
    }
    const args = [
      ...(input.stage === "custom" ? [] : ["--stage", input.stage]),
      ...(input.configPath ? ["--config", input.configPath] : []),
      ...(input.sourcePath ? ["--input", input.sourcePath] : []),
    ];
    for (const name of ["pipeline.py", "export_glb.py", "live_preview.py"])
      files[name] = (
        await readSafeProjectFile(
          this.options.bundledScriptsDirectory,
          path.join(this.options.bundledScriptsDirectory, name),
          512 * 1024,
        )
      ).toString("utf8");
    const bundledScripts = {
      entry: input.scriptPath ? "script.py" : "pipeline.py",
      files,
    };
    let run: BlenderRunResult;
    try {
      run = await this.options.runner.run(
        {
          workspace: this.options.workspace,
          inputs,
          args,
          bundledScripts,
          workflowRequest: input,
          liveView: process.env.OHMYGAME_BLENDER_WINDOW_IPC === "1",
          ...(invocation ? { invocation } : {}),
          ...(input.timeoutSeconds
            ? { timeoutMs: input.timeoutSeconds * 1000 }
            : {}),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof BlenderRunError && error.jobId) {
        const diagnostic = await this.options.runner.inspectJob(error.jobId);
        if (diagnostic.status === "failed")
          return this.#recover(error.jobId, signal);
        throw new Error(
          `${error.message} Retained Blender run: ${error.jobId}. ${error.log}`,
        );
      }
      if (error instanceof BlenderRunError)
        throw toolPreflightError(error.message, "invalid_blender_input");
      throw error;
    }
    try {
      return await this.#publish(run, input, signal);
    } catch (error) {
      throw new Error(
        `Blender run ${run.id} is retained. Use recover_blender_run with this runId to finish delivery. ${error instanceof Error ? error.message : "Delivery failed"}`,
      );
    }
  }

  async #request(run: BlenderRunResult): Promise<RunRequest> {
    try {
      const request: unknown = JSON.parse(
        (
          await readSafeProjectFile(
            run.directory,
            path.join(run.directory, "workflow.json"),
            64 * 1024,
          )
        ).toString("utf8"),
      );
      if (!Check(runParameters, request))
        throw new Error("The retained Blender workflow record is invalid");
      return request;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const invocation = await readSafeProjectFile(
        run.directory,
        path.join(run.directory, "invocation.json"),
        64 * 1024,
      ).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return;
        throw cause;
      });
      if (invocation) {
        const saved = JSON.parse(invocation.toString("utf8"));
        if (!Check(runParameters, saved.request))
          throw new Error("The retained Blender invocation is invalid");
        return saved.request;
      }
      // A crash between completion and metadata persistence must not lose the local result.
      return { workflow: "recovered", stage: "custom" };
    }
  }

  async #publish(
    run: BlenderRunResult,
    request: RunRequest,
    signal?: AbortSignal,
    presentation?: RecoveryRequest,
  ) {
    signal?.throwIfAborted();
    this.#assertEnabled();
    if (!UUID.test(run.id))
      throw new Error("Invalid retained Blender run identity");
    const files = new Map<string, Buffer>(),
      models = [];
    let technicalChecksPassed: boolean | undefined;
    let total = 0;
    for (const file of run.files) {
      if (file.path === "run.json" || file.path.startsWith("recipe/"))
        throw new Error("Blender output uses a reserved delivery path");
      const bytes = await readSafeProjectFile(
        run.outputDirectory,
        await localAgentPath(run.outputDirectory, file.path),
      );
      total += bytes.length;
      if (bytes.length !== file.size || total > 128 * 1024 * 1024)
        throw new Error(
          "Retained Blender output changed or exceeds its delivery budget",
        );
      const extension = path.extname(file.path).toLowerCase();
      if (extension === ".glb")
        models.push({
          file: file.path,
          model: await inspectModel3D(bytes, signal),
        });
      else if (extension === ".json") {
        if (bytes.length > 1024 * 1024)
          throw new Error("Blender reports must fit within 1 MiB");
        const report = JSON.parse(bytes.toString("utf8"));
        if (
          file.path === "report.json" &&
          typeof report?.technicalChecksPassed === "boolean"
        )
          technicalChecksPassed = report.technicalChecksPassed;
      } else if ([".png", ".jpg", ".jpeg"].includes(extension)) {
        await validateRasterReturn(file.path, bytes, undefined, 2, signal);
      } else if (extension === ".blend") {
        // Blender 5+ adds header size 17 and format 01 (BLO_core_blend_header.hh).
        if (
          !/^BLENDER(?:[-_][vV]\d{3}|17-01v\d{4})/.test(
            bytes.subarray(0, 17).toString("latin1"),
          )
        )
          throw new Error(
            "Save editable Blender sources uncompressed before delivery",
          );
      } else if (extension === ".fbx") {
        if (!isFbxArtifact(bytes))
          throw new Error("Invalid Blender FBX output");
      } else throw new Error("Unsupported Blender output format");
      files.set(file.path, bytes);
    }
    // Preserve the exact executed programs and small configuration alongside the editable result.
    for (const name of await readdir(path.join(run.directory, "scripts"))) {
      if (!/^[a-zA-Z0-9_-]+\.py$/.test(name))
        throw new Error("Invalid retained Blender script");
      files.set(
        `recipe/${name}`,
        await readSafeProjectFile(
          run.directory,
          path.join(run.directory, "scripts", name),
          512 * 1024,
        ),
      );
    }
    if (request.configPath)
      files.set(
        "recipe/config.json",
        await readSafeProjectFile(
          run.directory,
          path.join(run.directory, "inputs", request.configPath),
          1024 * 1024,
        ),
      );
    const directory = `assets/blender/${request.workflow}/runs/${run.id}`;
    // A retained request with no mode predates internal review and originally presented every stage.
    const originalPresentation = request.reviewPresentation ?? "checkpoint";
    const receipt = {
      runId: run.id,
      workflow: request.workflow,
      stage: request.stage,
      request,
      outputs: run.files,
      review: originalPresentation === "internal" ? "pending-agent-review" : request.reviewPresentation ? "checkpoint-presented" : "pending-human-review",
      technicalChecksPassed,
      models,
    };
    files.set("run.json", Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
    await this.#writeDirectory(directory, files, signal);
    const receiptPath = path.join(run.directory, "canvas-review.json");
    const retained = await readSafeProjectFile(run.directory, receiptPath, 4096)
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    const prior: unknown = retained ? JSON.parse(retained.toString("utf8")) : undefined;
    if (prior !== undefined && (!Check(canvasReviewReceipt, prior) || (!prior.boardId && !prior.reviewPresentation)))
      throw new Error("The retained Blender review board or presentation is invalid");
    const requestedPresentation = prior?.reviewPresentation === "final" ? "final"
      : presentation?.reviewPresentation ?? prior?.reviewPresentation ?? originalPresentation;
    const lockedBoard = prior?.boardId ?? (originalPresentation === "checkpoint" ? request.boardId : undefined);
    const boardId = presentation?.boardId ?? lockedBoard ?? prior?.requestedBoardId ?? request.boardId;
    if ((lockedBoard && boardId !== lockedBoard) ||
        (prior?.boardId && originalPresentation === "checkpoint" && request.boardId && prior.boardId !== request.boardId))
      throw new Error("The original Blender review board changed; review its retained placement before recovery");
    const finalIssue = requestedPresentation !== "final" ? undefined : technicalChecksPassed === false
      ? "The retained report contains failed technical checks. Inspect the report, correct the failed stage, and recheck its output."
      : models.length !== 1
        ? "A final presentation needs exactly one inspectable GLB candidate. Export the intended model and inspect it before presenting it."
        : undefined;
    const publish = requestedPresentation !== "internal" && !finalIssue && !!this.options.presentReview;
    const changedIntent = publish && !!presentation?.reviewPresentation &&
      (requestedPresentation !== (prior?.reviewPresentation ?? originalPresentation) || (!lockedBoard && boardId !== prior?.requestedBoardId && !!presentation.boardId));
    if (changedIntent) {
      // Recover the exact promotion (including its intended board) if binding or Canvas delivery is interrupted.
      await writeAtomically(run.directory, receiptPath, JSON.stringify({
        ...(lockedBoard ? { boardId: lockedBoard } : { requestedBoardId: boardId }),
        reviewPresentation: requestedPresentation,
      }));
    }
    await this.options.touch?.();
    let assetsByPath: Record<string, string> = {};
    let canvas: { boardId: string; nodeIds: string[] } | undefined;
    if (publish && this.options.presentReview) {
      // Historical node IDs use this exact ordering, including the case-sensitive .glb suffix.
      const modelFirst = (file: string) => (request.reviewPresentation ? file.toLowerCase() : file).endsWith(".glb");
      const reviewFiles = [...files.keys()].filter(file => /\.(?:glb|png|jpe?g)$/i.test(file))
        .sort((a, b) => Number(modelFirst(b)) - Number(modelFirst(a)) || a.localeCompare(b))
        .map((file, index) => ({ path: `${directory}/${file}`, nodeId: `blender-${run.id}-${index}` }));
      let selection = reviewFiles;
      if (requestedPresentation === "final" && reviewFiles.length > 4) {
        // For large pose sets, expose only the model and unambiguous standard views.
        selection = reviewFiles.filter(file => /\.glb$/i.test(file.path));
        for (const angle of ["front", "side", "back"]) {
          const views = reviewFiles.filter(file =>
            /\.(?:png|jpe?g)$/i.test(file.path) && path.parse(file.path).name.toLowerCase().replace(/^review-/, "") === angle,
          );
          if (views.length === 1) selection.push(views[0]);
        }
      }
      if (selection.length) {
        try {
          const delivery = await this.options.presentReview({
            runId: run.id, workflow: request.workflow, stage: request.stage, boardId,
            files: selection,
          });
          assetsByPath = delivery.assetsByPath;
          canvas = { boardId: delivery.boardId, nodeIds: delivery.nodeIds };
        } catch (error) {
          // A rejected destination is definitive. Preserve the prior placement for a later recovery.
          if (changedIntent && error instanceof CanvasError && [404, 409].includes(error.statusCode)) {
            if (retained) await writeAtomically(run.directory, receiptPath, retained.toString("utf8"));
            else await rm(receiptPath);
          }
          throw error;
        }
        if (!prior?.boardId)
          await writeAtomically(run.directory, receiptPath, JSON.stringify({
            boardId: canvas.boardId,
            ...(requestedPresentation !== originalPresentation ? { reviewPresentation: requestedPresentation } : {}),
          }));
      }
    }
    return result({
      runId: run.id,
      workflow: request.workflow,
      stage: request.stage,
      directory,
      files: [...files.keys()].map((file) => `${directory}/${file}`),
      models: models.map(item => {
        const originalPath = `${directory}/${item.file}`;
        const assetId = assetsByPath[originalPath];
        return { originalPath, ...(assetId ? { assetId } : {}), model: item.model };
      }),
      ...(run.liveView ? { liveView: run.liveView } : {}),
      ...(canvas ? { canvas } : {}),
      reviewPresentation: requestedPresentation,
      ...(finalIssue ? { presentationIssue: finalIssue } : {}),
      review: !canvas ? "pending-agent-review" : requestedPresentation === "checkpoint" && request.reviewPresentation
        ? "checkpoint-presented" : "pending-human-review",
      technicalChecksPassed,
      next: requestedPresentation === "final" && finalIssue ? finalIssue
        : requestedPresentation !== "internal" && !canvas ? "No Canvas review was presented. Check Canvas availability and the retained review files before requesting acceptance."
        : requestedPresentation === "final" ? "Use the returned assetId with get_model_asset to verify the model and required clips in the target game when available. Then ask for the user's final artistic decision on the rotatable, playable Canvas model."
        : requestedPresentation === "checkpoint" ? "The checkpoint is visible. If a decision genuinely needs the user, explain the tradeoff in plain language and wait for their answer. For a progress-only preview, continue unless asked to pause."
        : "Read the retained reports and inspect actual renders or motion samples, correct defects, and continue the workflow. When the checked model is ready, present this exact run with recover_blender_run and reviewPresentation=final.",
      log: run.log,
    });
  }

  async #writeDirectory(
    relative: string,
    files: ReadonlyMap<string, Buffer>,
    signal?: AbortSignal,
  ) {
    const workspace = this.options.workspace;
    const target = await localAgentPath(workspace, relative, true);
    const existing = await lstat(target).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    if (existing) {
      if (!existing.isDirectory())
        throw new Error(
          "Blender delivery conflicts with an existing project file",
        );
      for (const [name, bytes] of files) {
        const actual = await readSafeProjectFile(
          workspace,
          await localAgentPath(workspace, `${relative}/${name}`),
        );
        if (!actual.equals(bytes))
          throw new Error(
            `Preserving an edited Blender result: ${relative}/${name}`,
          );
      }
      return;
    }
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    await localAgentPath(workspace, path.posix.dirname(relative));
    const temporary = await mkdtemp(path.join(parent, ".blender-delivery-"));
    try {
      for (const [name, bytes] of files) {
        signal?.throwIfAborted();
        const filename = path.join(temporary, name);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
      }
      signal?.throwIfAborted();
      await localAgentPath(workspace, relative, true);
      if (
        await lstat(target).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        throw new Error(
          "A Blender delivery directory appeared during publication; preserve it and recover the retained run",
        );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
