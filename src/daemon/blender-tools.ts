import { createHash } from "node:crypto";
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
  type SessionEntry,
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
import { createLocalAgentFileTools, localAgentPath, projectFileVersionPath, type ProjectFileVersion } from "./agent-local-files.js";
import { inspectSafeProjectMedia, MAX_SAFE_PROJECT_FILE_BYTES, readSafeProjectFile } from "./safe-project-file.js";
import { blenderBrief, blenderDeliveryIssue, blenderStaticReviewIssue, blenderStaticReviewViews, blenderVisualIssue, blenderVisualReview, boundBlenderStaticReview } from "./blender-production.js";
import { inspectModel3D } from "./model3d-inspect.js";
import { isFbxArtifact } from "./fbx-preview.js";
import { validateRasterReturn } from "./isolated-raster-returns.js";
import {
  confirmBlenderRunFailure,
  getToolPreflightFailure,
  toolPreflightError,
} from "./agent-tool-errors.js";
import type { RecoverableTool } from "./agent-auto-continue.js";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
// Bounded multilingual brief and input-path fields can exceed 64 KiB after JSON encoding.
const REQUEST_RECORD_BYTES = 256 * 1024;
const sourceOriginalSchema = Type.Object({ assetId: Type.String({ pattern: UUID.source }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), format: Type.Union([Type.Literal("fbx"), Type.Literal("glb")]) }, { additionalProperties: false });
const stages = [
  "inspect",
  "parts",
  "clean",
  "joints",
  "rig",
  "animate",
  "static-review",
  "export",
  "custom",
] as const;
const boardIdParameter = Type.Optional(Type.String({
  pattern: "^[a-zA-Z0-9_-]{1,100}$",
  description: "Canvas board for user review; use the current board when known.",
}));
const checkpointPresentation = Type.Literal("checkpoint", { description: "Show requested progress or a decision that needs the user. Omit visualReview for a checkpoint." });
const finalPresentation = Type.Literal("final", { description: "Show the inspected, delivery-ready model for the user's final decision." });
const recoverParameters = Type.Object({
  runId: Type.String({ pattern: UUID.source }),
  reviewPresentation: Type.Optional(Type.Union([checkpointPresentation, finalPresentation])),
  boardId: boardIdParameter,
  visualReview: Type.Optional(blenderVisualReview),
}, { additionalProperties: false });
const canvasReviewReceipt = Type.Object({
  boardId: boardIdParameter,
  requestedBoardId: boardIdParameter,
  visualReview: Type.Optional(blenderVisualReview),
  reviewPresentation: Type.Optional(Type.Union([checkpointPresentation, finalPresentation])),
});
const runParameters = Type.Object(
  {
    workflow: Type.String({
      pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Stable asset/workflow name, such as village-crate or hero.",
    }),
    stage: Type.Union([
      Type.Literal("inspect", { description: "Inventory an existing original and render baseline views before choosing edits." }),
      Type.Literal("parts"),
      Type.Literal("clean"),
      Type.Literal("joints"),
      Type.Literal("rig"),
      Type.Literal("animate", { description: "Idle/Walk for an upright biped. Use custom for legless or multi-legged locomotion." }),
      Type.Literal("static-review", { description: "Review the current editable Tripo-derived scene against its bound original after changing mesh or materials. Produces matched stills and surface measurements." }),
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
        description: "Project-relative GLB, FBX or preceding stage scene.blend; use sourceAssetId for a bound original.",
      }),
    ),
    sourceAssetId: Type.Optional(Type.String({ pattern: UUID.source, description: "Project-bound original GLB or FBX assetId from generation or get_model_asset. Use instead of sourcePath." })),
    scriptPath: Type.Optional(
      Type.String({
        maxLength: 240,
        description:
          "Single project Python entry point for a custom stage. Put project-specific helper functions in this script. Parse arguments AFTER sys.argv's '--' separator: --input-dir, --output-dir, optional --input and --config. Input paths retain project subdirectories; open Path(args.input_dir) / args.input, not glob('*.blend').",
      }),
    ),
    save: Type.Optional(Type.Union([
      Type.Object({ content: Type.String() }, { additionalProperties: false }),
      Type.Object({ edits: Type.Array(Type.Object({
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
      }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
    ], { description: "Save scriptPath for a custom stage or configPath for a bundled stage before running. Supply full content for a new file or exact, disjoint edits for an existing file." })),
    releaseReviewedImages: Type.Optional(Type.Boolean({
      description: "With save, set after inspecting all needed images when the next stage only needs your review findings. Originals remain recallable.",
    })),
    inputs: Type.Optional(
      Type.Array(Type.String({ maxLength: 240 }), {
        maxItems: 30,
        description:
          "Additional project data files such as models, textures and JSON. Put project Python code in the single scriptPath entry.",
      }),
    ),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
    reviewPresentation: Type.Optional(Type.Union([
      Type.Literal("internal", { description: "Default. Retain files for the Agent to inspect and refine." }),
      checkpointPresentation,
    ])),
    boardId: boardIdParameter,
    brief: Type.Optional(blenderBrief),
  },
  { additionalProperties: false },
);
type RunRequest = Static<typeof runParameters>;
type StageSave = {
  payload: NonNullable<RunRequest["save"]>;
  callId: string;
  context: Parameters<ToolDefinition["execute"]>[4];
};
type RecoveryRequest = Static<typeof recoverParameters>;
type StaticInspection = { callId: string; branch: readonly SessionEntry[] | undefined };
type Runner = Pick<BlenderRunner, "run" | "status" | "readJob" | "inspectJob">;
type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

export interface BlenderToolsOptions {
  workspace: string;
  privateRoot: string;
  bundledScriptsDirectory: string;
  runner: Runner;
  resolveSourceAsset?: (assetId: string, signal?: AbortSignal) => Promise<{ assetId: string; sha256: string; extension: string; bytes: Buffer; tripo: boolean }>;
  requireTripoApproval?: (assetId: string, sha256: string) => Promise<void>;
  checkTripoInputPaths?: (paths: readonly string[], signal?: AbortSignal) => Promise<void>;
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

const result = (value: unknown, executedScriptSha256?: string, projectFileVersion?: ProjectFileVersion) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: { blender: value, ...(executedScriptSha256 ? { executedScriptSha256 } : {}), ...(projectFileVersion ? { projectFileVersion } : {}) },
});

/** Pi executes a batch containing write/edit sequentially, even if a preceding call failed. */
function savedBatchScript(branch: readonly SessionEntry[] | undefined, callId: string, scriptPath: string | undefined) {
  if (!branch || !scriptPath) return;
  const start = branch.findLastIndex(entry => entry.type === "message" && ["assistant", "user"].includes(entry.message.role));
  const entry = branch[start];
  if (entry?.type !== "message" || entry.message.role !== "assistant") return;
  const calls = entry.message.content.filter(block => block.type === "toolCall");
  const run = calls.findIndex(call => call.id === callId && call.name === "run_blender");
  if (run < 0) return;
  const target = projectFileVersionPath(scriptPath);
  // Detect aliases conservatively on case-insensitive filesystems; require the actual receipt's path and bytes.
  const comparable = (file: string) => path.posix.normalize(file).normalize("NFC").toLowerCase();
  const receipts = branch.slice(start + 1).flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  let expected: string | undefined;
  for (const [index, call] of calls.entries()) {
    if (call.name !== "write" && call.name !== "edit") continue;
    const file = call.arguments.path;
    if (typeof file === "string" && comparable(projectFileVersionPath(file)) !== comparable(target)) continue;
    const matching = receipts.filter(receipt => receipt.toolCallId === call.id && receipt.toolName === call.name);
    const receipt = matching[0];
    const version = (receipt?.details as { projectFileVersion?: ProjectFileVersion } | undefined)?.projectFileVersion;
    if (typeof file !== "string" || index >= run || calls.filter(other => other.id === call.id).length !== 1 || matching.length !== 1 ||
        receipt?.isError || version?.path !== target || !/^[0-9a-f]{64}$/.test(version.sha256))
      throw toolPreflightError("Blender did not start. Save the script successfully with write or edit before run_blender, using the same project path.", "invalid_blender_input");
    expected = version.sha256;
  }
  return expected;
}

/** A candidate can only be assessed after a separate response received its actual paired images. */
function hasStaticReviewViews(inspection: StaticInspection | undefined, directory: string, files: ReadonlyMap<string, Buffer>): boolean {
  const { callId, branch } = inspection ?? {};
  if (!branch || !callId) return false;
  const readCalls = new Map<string, { name: string; image: typeof blenderStaticReviewViews[number] }>();
  const opened = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const calls = message.content.filter(part => part.type === "toolCall");
      if (calls.some(call => call.id === callId && call.name === "recover_blender_run")) return opened.size === blenderStaticReviewViews.length;
      for (const call of calls) {
        if (call.name !== "read" && call.name !== "read_project_file") continue;
        const image = blenderStaticReviewViews.find(name => call.arguments.path === `${directory}/${name}`);
        if (image) readCalls.set(call.id, { name: call.name, image });
      }
    } else if (message.role === "toolResult" && !message.isError) {
      const read = readCalls.get(message.toolCallId);
      if (!read || message.toolName !== read.name || opened.has(read.image)) continue;
      const expected = files.get(read.image);
      if (expected && message.content.some(part => part.type === "image" && part.mimeType === "image/png" &&
          Buffer.byteLength(part.data, "base64") === expected.length && Buffer.from(part.data, "base64").equals(expected))) {
        opened.add(read.image);
      }
    }
  }
  return false;
}

/** Project-bound jobs retain editable sources; publication never replaces an earlier run. */
export class BlenderWorkflow {
  constructor(private readonly options: BlenderToolsOptions) {}

  tools() {
    const recover = (input: unknown, inspection: StaticInspection, signal?: AbortSignal, requireTerminal = false) => this.options.mutate(async () => {
      signal?.throwIfAborted();
      this.#assertEnabled();
      if (!Check(recoverParameters, input))
        throw toolPreflightError("Invalid Blender recovery arguments. Use a retained runId and the documented presentation fields.", "invalid_blender_input");
      if (input.visualReview && input.reviewPresentation !== "final")
        throw toolPreflightError("visualReview is only valid for final presentation. For a checkpoint, omit visualReview and retry recover_blender_run with the same runId to reuse the retained result.", "invalid_blender_input");
      if (input.boardId && !input.reviewPresentation)
        throw toolPreflightError("Select a reviewPresentation of checkpoint or final when specifying boardId.", "invalid_blender_input");
      return this.#recover(input.runId, signal, requireTerminal, input, inspection);
    });
    return [
      defineTool({
        name: "blender_status",
        label: "Check Blender",
        description:
          "Check availability of the headless Blender worker and list retained run IDs. No Blender process or model request is started.",
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
              "The Agent inspects intermediate reports, rendered views and motion, corrects defects, then asks the user for final artistic acceptance. Show intermediate checkpoints for requested progress or a decision that genuinely needs the user.",
          });
        },
      }),
      Object.assign(
        defineTool<typeof runParameters, { blender: unknown }>({
          name: "run_blender",
          label: "Run Blender stage",
          description:
            "Run one headless Blender stage, using save to write or edit its script or configuration in the same call. Use design-proofs.md for 2D reference work and the matching stage reference for modeling. Declare the asset brief and source route on the first production run. Use static-review on the retained Tripo-derived scene after reduction or material changes. Open the paired views, correct regressions, and use the final bundled export's repeated comparison for presentation. Custom scripts can use the bundled pipeline and export_glb helpers on declared inputs.",
          promptGuidelines: ["When ready to run a new or changed script or configuration, use run_blender with save.content or save.edits in the same call. Use one Blender stage at a time. Inspect its evidence before choosing revisions or accepting views."],
          executionMode: "sequential",
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
            const invocation = sessionFile ? { callId, sessionFile, request: input } : undefined;
            const { save, releaseReviewedImages: _, ...request } = input;
            const expectedScript = savedBatchScript(context?.sessionManager?.getBranch?.(), callId, request.scriptPath ?? (save ? request.configPath : undefined));
            if (save && expectedScript)
              throw toolPreflightError("Choose either run_blender.save or a separate preceding file save for this recipe.", "invalid_blender_input");
            if (save && Buffer.byteLength(JSON.stringify(invocation ?? { request: input })) > REQUEST_RECORD_BYTES)
              throw toolPreflightError("The Blender save is too large for one call. Save the recipe as a project file, then use its path.", "text_too_large");
            return this.options.mutate(() =>
              this.#run(
                { ...request, reviewPresentation: request.reviewPresentation ?? "internal" },
                signal,
                invocation,
                expectedScript,
                save ? { payload: save, callId, context } : undefined,
              ),
            );
          },
        }),
        {
          canReuseResult: (previous, callId, input, _signal, _update, context) => {
            try {
              if (!Check(runParameters, input)) return false;
              const expected = savedBatchScript(context?.sessionManager?.getBranch?.(), callId, input.scriptPath ?? (input.save ? input.configPath : undefined));
              if (expected && input.save) return false;
              return !expected || (previous.details as { executedScriptSha256?: string } | undefined)?.executedScriptSha256 === expected;
            } catch {
              // Execute the normal preflight so a rejected batch is journaled under its own call ID.
              return false;
            }
          },
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
                REQUEST_RECORD_BYTES,
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
        } satisfies Pick<RecoverableTool, "recoverAfterHttp500" | "canReuseResult">,
      ),
      Object.assign(defineTool({
        name: "recover_blender_run",
        label: "Recover Blender result",
        description:
          "Recover a retained Blender run without restarting it. To present a checked bundled export on Canvas, select final and submit visualReview for evidence you opened from that exact run. Tripo-derived candidates also require all paired static views and verdicts for silhouette, normals, sharp edges and textures. Correct reported regressions locally before presenting. Use checkpoint for requested progress or a decision requiring the user.",
        parameters: recoverParameters,
        execute: (callId, input, signal, _update, context) =>
          recover(input, { callId, branch: context?.sessionManager?.getBranch?.() }, signal),
      }), {
        recoverAfterHttp500: (callId, input, signal, _update, context) =>
          recover(input, { callId, branch: context?.sessionManager?.getBranch?.() }, signal, true),
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

  async #recover(runId: string, signal?: AbortSignal, requireTerminal = false, presentation?: RecoveryRequest, inspection?: StaticInspection) {
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
    return this.#publish(run, await this.#request(run), signal, presentation, inspection);
  }

  async #run(
    input: RunRequest,
    signal?: AbortSignal,
    invocation?: { callId: string; sessionFile: string; request: unknown },
    expectedScriptSha256?: string,
    save?: StageSave,
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
      !input.sourcePath && !input.sourceAssetId
    )
      throw toolPreflightError(
        "This stage requires an original sourceAssetId or a preceding sourcePath",
        "invalid_blender_input",
      );
    if (
      (input.configPath && !input.configPath.endsWith(".json")) ||
      (input.scriptPath && !input.scriptPath.endsWith(".py")) ||
      (input.sourcePath && !/\.(?:glb|fbx|blend)$/i.test(input.sourcePath))
    )
      throw toolPreflightError(
        "Use JSON configuration, a Python script, and a GLB, FBX or Blender source",
        "invalid_blender_input",
      );
    if (input.sourceAssetId && input.sourcePath)
      throw toolPreflightError("Choose sourceAssetId or sourcePath, not both.", "invalid_blender_input");
    const inputs = [
      ...new Set(
        [input.configPath, input.sourcePath, ...(input.inputs ?? [])].filter(
          (value): value is string => !!value,
        ),
      ),
    ];
    const files: Record<string, string> = {};
    const savePath = save ? (input.stage === "custom" ? input.scriptPath : input.configPath) : undefined;
    try {
      for (const filename of [
        ...inputs,
        ...(input.scriptPath ? [input.scriptPath] : []),
      ])
        if (filename !== savePath) await localAgentPath(this.options.workspace, filename);
      await this.options.checkTripoInputPaths?.(inputs, signal);
      if (input.scriptPath && !save) {
        const bytes = await readSafeProjectFile(
          this.options.workspace,
          await localAgentPath(this.options.workspace, input.scriptPath),
          512 * 1024,
        );
        if (expectedScriptSha256 && createHash("sha256").update(bytes).digest("hex") !== expectedScriptSha256)
          throw toolPreflightError("Blender did not start. The saved script changed before execution. Read the current script before applying the revision again.", "invalid_blender_input");
        files["script.py"] = bytes.toString("utf8");
      }
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
    const hasSource = !!(input.sourcePath || input.sourceAssetId);
    if (input.stage === "parts" && hasSource)
      throw toolPreflightError("The parts stage constructs new geometry. Use inspect, clean or another source-based stage for an existing model.", "invalid_blender_input");
    const parent = await this.#sourceBrief(input);
    if (parent?.brief) {
      if (input.brief && !isDeepStrictEqual(input.brief, parent.brief))
        throw toolPreflightError("The previous scene has a different production brief. Continue with its original requirements, or start an explicitly revised workflow using the scene as an existing source.", "invalid_blender_input");
      input = { ...input, brief: parent.brief };
    } else if (input.brief) {
      if (input.brief.route === "tripo" && !input.sourceAssetId)
        throw toolPreflightError("Start the Tripo route from the generated project's sourceAssetId, then continue from its retained scene.blend.", "invalid_blender_input");
      if (input.brief.route === "tripo" && !["inspect", "clean", "export"].includes(input.stage))
        throw toolPreflightError("Load the original Tripo asset with bundled inspect, clean or export before custom edits, binding or animation.", "invalid_blender_input");
      if (input.brief.route === "procedural" && (hasSource || !["parts", "custom"].includes(input.stage)))
        throw toolPreflightError("Start a procedural brief with parts or custom construction. Use the existing route for an input model.", "invalid_blender_input");
      if (input.brief.route !== "procedural" && !hasSource)
        throw toolPreflightError("An existing or Tripo brief needs an original source and a stage that loads it.", "invalid_blender_input");
    }
    let boundSource: Parameters<Runner["run"]>[0]["boundSource"];
    let sourceOriginal = parent?.sourceOriginal;
    if (input.stage === "static-review" && (input.brief?.route !== "tripo" || !input.sourcePath?.endsWith("/scene.blend")))
      throw toolPreflightError("Run static-review on a retained scene.blend that belongs to the original Tripo workflow.", "invalid_blender_input");
    const compareOriginal = input.brief?.route === "tripo" && (input.stage === "export" || input.stage === "static-review");
    const originalId = input.sourceAssetId ?? (compareOriginal ? sourceOriginal?.assetId : undefined);
    if (compareOriginal && !originalId)
      throw toolPreflightError("Continue the Tripo review or export from a scene with its retained original asset identity.", "invalid_blender_input");
    if (originalId) {
      if (!this.options.resolveSourceAsset) throw toolPreflightError("Project model lookup is unavailable.", "invalid_blender_input");
      try {
        const source = await this.options.resolveSourceAsset(originalId, signal);
        if (input.brief?.route === "tripo" && !source.tripo)
          throw new Error("The bound original lacks Tripo generation provenance. Choose the generated Tripo assetId, or use the existing-source route.");
        if (source.assetId !== originalId || (source.extension !== "fbx" && source.extension !== "glb"))
          throw new Error("Choose an original FBX or GLB model.");
        if (sourceOriginal && (source.sha256 !== sourceOriginal.sha256 || source.extension !== sourceOriginal.format))
          throw new Error("The retained original changed. Restore its exact original bytes before exporting the Tripo-derived scene.");
        if (source.tripo && input.sourceAssetId) await this.options.requireTripoApproval?.(source.assetId, source.sha256);
        const name = `source-${source.assetId}.${source.extension}`;
        sourceOriginal = { assetId: source.assetId, sha256: source.sha256, format: source.extension };
        boundSource = { path: name, bytes: source.bytes, sha256: source.sha256 };
        if (input.sourceAssetId) args.push("--input", name);
        if (compareOriginal) args.push("--static-review-source", name);
      } catch (cause) {
        signal?.throwIfAborted();
        if (getToolPreflightFailure(cause)) throw cause;
        throw toolPreflightError(cause instanceof Error ? cause.message : String(cause), "invalid_blender_input");
      }
    }
    if (compareOriginal)
      files["static_review.py"] = (await readSafeProjectFile(
        this.options.bundledScriptsDirectory,
        path.join(this.options.bundledScriptsDirectory, "static_review.py"),
        512 * 1024,
      )).toString("utf8");
    let savedFile: ProjectFileVersion | undefined;
    if (save && savePath) {
      const tool = createLocalAgentFileTools(this.options.workspace).find(tool => tool.name === ("content" in save.payload ? "write" : "edit"))!;
      const receipt = await tool.execute(save.callId, { path: savePath, ...save.payload } as never, signal, undefined, save.context);
      savedFile = (receipt.details as { projectFileVersion?: ProjectFileVersion } | undefined)?.projectFileVersion;
      if (!savedFile) throw new Error("The Blender recipe save could not be verified. Read the project file before retrying.");
      if (input.scriptPath) {
        let bytes: Buffer;
        try {
          bytes = await readSafeProjectFile(this.options.workspace, await localAgentPath(this.options.workspace, savePath), 512 * 1024);
        } catch (error) {
          return result({ status: "saved-not-run", message: `Saved ${savePath}, but Blender could not read it: ${(error as Error).message}` }, undefined, savedFile);
        }
        if (createHash("sha256").update(bytes).digest("hex") !== savedFile.sha256)
          return result({ status: "saved-not-run", message: `The saved Blender recipe ${savePath} changed before execution. Read it before retrying.` }, undefined, savedFile);
        files["script.py"] = bytes.toString("utf8");
      }
    }
    const expectedInputSha256 = {
      ...(parent && input.sourcePath ? { [input.sourcePath]: parent.sha256 } : {}),
      ...(savedFile && !input.scriptPath && savePath ? { [savePath]: savedFile.sha256 } : {}),
    };
    let run: BlenderRunResult;
    try {
      run = await this.options.runner.run(
        {
          workspace: this.options.workspace,
          inputs,
          args,
          boundSource, sourceOriginal,
          ...(Object.keys(expectedInputSha256).length ? { expectedInputSha256 } : {}),
          bundledScripts,
          ...(input.stage === "export" ? { bundledExport: true } : {}),
          workflowRequest: input,
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
        if (diagnostic.status === "failed") {
          const failed = await this.#recover(error.jobId, signal);
          if (savedFile) failed.details.projectFileVersion = savedFile;
          return failed;
        }
        throw new Error(
          `${error.message} Retained Blender run: ${error.jobId}. ${error.log}`,
        );
      }
      if (error instanceof BlenderRunError && savedFile)
        return result({ status: "saved-not-run", message: `Saved ${savedFile.path}, but Blender did not start: ${error.message}` }, undefined, savedFile);
      if (error instanceof BlenderRunError)
        throw toolPreflightError(error.message, "invalid_blender_input");
      throw error;
    }
    try {
      const published = await this.#publish(run, input, signal);
      return savedFile ? { ...published, details: { ...published.details, projectFileVersion: savedFile } } : published;
    } catch (error) {
      throw new Error(
        `Blender run ${run.id} is retained. Use recover_blender_run with this runId to finish delivery. ${error instanceof Error ? error.message : "Delivery failed"}`,
      );
    }
  }

  async #sourceBrief(input: RunRequest) {
    const match = input.sourcePath?.match(/^assets\/blender\/([^/]+)\/runs\/([^/]+)\/scene\.blend$/);
    if (!match || match[1] !== input.workflow || !UUID.test(match[2])) return;
    // Projects can bring in authoring files from another installation without its private jobs.
    const local = await lstat(path.join(this.options.privateRoot, match[2])).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!local) return;
    const parent = await this.options.runner.readJob(match[2]);
    const request = await this.#request(parent);
    if (request.workflow !== input.workflow || !parent.files.some(file => file.path === "scene.blend"))
      throw toolPreflightError("The source does not match the retained Blender workflow.", "invalid_blender_input");
    const { sha256 } = await inspectSafeProjectMedia(parent.outputDirectory, path.join(parent.outputDirectory, "scene.blend"), MAX_SAFE_PROJECT_FILE_BYTES);
    return { brief: request.brief, sha256, sourceOriginal: await this.#sourceOriginal(parent) };
  }

  async #sourceOriginal(run: BlenderRunResult) {
    const bytes = await readSafeProjectFile(run.directory, path.join(run.directory, "source-original.json"), 2048)
      .catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
    if (!bytes) return;
    const source: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Check(sourceOriginalSchema, source)) throw new Error("Invalid retained Blender source identity");
    return source;
  }

  async #request(run: BlenderRunResult): Promise<RunRequest> {
    try {
      const request: unknown = JSON.parse(
        (
          await readSafeProjectFile(
            run.directory,
            path.join(run.directory, "workflow.json"),
            REQUEST_RECORD_BYTES,
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
        REQUEST_RECORD_BYTES,
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
    inspection?: StaticInspection,
  ) {
    signal?.throwIfAborted();
    this.#assertEnabled();
    if (!UUID.test(run.id))
      throw new Error("Invalid retained Blender run identity");
    const files = new Map<string, Buffer>(),
      models = [];
    let technicalChecksPassed: boolean | undefined;
    let roundtripPassed = false;
    let boundaryEdges: number | undefined;
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
        ) {
          technicalChecksPassed = report.technicalChecksPassed;
          roundtripPassed = report.stage === "export" && report.checks?.roundtrip?.passed === true;
          boundaryEdges = report.checks?.topology?.boundaryEdges;
        }
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
    const sourceOriginal = await this.#sourceOriginal(run);
    const receipt = {
      ...(sourceOriginal ? { sourceOriginal } : {}),
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
    const retained = await readSafeProjectFile(run.directory, receiptPath, 64 * 1024)
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
    const visualReview = prior?.visualReview ?? presentation?.visualReview;
    const previousLegacyFinal = !request.brief && !!prior?.boardId && prior.reviewPresentation === "final";
    const deliveryIssue = requestedPresentation === "final" || (request.stage === "export" && request.brief) ? blenderDeliveryIssue({
      stage: request.stage, brief: request.brief, models, outputs: files, technicalChecksPassed, roundtripPassed, boundaryEdges, previousLegacyFinal,
    }) : undefined;
    const previousLegacyStaticFinal = !!prior?.boardId && prior.reviewPresentation === "final" &&
      !files.has("recipe/static_review.py") && !files.has("static-review.json");
    const staticReviewRequired = request.brief?.route === "tripo" &&
      (request.stage === "export" || request.stage === "static-review" || requestedPresentation === "final") && !previousLegacyStaticFinal;
    const staticReport = staticReviewRequired ? boundBlenderStaticReview(files, sourceOriginal?.sha256) : undefined;
    const staticReviewIssue = staticReviewRequired ? blenderStaticReviewIssue(visualReview, files, sourceOriginal?.sha256, {
      requireDecision: requestedPresentation === "final" && request.stage === "export",
    }) ?? (requestedPresentation === "final" && request.stage === "export" &&
      !(prior?.reviewPresentation === "final" && prior.visualReview?.staticReview) &&
      !hasStaticReviewViews(inspection, directory, files)
        ? "Use read (or read_project_file) to open all four paired static review PNGs from this export. Inspect the returned pixels, then make a separate final presentation call with your findings." : undefined)
      : undefined;
    const finalIssue = requestedPresentation === "final"
      ? staticReviewIssue ?? deliveryIssue ?? (previousLegacyFinal ? undefined : blenderVisualIssue(visualReview, files)) : undefined;
    const publish = requestedPresentation !== "internal" && !finalIssue && !!this.options.presentReview;
    const changedIntent = publish && !!presentation?.reviewPresentation &&
      (requestedPresentation !== (prior?.reviewPresentation ?? originalPresentation) || (!lockedBoard && boardId !== prior?.requestedBoardId && !!presentation.boardId));
    if (changedIntent) {
      // Recover the exact promotion (including its intended board) if binding or Canvas delivery is interrupted.
      await writeAtomically(run.directory, receiptPath, JSON.stringify({
        ...(lockedBoard ? { boardId: lockedBoard } : { requestedBoardId: boardId }),
        reviewPresentation: requestedPresentation,
        ...(visualReview ? { visualReview } : {}),
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
            ...(visualReview ? { visualReview } : {}),
          }));
      }
    }
    const executedScript = files.get("recipe/script.py");
    return result({
      ...(sourceOriginal ? { sourceOriginal } : {}),
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
      presentedOnCanvas: !!canvas,
      ...(canvas ? { canvas } : {}),
      ...(request.brief ? { brief: request.brief } : {}),
      ...(deliveryIssue && request.stage === "export" ? { deliveryIssue } : {}),
      ...(staticReport ? { staticReview: {
        sourceTriangles: staticReport.source.triangles,
        candidateTriangles: staticReport.candidate.triangles,
        views: staticReport.views.map(name => `${directory}/${name}`),
      } } : {}),
      ...(staticReviewIssue ? { staticReviewIssue } : {}),
      ...(requestedPresentation === "final" && !finalIssue && visualReview ? { visualReview } : {}),
      reviewPresentation: requestedPresentation,
      ...(finalIssue ? { presentationIssue: finalIssue } : {}),
      review: !canvas ? "pending-agent-review" : requestedPresentation === "checkpoint" && request.reviewPresentation
        ? "checkpoint-presented" : "pending-human-review",
      technicalChecksPassed,
      next: finalIssue ?? staticReviewIssue ??
        (requestedPresentation === "internal" && staticReviewRequired
          ? "Read static-review.json and all four paired static views. Check silhouette, normals, sharp edges and textures against the original. Restore local mesh density where needed, honoring explicit limits and adjusting estimated targets when justified. Report any triangle increase from the previous candidate and its reason when delivering."
          : requestedPresentation === "internal" ? deliveryIssue : undefined)
        ?? (requestedPresentation !== "internal" && !canvas ? "No Canvas review was presented. Check Canvas availability and the retained review files before requesting acceptance."
        : requestedPresentation === "final" ? "Use the returned assetId with get_model_asset to verify the model and required clips in the target game when available. Then ask for the user's final artistic decision on the rotatable, playable Canvas model."
        : requestedPresentation === "checkpoint" ? "The checkpoint is visible. If a decision genuinely needs the user, explain the tradeoff in plain language and wait for their answer. For a progress-only preview, continue unless asked to pause."
        : "Read the retained reports and inspect actual renders or motion samples, correct defects, and continue the workflow. When the checked model is ready, present this exact run with recover_blender_run and reviewPresentation=final."),
      log: run.log,
    }, executedScript && createHash("sha256").update(executedScript).digest("hex"));
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
