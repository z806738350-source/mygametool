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
    boardId: Type.Optional(
      Type.String({
        pattern: "^[a-zA-Z0-9_-]{1,100}$",
        description:
          "Canvas board for interactive review. Use the current board when known; otherwise the first project board is used.",
      }),
    ),
  },
  { additionalProperties: false },
);
type RunRequest = Static<typeof runParameters>;
type Runner = Pick<BlenderRunner, "run" | "status" | "readJob" | "inspectJob">;
type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

export interface BlenderToolsOptions {
  workspace: string;
  privateRoot: string;
  bundledScriptsDirectory: string;
  runner: Runner;
  enabled?: () => boolean;
  mutate: Mutate;
  bindModel: (relativePath: string) => Promise<string>;
  touch?: () => Promise<unknown>;
  presentReview?: (review: {
    runId: string;
    workflow: string;
    stage: string;
    boardId?: string;
    files: string[];
  }) => Promise<{ boardId: string; nodeIds: string[] }>;
}

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: { blender: value },
});

/** Project-bound jobs retain editable sources; publication never replaces an earlier run. */
export class BlenderWorkflow {
  constructor(private readonly options: BlenderToolsOptions) {}

  tools() {
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
              "Required for shape, joints, deformation and motion; numeric checks do not establish artistic quality.",
          });
        },
      }),
      Object.assign(
        defineTool<typeof runParameters, { blender: unknown }>({
          name: "run_blender",
          label: "Run Blender stage",
          description:
            "Run one reproducible local Blender stage in a private, network-disabled environment. Read blender-assets and its pipeline reference first. Use Tripo only for an initial organic mesh when needed; this tool never calls a paid provider. Review dimensions/views before modeling, joints before rigging, deformation before animation, and motion before final use. New output is retained with its editable .blend, reports and previews; previous files are preserved. Custom Python can import the bundled pipeline and export_glb helpers and has access only to declared input snapshots and the private output directory. Use recover_blender_run after interrupted delivery instead of rerunning.",
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
                input,
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
      defineTool({
        name: "recover_blender_run",
        label: "Recover Blender result",
        description:
          "Validate and deliver a retained successful Blender run from this project without starting Blender or submitting a provider request. Conflicting edited output is preserved and reported. Failed or incomplete runs cannot be promoted to successful results.",
        parameters: Type.Object(
          { runId: Type.String({ pattern: UUID.source }) },
          { additionalProperties: false },
        ),
        execute: async (_id, { runId }, signal) =>
          this.options.mutate(async () => {
            signal?.throwIfAborted();
            this.#assertEnabled();
            if (!UUID.test(runId))
              throw new Error("Use a retained Blender run ID");
            return this.#recover(runId, signal);
          }),
      }),
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

  async #recover(runId: string, signal?: AbortSignal, requireTerminal = false) {
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
    return this.#publish(run, await this.#request(run), signal);
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
    for (const name of ["pipeline.py", "export_glb.py"])
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
      await writeFile(
        path.join(run.directory, "workflow.json"),
        JSON.stringify(input),
        { flag: "wx", mode: 0o600 },
      );
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
    const receipt = {
      runId: run.id,
      workflow: request.workflow,
      stage: request.stage,
      request,
      outputs: run.files,
      review: "pending-human-review",
      technicalChecksPassed,
      models,
    };
    files.set("run.json", Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
    await this.#writeDirectory(directory, files, signal);
    const bindings = [];
    for (const item of models) {
      signal?.throwIfAborted();
      const originalPath = `${directory}/${item.file}`;
      bindings.push({
        originalPath,
        assetId: await this.options.bindModel(originalPath),
        model: item.model,
      });
    }
    await this.options.touch?.();
    const reviewFiles = [...files.keys()]
      .filter((file) => /\.(?:glb|png|jpe?g)$/i.test(file))
      .sort(
        (a, b) =>
          Number(!a.endsWith(".glb")) - Number(!b.endsWith(".glb")) ||
          a.localeCompare(b),
      )
      .map((file) => `${directory}/${file}`);
    let canvas: { boardId: string; nodeIds: string[] } | undefined;
    if (reviewFiles.length && this.options.presentReview) {
      const receiptPath = path.join(run.directory, "canvas-review.json");
      const retained = await readSafeProjectFile(run.directory, receiptPath, 4096)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
      const selected: unknown = retained ? JSON.parse(retained.toString("utf8"))?.boardId : request.boardId;
      if (selected !== undefined && (typeof selected !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(selected)))
        throw new Error("The retained Blender review board is invalid");
      if (retained && (!selected || request.boardId && request.boardId !== selected))
        throw new Error("The original Blender review board changed; review its retained placement before recovery");
      canvas = await this.options.presentReview({
        runId: run.id, workflow: request.workflow, stage: request.stage,
        boardId: selected as string | undefined, files: reviewFiles,
      });
      if (!retained) await writeFile(receiptPath, JSON.stringify({ boardId: canvas.boardId }), { flag: "wx", mode: 0o600 });
    }
    return result({
      runId: run.id,
      workflow: request.workflow,
      stage: request.stage,
      directory,
      files: [...files.keys()].map((file) => `${directory}/${file}`),
      models: bindings,
      ...(canvas ? { canvas } : {}),
      review: "pending-human-review",
      technicalChecksPassed,
      next: "Inspect the reports. The returned Canvas nodes show the interactive stage GLB and auxiliary images; reuse them, do not add duplicates. Ask the user to rotate/zoom the model and play/switch every available animation before accepting the corresponding stage. Resolve failed technical checks before advancing. For custom modeling stages, include a review.glb from the saved scene; images alone are not a model review. For final delivery use get_model_asset, then load and play all clips in the target game. Preview and numeric checks do not imply human or engine acceptance.",
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
