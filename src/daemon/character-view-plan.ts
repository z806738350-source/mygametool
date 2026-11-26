import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { resolveAssetCanvasAssetId } from "../shared/asset-canvas.js";
import { characterViewDesign, type CharacterViewDirection, type CharacterViewPlanInput, type CharacterViewPublishInput, type CharacterViewSource } from "../shared/character-views.js";
import type { ProjectState, PromptImage, RunImageToolRequest } from "../shared/contracts.js";
import type { AuthorizeAgentAttachment } from "./agent-attachments.js";
import { saveAgentCanvasMedia } from "./agent-canvas-media.js";
import { localAgentPath } from "./agent-local-files.js";
import { toolPreflightError } from "./agent-tool-errors.js";
import { readCanvasAssets } from "./canvas-assets.js";
import type { CanvasStore } from "./canvas-workspace.js";
import { CharacterViewBindings, CharacterViewSealRejected, sameCharacterViewRevision, type CharacterViewNodeReservation, type CharacterViewNodeSeal } from "./character-view-bindings.js";
import { inspectCharacterViewRaster } from "./character-view-raster.js";
import type { CharacterViewOperationIdentity, CharacterViewPublicationJournal } from "./character-view-publication.js";
import { readCharacterViewSource } from "./character-views.js";
import { inspectProjectSourceBudget, type ProjectSourceProfile } from "./isolated-project-files.js";
import type { ProjectManager } from "./projects.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import type { ToolRunner } from "./tools.js";

const AUTHORING_MAX_BYTES = 256 * 1024;
const digest = (input: Uint8Array | string) => createHash("sha256").update(input).digest("hex");

interface RegisteredSource {
  assetId: string;
  path: string;
  sha256: string;
  raster?: Awaited<ReturnType<typeof inspectCharacterViewRaster>>;
}

interface ViewPlan {
  viewRevision: string;
  planFingerprint: string;
  boardId?: string;
  nodeId?: string;
  accepted?: RegisteredSource;
  provenance?: { status: "verified" | "unverified"; boardId?: string; nodeId?: string; jobId?: string };
  generation?: { model: RunImageToolRequest["imageModel"]; prompt: string; references: RegisteredSource[]; settings: object };
}

interface AuthoringRecord {
  schemaVersion: 1;
  setId: string;
  designRevision: string;
  designFingerprint: string;
  displayHeadToGround: number;
  design: { original: RegisteredSource; baseline: RegisteredSource; identity: string; camera: string; stance: string; asymmetry: string };
  views: Partial<Record<CharacterViewDirection, ViewPlan>>;
  preparedOperation: string;
}

export const characterViewAuthoringPath = (setId: string) => `assets/generated/character-sets/${setId}/authoring.json`;

function readRecord(bytes: Buffer, expectedSetId: string): AuthoringRecord {
  const record = JSON.parse(bytes.toString("utf8")) as Partial<AuthoringRecord> | null;
  if (!record || record.schemaVersion !== 1 || record.setId !== expectedSetId || typeof record.designRevision !== "string" ||
      !record.views || Array.isArray(record.views) || typeof record.views !== "object" ||
      !Number.isFinite(record.displayHeadToGround) || record.displayHeadToGround! <= 0) {
    throw new Error("The character authoring file is unavailable or invalid. Inspect the existing set before updating it.");
  }
  return record as AuthoringRecord;
}

/** Verify publication selections against approved sources or a retained original Canvas result. */
export async function checkCharacterViewAuthoring(
  bytes: Buffer, setId: string, input: CharacterViewPublishInput, projectId: string, canvas: CanvasStore,
) {
  const record = readRecord(bytes, setId);
  if (record.designRevision !== input.designRevision) throw toolPreflightError("The selected design revision changed. Refresh the character plan.", "invalid_character_view_input");
  for (const view of input.views) {
    const plan = record.views[view.direction];
    if (!plan || plan.viewRevision !== view.viewRevision) throw toolPreflightError(`${view.direction}: choose the prepared revision from the current authoring file.`, "invalid_character_view_input");
    if (plan.accepted) {
      const reference = view.source.kind === "canvas" ? plan.accepted.assetId : plan.accepted.path;
      if (view.source.reference !== reference || view.source.expectedSha256 !== plan.accepted.sha256) {
        throw toolPreflightError(`${view.direction}: selected source disagrees with the reviewed candidate.`, "invalid_character_view_input");
      }
    } else {
      if (!plan.boardId || !plan.nodeId || view.source.kind !== "canvas") throw toolPreflightError(`${view.direction}: choose the retained output of its prepared Canvas node.`, "invalid_character_view_input");
      const job = await canvas.managedCharacterViewJob(projectId, { boardId: plan.boardId, nodeId: plan.nodeId });
      if (job?.status !== "succeeded" || !job.run?.files.some(file => file.assetId === view.source.reference)) {
        throw toolPreflightError(`${view.direction}: the prepared Canvas result is unavailable. Review the original operation before publication.`, "invalid_character_view_input");
      }
      if (job.characterView?.sha256 !== view.source.expectedSha256) {
        throw toolPreflightError(`${view.direction}: use the original digest from this direction's generation receipt. Review the retained output before publication.`, "invalid_character_view_input");
      }
    }
  }
  return { displayHeadToGround: record.displayHeadToGround };
}

interface PlanOptions {
  project: ProjectState;
  setId: string;
  input: CharacterViewPlanInput;
  expectedAuthoringSha256: string | null;
  identity: CharacterViewOperationIdentity;
  journal: CharacterViewPublicationJournal;
  projects: ProjectManager;
  tools: ToolRunner;
  canvas: CanvasStore;
  authorizeAttachment: AuthorizeAgentAttachment;
  mutateWorkspace: <T>(operation: () => Promise<T>) => Promise<T>;
  sourceProfile?: () => Promise<ProjectSourceProfile | undefined>;
  signal?: AbortSignal;
}

/** Prepare original references and revision-bound Canvas nodes. No generation is submitted. */
export async function planCharacterViews(options: PlanOptions) {
  const { project, setId, input, canvas, tools, signal, journal, identity } = options;
  const workspace = project.workspacePath;
  const marker = characterViewAuthoringPath(setId);
  const recovered = await journal.recover(identity);
  if (recovered.state !== "missing") return recovered;
  if (new Set(input.views.map(view => view.direction)).size !== input.views.length) {
    throw toolPreflightError("List each requested character direction once.", "invalid_character_view_input");
  }
  const readAuthoring = async () => readSafeProjectFile(workspace, await localAgentPath(workspace, marker, true), AUTHORING_MAX_BYTES).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  const before = await readAuthoring();
  const authoringSha = before ? digest(before) : null;
  if (authoringSha !== options.expectedAuthoringSha256)
    throw toolPreflightError(`Review the current ${marker} before continuing. Its expectedAuthoringSha256 is ${authoringSha}.`, "invalid_character_view_input");
  const previous = before && readRecord(before, setId);
  const prior = previous?.designRevision === input.designRevision ? previous : undefined;
  const front = input.views.find(view => view.direction === "S");
  const adoptsFront = input.baseline && front && "source" in front &&
    front.source.kind === input.baseline.kind && front.source.reference === input.baseline.reference;
  const brief = prior ?? (adoptsFront ? previous : undefined);
  const pinned = (source: RegisteredSource): CharacterViewSource => ({ kind: "canvas", reference: source.assetId, expectedSha256: source.sha256 });
  const design = brief ? { ...brief.design, original: pinned(brief.design.original), baseline: pinned(brief.design.baseline), displayHeadToGround: brief.displayHeadToGround, ...input } : input;
  if (!Check(characterViewDesign, design)) {
    const missing = Object.keys(characterViewDesign.properties).filter(key => !(key in design));
    throw toolPreflightError(`Supply ${missing.join(", ") || "valid design settings"} for a new design. To promote a reviewed front in the existing set, pass the same source as baseline and as the S view.`, "invalid_character_view_input");
  }
  const readSource = (source: CharacterViewSource) => readCharacterViewSource(workspace, source, options.authorizeAttachment, signal);
  const seen = new Map<string, { sha256: string; length: number; source: CharacterViewSource }>();
  const rasters = new Map<string, Awaited<ReturnType<typeof inspectCharacterViewRaster>>>();
  const sourceKey = (source: CharacterViewSource) => JSON.stringify([source.kind, source.reference]);
  async function inspect(source: CharacterViewSource) {
    const data = await readSource(source);
    const prior = seen.get(sourceKey(source));
    if (prior && prior.sha256 !== data.sha256) throw toolPreflightError("A reference changed during preparation.", "invalid_character_view_input");
    if (!rasters.has(data.sha256)) {
      try {
        rasters.set(data.sha256, await inspectCharacterViewRaster(data.bytes));
      } catch (cause) {
        throw toolPreflightError(cause instanceof Error ? cause.message : "Cannot inspect the character image.", "invalid_character_view_input");
      }
    }
    seen.set(sourceKey(source), { sha256: data.sha256, length: data.bytes.length, source });
    return data;
  }
  const original = (await inspect(design.original)).sha256;
  const baseline = (await inspect(design.baseline)).sha256;
  const { identity: identityDescription, camera, stance, asymmetry, displayHeadToGround } = design;
  const fingerprint = digest(JSON.stringify([original, baseline, identityDescription, camera, stance, asymmetry, displayHeadToGround]));

  const draft: { view: CharacterViewPlanInput["views"][number]; fingerprint: string; settings?: object }[] = [];
  for (const view of input.views) {
    if ("source" in view) {
      const { sha256 } = await inspect(view.source);
      draft.push({ view, fingerprint: digest(JSON.stringify([view.direction, view.viewRevision, sha256])) });
    } else {
      const { model, references, resolution, aspectRatio, quality, complexity, pixelSize, prompt } = view;
      const images: PromptImage[] = [], hashes: string[] = [];
      for (const source of references) {
        const inspected = await inspect(source);
        images.push({ data: inspected.bytes.toString("base64"), mediaType: inspected.mediaType });
        hashes.push(inspected.sha256);
      }
      const settings = { resolution, aspectRatio, quality, complexity, pixelSize, outputFormat: "png", background: "transparent" } as const;
      const request = { ...settings, prompt, imageModel: model, images, outputs: 1 } satisfies RunImageToolRequest;
      const resolved = await tools.prepare("generate-image", request, project.id) as RunImageToolRequest;
      await tools.assertMediaInputOptions("generate-image", resolved);
      if (!isDeepStrictEqual(resolved.imageModel, model)) throw toolPreflightError(`${view.direction}: the selected model cannot be pinned to this plan.`, "invalid_character_view_input");
      // Older fingerprints include the saved model object's original key order.
      const savedModel = prior?.views[view.direction]?.generation?.model;
      const pinnedModel = savedModel && isDeepStrictEqual(savedModel, model) ? savedModel : model;
      draft.push({ view: { ...view, model: pinnedModel }, settings, fingerprint: digest(JSON.stringify([view.direction, view.viewRevision, prompt, pinnedModel, settings, hashes])) });
    }
  }
  return options.mutateWorkspace(async () => {
    signal?.throwIfAborted();
    if (!isDeepStrictEqual(await readAuthoring(), before)) throw toolPreflightError("The authoring file changed during preparation. Review the current plan.", "invalid_character_view_input");
    if (prior && prior.designFingerprint !== fingerprint) throw toolPreflightError("The design revision already uses a different brief or source. Omit the design fields to reuse the saved brief, or supply a new designRevision for an intentional change.", "invalid_character_view_input");
    for (const planned of draft) {
      const priorView = prior?.views[planned.view.direction];
      if (priorView?.viewRevision === planned.view.viewRevision && priorView.planFingerprint !== planned.fingerprint) {
        throw toolPreflightError(`${planned.view.direction}: revise the view revision when changing its frozen input.`, "invalid_character_view_input");
      }
    }
    const copies = new Map([...seen.values()].filter(source => source.source.kind !== "canvas").map(source => [source.sha256, source.length]));
    const total = [...copies.values()].reduce((sum, bytes) => sum + bytes, 0);
    const begun = await journal.begin(identity, { signal, space: { rawBytes: total, workingBytes: total, beforeBytes: before?.length ?? 0, afterBytes: AUTHORING_MAX_BYTES, manifestBytes: AUTHORING_MAX_BYTES, additionalEntries: seen.size + input.views.length } });
    if (begun.state !== "started") return begun;
    const { operation } = begun;
    const registered = new Map<string, RegisteredSource>();
    const nodes: { reservation: CharacterViewNodeReservation & { boardId: string }; generation: NonNullable<ViewPlan["generation"]>; saved: boolean }[] = [];
    let canvasWriteUnconfirmed = false;
    let markerPrepared = false;
    const canvasWrite = async <T>(write: () => Promise<T>) => {
      signal?.throwIfAborted();
      canvasWriteUnconfirmed = true;
      const result = await write();
      canvasWriteUnconfirmed = false;
      return result;
    };
    try {
      await operation.markEffectsStarted();
      async function register(source: CharacterViewSource) {
        const key = sourceKey(source);
        const existing = registered.get(key);
        if (existing) return existing;
        const inspected = await readSource({ ...source, expectedSha256: seen.get(key)!.sha256 });
        const locator = source.kind === "attachment" ? {
          attachmentReference: source.reference,
          image: { data: inspected.bytes.toString("base64"), mediaType: inspected.mediaType }, signal,
        } : source.kind === "workspace" ? { path: source.reference } : { assetId: source.reference };
        const result = await canvasWrite(async () => {
          const entered = await canvas.registerCharacterViewSource(project.id, locator);
          const verified = await readCharacterViewSource(workspace, { kind: "canvas", reference: entered.assetId, expectedSha256: inspected.sha256 });
          return { ...entered, sha256: verified.sha256, raster: rasters.get(verified.sha256) };
        });
        registered.set(key, result);
        return result;
      }
      const record: AuthoringRecord = {
        schemaVersion: 1, setId, designRevision: input.designRevision, designFingerprint: fingerprint, displayHeadToGround,
        design: { original: await register(design.original), baseline: await register(design.baseline), identity: identityDescription, camera, stance, asymmetry },
        views: { ...prior?.views }, preparedOperation: digest(identity.operationId),
      };
      let boardId = input.boardId;
      const seals: CharacterViewNodeSeal[] = [];
      for (const planned of draft) {
        signal?.throwIfAborted();
        const { view, fingerprint: planFingerprint } = planned;
        const entry: ViewPlan = { viewRevision: view.viewRevision, planFingerprint };
        if ("source" in view) {
          entry.accepted = await register(view.source);
          const reported = view.provenance;
          if (reported) {
            const job = (await canvas.jobs(project.id)).find(candidate => candidate.id === reported.jobId);
            if (job && (job.status !== "succeeded" || job.context?.boardId !== reported.boardId || job.context?.nodeId !== reported.nodeId ||
                !job.run?.files.some(file => file.assetId === entry.accepted?.assetId))) throw new Error(`${view.direction}: the retained job does not match this source.`);
            entry.provenance = { ...reported, status: job ? "verified" : "unverified" };
          } else entry.provenance = { status: "unverified" };
        } else {
          const references: RegisteredSource[] = [];
          for (const source of view.references) references.push(await register(source));
          const nodeId = `character-${digest(JSON.stringify([setId, input.designRevision, view.direction, view.viewRevision])).slice(0, 48)}`;
          const reservation = { boardId, nodeId, setId, designRevision: input.designRevision, direction: view.direction, viewRevision: view.viewRevision, displayHeadToGround, planFingerprint };
          const node = await canvasWrite(() => canvas.reserveCharacterViewNode(project.id, reservation));
          boardId = node.boardId;
          const generation = { model: view.model, prompt: view.prompt, references, settings: planned.settings ?? {} };
          const retained = { reservation: { ...reservation, boardId }, generation, saved: false };
          nodes.push(retained);
          await canvasWrite(() => saveAgentCanvasMedia(project.id, canvas, options.projects, tools, "generate-image", {
            ...generation.settings, prompt: view.prompt, imageModel: view.model, imagePaths: references.map(source => source.path),
          }, nodeId, node.boardId, undefined, signal, "pinned"));
          retained.saved = true;
          entry.boardId = boardId;
          entry.nodeId = nodeId;
          entry.generation = generation;
          seals.push({ boardId, nodeId, planFingerprint });
        }
        record.views[view.direction] = entry;
      }
      const after = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      if (after.length > AUTHORING_MAX_BYTES) throw new Error("The character authoring record exceeds its local file limit.");
      const budget = await inspectProjectSourceBudget(workspace, [{ path: marker, size: after.length }], true, signal, { profile: await options.sourceProfile?.() });
      if (!budget.complete || Object.values(budget.overage).some(value => value > 0)) throw new Error("The complete project inventory cannot admit this character plan.");
      if (seals.length) await canvasWrite(() => canvas.sealCharacterViewNodes(project.id, seals));
      const result = { authoringPath: marker, authoringSha256: digest(after), designRevision: record.designRevision,
        ...(input.delivery ? { delivery: input.delivery, setId } : {}),
        original: record.design.original, baseline: record.design.baseline, views: record.views };
      await operation.prepareCommit({ marker: { path: marker, before, after }, result });
      markerPrepared = true;
      signal?.throwIfAborted();
      await operation.publishMarker();
      return await operation.commit();
    } catch (cause) {
      // After effects start, even a source check cannot establish that the entire tool had no effect.
      const unknown = { state: "unknown" as const, operationId: identity.operationId,
        reason: `Cannot verify the original character preparation and its retained changes. ${cause instanceof Error ? cause.message : ""}`.trimEnd() };
      if (canvasWriteUnconfirmed && !(cause instanceof CharacterViewSealRejected)) return unknown;
      const retained = await (async () => {
        if (!markerPrepared && !isDeepStrictEqual(await readAuthoring(), before)) throw new Error("The original authoring record changed");
        const assets = await readCanvasAssets(workspace);
        for (const source of registered.values()) {
          if (assets.assets[source.assetId]?.path !== source.path) throw new Error("A retained source moved");
          await readCharacterViewSource(workspace, { kind: "canvas", reference: source.assetId, expectedSha256: source.sha256 });
        }
        const bindings = nodes.length ? await new CharacterViewBindings(await options.projects.getLocalImageRecoveryAnchor(project.id)).load() : [];
        const retainedNodes = [];
        for (const { reservation, generation, saved } of nodes) {
          const binding = bindings.find(entry => entry.boardId === reservation.boardId && entry.nodeId === reservation.nodeId);
          if (!binding || !sameCharacterViewRevision(binding, reservation) || binding.planFingerprint !== reservation.planFingerprint) throw new Error("A direction reservation changed");
          const { board } = await canvas.board(project.id, reservation.boardId);
          const node = board.nodes.find(candidate => candidate.id === reservation.nodeId);
          if (node && (node.type !== "image" || node.data.prompt !== generation.prompt || !isDeepStrictEqual(node.data.model, generation.model) ||
              Object.entries(generation.settings).some(([key, value]) => value !== undefined && node.data[key as keyof typeof node.data] !== value) ||
              !isDeepStrictEqual(node.data.images.map(reference => resolveAssetCanvasAssetId(board.nodes, reference)), generation.references.map(reference => reference.assetId)))) {
            throw new Error("A retained direction node changed");
          }
          const sealed = Boolean(binding.inputFingerprint && binding.nodeFingerprint);
          if ((saved || sealed) && !node) throw new Error("A retained direction node is missing");
          retainedNodes.push({ ...reservation, state: sealed ? "sealed-unpublished" : node ? "preparing" : "reserved" });
        }
        return { ready: false, authoringPath: marker, authoringSha256: before ? digest(before) : null, retainedSources: [...registered.values()], retainedNodes };
      })().catch(() => undefined);
      if (!retained) return unknown;
      const reason = cause instanceof CharacterViewSealRejected ? cause.message
        : "Character view preparation stopped before committing the new authoring record. Verified references and directions are retained.";
      return await operation.settleFailure(reason, retained);
    } finally {
      operation.detach();
    }
  });
}
