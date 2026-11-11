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
import { defineTool } from "@earendil-works/pi-coding-agent";
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
          "Project Python script, only for the custom stage. Receives --input-dir and --output-dir.",
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
      defineTool({
        name: "run_blender",
        label: "Run Blender stage",
        description:
          "Run one reproducible local Blender stage in a private, network-disabled environment. Read blender-assets and its pipeline reference first. Use Tripo only for an initial organic mesh when needed; this tool never calls a paid provider. Review dimensions/views before modeling, joints before rigging, deformation before animation, and motion before final use. New output is retained with its editable .blend, reports and previews; previous files are preserved. Custom Python can import the bundled pipeline and export_glb helpers and has access only to declared input snapshots and the private output directory. Use recover_blender_run after interrupted delivery instead of rerunning.",
        parameters: runParameters,
        execute: async (_callId, input, signal) => {
          if (!Check(runParameters, input))
            throw new Error("Invalid Blender workflow arguments");
          this.#assertEnabled();
          // Session AutoContinueTools owns call replay; IDs may recur in other conversations.
          return this.options.mutate(() => this.#run(input, signal));
        },
      }),
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
            const diagnostic = await this.options.runner.inspectJob(runId);
            if (diagnostic.status !== "completed")
              return result({ runId, ...diagnostic, published: false });
            const run = await this.options.runner.readJob(runId);
            const request = await this.#request(run);
            return this.#publish(run, request, signal);
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

  async #run(input: RunRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
      input.stage === "custom"
        ? !input.scriptPath
        : !!input.scriptPath || !input.configPath
    )
      throw new Error(
        "Custom stages require scriptPath; bundled stages require configPath and do not accept scriptPath",
      );
    if (
      input.stage !== "parts" &&
      input.stage !== "custom" &&
      !input.sourcePath
    )
      throw new Error("This stage requires the preceding sourcePath");
    if (
      (input.configPath && !input.configPath.endsWith(".json")) ||
      (input.scriptPath && !input.scriptPath.endsWith(".py")) ||
      (input.sourcePath && !/\.(?:glb|blend)$/i.test(input.sourcePath))
    )
      throw new Error(
        "Use JSON configuration, a Python script, and a GLB or Blender source",
      );
    const inputs = [
      ...new Set(
        [input.configPath, input.sourcePath, ...(input.inputs ?? [])].filter(
          (value): value is string => !!value,
        ),
      ),
    ];
    for (const filename of [
      ...inputs,
      ...(input.scriptPath ? [input.scriptPath] : []),
    ])
      await localAgentPath(this.options.workspace, filename);
    const args = [
      ...(input.stage === "custom" ? [] : ["--stage", input.stage]),
      ...(input.configPath ? ["--config", input.configPath] : []),
      ...(input.sourcePath ? ["--input", input.sourcePath] : []),
    ];
    const files: Record<string, string> = {};
    for (const name of ["pipeline.py", "export_glb.py"])
      files[name] = (
        await readSafeProjectFile(
          this.options.bundledScriptsDirectory,
          path.join(this.options.bundledScriptsDirectory, name),
          512 * 1024,
        )
      ).toString("utf8");
    if (input.scriptPath)
      files["script.py"] = (
        await readSafeProjectFile(
          this.options.workspace,
          await localAgentPath(this.options.workspace, input.scriptPath),
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
          ...(input.timeoutSeconds
            ? { timeoutMs: input.timeoutSeconds * 1000 }
            : {}),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof BlenderRunError && error.jobId)
        throw new Error(
          `${error.message} Retained Blender run: ${error.jobId}. ${error.log}`,
        );
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
    return result({
      runId: run.id,
      workflow: request.workflow,
      stage: request.stage,
      directory,
      files: [...files.keys()].map((file) => `${directory}/${file}`),
      models: bindings,
      review: "pending-human-review",
      technicalChecksPassed,
      next: "Inspect the reports and review images. Resolve any failed technical checks before advancing. For a delivered GLB, use get_model_asset with its assetId to prepare game runtime resources, then load and play all clips in the target game. File/structure checks are not artistic or engine acceptance.",
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
