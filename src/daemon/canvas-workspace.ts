import { gptImage26Options } from "../shared/gpt-image-26.js";
import { CANVAS_TABLE_SCHEMA, createCanvasTable, isCanvasTable, canvasTablePath, type CanvasTable, type CanvasTableDetail } from "../shared/canvas-table.js";
import { createHash, randomUUID } from "node:crypto";
import { validVideoReferencePreparation } from "../shared/video-reference-preparation.js";
import { applyCanvasNodeLayout, canvasNodeContent, canvasNodeLayout, contentNodeSizeIssue, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
import { resolveVideoMentions } from "../shared/video-references.js";
import { chmod, lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readWebpModelReference } from "./image-working-assets.js";
import type { AssetCanvasNode, AssetCanvasReference, Model3DOptions, PromptImage, RunToolRequest, ToolJob, ToolId } from "../shared/contracts.js";
import { createCanvasBoard, fitCanvasLayout, isCanvasBoard, isCanvasIndex, CANVAS_INDEX_SCHEMA, CANVAS_BOARD_SCHEMA, CANVAS_LAYOUT_SCHEMA, type CanvasBoard, type CanvasBoardDetail, type CanvasBoardJobs, type CanvasCharacterViewStatus, type CanvasWorkspaceDetail, type CanvasWorkspaceIndex } from "../shared/canvas-workspace.js";
import { CANVAS_ASSETS_SCHEMA, canvasNodeAssetIds } from "../shared/canvas-assets.js";
import { combineAssetCanvasPrompt, createAssetCanvasDocument, resolveAssetCanvasAssetId, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { buildModel3DToolRequest, mediaGenerationNeedsConfirmation, resolveModel3D } from "../shared/generation-config.js";
import { requiresModelTurnaround } from "../shared/model3d-operations.js";
import { getWorkspaceMedia } from "./workspace.js";
import { createCanvasDocument, canvasDocumentPath, type CanvasDocumentDetail, type CanvasMarkdownDocument } from "../shared/canvas-document.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import { ToolRunError, type ToolRunner } from "./tools.js";
import { inheritToolPreflightFailure, toolPreflightError } from "./agent-tool-errors.js";
import { CanvasError, canvasPath, parseCanvasJson, readCanvasFile, writeCanvasFile as writeAtomic, writeCanvasJson as writeJson } from "./canvas-files.js";
import { canvasAssetCatalog, canvasLibraryAsset, ensureCanvasAssets, inspectCanvasAssets, readCanvasAssets } from "./canvas-assets.js";
import { CharacterViewBindings, CharacterViewSealRejected, characterViewFingerprint, matchesCharacterViewFingerprint, recordCharacterViewJobAlias, sameCharacterViewRevision, type CharacterViewBinding, type CharacterViewNodeReservation, type CharacterViewNodeSeal } from "./character-view-bindings.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import { RASTER_BYTES } from "./raster-policy.js";
export { CanvasError } from "./canvas-files.js";

type AgentCanvasSource = { path: string } | { assetId: string; audioReference?: true }
  | { attachmentReference: string; image: PromptImage; signal?: AbortSignal };

type CharacterViewAuthoringMarker = {
  schemaVersion?: number;
  setId?: string;
  designRevision?: string;
  views?: Partial<Record<CharacterViewBinding["direction"], Pick<CharacterViewBinding, "viewRevision" | "planFingerprint" | "boardId" | "nodeId"> & { accepted?: { assetId: string } }>>;
};

// Compare a diagonal against the straight view and its opposite turn at the same camera.
const characterReviewDirections: Record<CharacterViewBinding["direction"], CharacterViewBinding["direction"][]> = {
  N: ["S"], NE: ["N", "NW"], NW: ["N", "NE"], S: ["N"], SE: ["S", "SW"], SW: ["S", "SE"],
  E: ["W", "NE", "SE"], W: ["E", "NW", "SW"],
};

function invalidMediaInput(message: string, statusCode = 400): CanvasError {
  return inheritToolPreflightFailure(new CanvasError(message, statusCode), toolPreflightError(message, "invalid_media_options"));
}

function recoveryUnavailable(message: string): CanvasError {
  // This recovery stopped before start(). It says nothing about the original provider submission.
  return inheritToolPreflightFailure(new CanvasError(message, 409), toolPreflightError(message, "media_recovery_unavailable"));
}

const locks = new Map<string, Promise<unknown>>();
export function withCanvasLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const result = (locks.get(workspace) ?? Promise.resolve()).catch(() => {}).then(operation);
  locks.set(workspace, result);
  void result.finally(() => { if (locks.get(workspace) === result) locks.delete(workspace); }).catch(() => {});
  return result;
}
const validId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new CanvasError("Invalid canvas ID"); return id; };
const revision = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const CANVAS_MEDIA_WORKFLOW = "For provider-generated media, save its generation node on the board before calling generate_canvas_media. It records history, assets and results on that node. Keep internal Blender runs off the board. Present the checked candidate through recover_blender_run for final review or a checkpoint the user requested or needs to make a decision. Only register other media manually when the user should see the result and it already exists outside the board.";
const PREVIOUS_CANVAS_MEDIA_WORKFLOWS = [
  "Before submitting new project media, save its generation node on the board, then call generate_canvas_media. It records history, assets and results on that node. Only register a result manually when it already exists outside the board.",
  "After each media result is saved, register its path in assets.json and add or update its board node before the next long-running step. Do not defer board writes until the final response.",
];
const CANVAS_EDIT_RULE = "Consult the relevant README and schema sections when their contract is needed; read adjacent sections in one range. Batch independent replacements in one file in a single edit with edits[]. Submit independent file calls together. Run canvas_check on the completed group before using its result.";
const PREVIOUS_CANVAS_EDIT_RULES = [
  "Read README.md and schemas/ before changing a contract. Batch independent replacements in one file in a single edit with edits[]. Submit independent file calls together. Run canvas_check on the completed group before using its result.",
  "Read README.md and schemas/ before changing a contract. Run canvas_check after editing.",
];
const CANVAS_FILE_CONTEXT = "Use the current contents of referenced files when editing. Reuse the exact relevant text visible from this turn while the file is unchanged.";
const CANVAS_INSTRUCTIONS = `# Canvas workspace

Canvas files are the source of truth in both Design and Asset Canvas. Use normal read, edit, and write tools to create and change boards, nodes, documents, and references.

- ${CANVAS_EDIT_RULE}
- index.json lists boards, documents, optional tables, and the main document. Keep IDs stable; names and titles may change.
- boards/<id>.json contains nodes and their content. Every node may have a title and a description of its purpose. Document bodies live in documents/<id>.md, referenced by documentId. Table data lives in tables/<id>.json, referenced by tableId; register tables in index.json. Keep row/column IDs stable and match cells to their column types.
- Publish progress incrementally: add a document node as soon as its document is created; an index entry alone does not display a node. ${CANVAS_MEDIA_WORKFLOW} Reuse existing node and asset IDs and preserve user edits.
- Give nodes meaningful titles. Descriptions explain their intended role; do not describe unseen image pixels as verified facts.
- For game work, identify reference mockups and production assets in node titles/descriptions. Record production assets' intended gameplay use in the design document; reference mockups do not fulfill those requirements.
- editor/<board-id>.json stores positions, zoom, and width/height for text, document, and table nodes only; media and generation nodes size to their content. fitView requests a one-time fit when a remixed board is first opened; the editor clears it after saving the new viewport. New nodes are placed automatically; layout edits are only needed when the user asks to arrange the canvas.
- assets.json maps asset IDs to names, workspace-relative paths, optional descriptions and generation prompts. Use the same ID for the same asset across boards. References with type "library" resolve through this manifest. libraryAssetId records provenance; local files remain usable without the Library.
- For 3D game code, use get_model_asset to obtain validated runtimePath and local resource files. modelPreviewPath is a triangulated editor preview; FBX originals preserve topology. Keep glTF buffer files together in builds. Local rebuildPreview repairs existing resources without generation or billing. Private editor sources under .data/model-assets/ are retained for recovery/export, not isolated runtime URLs.
- Read actual image files with read when judging their appearance. A name, description, or generation prompt is not proof of what the image shows.
- promptSource references a text or document node. Text and document nodes accept references to text, document, image, or image asset nodes as AI source material. images, references, and source declare dependencies; their canvas lines are derived. Do not duplicate these relationships in edges.
- Voice nodes generate candidate audio from a description and sample script. Explicitly select or connect a generated sample to speech; connecting can adopt the current sample when none is selected, without generating. Existing bindings stay pinned until explicitly updated. Connections and audition never generate audio.
- Speech supports an optional local reference; missing or changed selected references must not fall back to unconditioned speech. Speech, voice, sound-effect, and music nodes use the shared audio model contract. Keep provider-specific credentials out of canvas files; select models by provider/id and only use options advertised by that model's capabilities.
- To add local media, register its workspace-relative path in assets.json and reference its ID from an asset node or an existing generation node. Asset nodes require both data.assetId and data.mediaType (image, video, audio, or model), matching the actual media. Do not omit mediaType or assume unknown media is an image. Board write/edit rejects invalid schemas before saving; correct the reported fields and retry.
- A file node points at any other project file by its project-relative path (data.path), such as a source file, font, archive or editor project; with directory: true it points at a folder whose structure matters, such as an asset pack. Files and folders imported on the canvas live under assets/files/. Read or use the files themselves; update the path if you move them.
- Game Canvas media marked canvasOnly are portable editor copies. When the game needs one, use use_canvas_asset with its assetId and a destination such as public/media/night-raid.mp4. Load the returned game file; leave unused candidates on the board.
- Do not trigger generation merely by editing a prompt or adding a reference. A game-creation request includes its needed media unless the user narrows the scope. Use generate_canvas_media with the saved boardId and nodeId for generation; it uses the node settings and shared generation history.
- A failed or cancelled node without output does not block unrelated work. Preserve its job history and valid assets, and continue with available results. An empty preview does not prove that the provider never accepted or billed the original request. Unavailable recovery cannot authorize a replacement. Leave application-managed jobs.json and private recovery inputs unchanged.
- If legacy jobs.json is too large to read or transfer, call canvas_initialize to compact its metadata while preserving original retry inputs. Do not truncate the history or raise source limits.
- Removing a node or board keeps its documents, tables, and assets. Remove references to a deleted node from the same board.
- An editor-context block identifies the current board and selected nodes. ${CANVAS_FILE_CONTEXT}
`;
const CANVAS_README = `# Canvas workspace

The canvas edits ordinary project files. Documents are Markdown and media files are available directly under assets/ in the project. Other files imported on the canvas are kept under assets/files/ and shown as file nodes.

| File | Content |
| --- | --- |
| index.json | Board IDs/names, document and table IDs/titles, and mainDocumentId |
| boards/<id>.json | Node IDs, optional titles/descriptions, content and references |
| documents/<id>.md | Canonical document body |
| tables/<id>.json | Typed columns and rows with stable IDs; cells keyed by column ID |
| assets.json | Asset IDs, names, project-relative file paths, descriptions and generation prompts |
| editor/<id>.json | Positions, text/document/table node dimensions and canvas viewport; missing node positions are filled automatically |
| schemas/ | Exact persisted file contracts |
| jobs.json | Compact generation history managed by the application; original retry inputs are private |

Read AGENTS.md for editing conventions. Asset paths are relative to the project root; Markdown image links are relative to the document file. Node IDs need only be unique within their board; asset, document and table IDs are shared across the canvas workspace.
`;
export async function ensureCanvasContract(workspace: string, replaceReadme = false): Promise<void> {
  for (const [name, value] of [["index", CANVAS_INDEX_SCHEMA], ["board", CANVAS_BOARD_SCHEMA], ["layout", CANVAS_LAYOUT_SCHEMA], ["assets", CANVAS_ASSETS_SCHEMA], ["table", CANVAS_TABLE_SCHEMA]] as const) {
    const file = `schemas/${name}.schema.json`, text = `${JSON.stringify(value, null, 2)}\n`;
    if (await readCanvasFile(workspace, file) !== text) await writeAtomic(workspace, file, text);
  }
  const previous = await readCanvasFile(workspace, "AGENTS.md");
  let updated = previous?.replace("Read the referenced files before editing, and preserve other user changes.", CANVAS_FILE_CONTEXT);
  for (const rule of PREVIOUS_CANVAS_EDIT_RULES) updated = updated?.replace(rule, CANVAS_EDIT_RULE);
  for (const rule of PREVIOUS_CANVAS_MEDIA_WORKFLOWS) updated = updated?.replace(rule, CANVAS_MEDIA_WORKFLOW);
  if (previous === undefined || previous !== CANVAS_INSTRUCTIONS && updated === CANVAS_INSTRUCTIONS)
    await writeAtomic(workspace, "AGENTS.md", CANVAS_INSTRUCTIONS);
  if (replaceReadme || await readCanvasFile(workspace, "README.md") === undefined)
    await writeAtomic(workspace, "README.md", CANVAS_README);
}
export async function readCanvasIndex(workspace: string): Promise<CanvasWorkspaceIndex | undefined> {
  const text = await readCanvasFile(workspace, "index.json", 512_000);
  if (text === undefined) return undefined;
  const value = parseCanvasJson<CanvasWorkspaceIndex>(text, "index.json", CANVAS_INDEX_SCHEMA);
  if (!isCanvasIndex(value)) throw new CanvasError("canvas/index.json: duplicate IDs or unknown mainDocumentId");
  return value;
}
async function ensureCanvasIndex(workspace: string): Promise<CanvasWorkspaceIndex> {
  const current = await readCanvasIndex(workspace);
  if (current) return current;
  for (const legacy of ["design", "canvas.json"]) {
    try { await lstat(path.join(workspace, legacy)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
    throw new CanvasError("This project uses the previous canvas format. Stop OhMyGame and run scripts/migrate-canvas-workspaces.ts against its data directory before opening it.", 409);
  }
  try {
    await lstat(path.join(workspace, "canvas"));
    throw new CanvasError("The canvas directory is missing index.json. Restore its index before opening it.", 409);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const board = createCanvasBoard();
  const index: CanvasWorkspaceIndex = { version: 1, boards: [{ id: board.id, name: "Untitled" }], documents: [] };
  await writeCanvasBoard(workspace, board);
  await writeJson(workspace, "assets.json", { version: 1, assets: {} });
  await ensureCanvasContract(workspace);
  await writeJson(workspace, "index.json", index);
  return index;
}
export async function readCanvasDocument(workspace: string, documentId?: string): Promise<CanvasDocumentDetail | undefined> {
  const index = await readCanvasIndex(workspace), id = documentId ?? index?.mainDocumentId;
  if (!id) return undefined;
  const entry = index?.documents.find((document) => document.id === validId(id));
  if (!entry) return undefined;
  return readDocumentEntry(workspace, entry);
}
async function readDocumentEntry(workspace: string, entry: CanvasWorkspaceIndex["documents"][number]): Promise<CanvasDocumentDetail> {
  const markdown = await readFile(await canvasPath(workspace, `documents/${entry.id}.md`), "utf8");
  if (Buffer.byteLength(markdown) > 2 * 1024 * 1024) throw new CanvasError("Canvas document is too large");
  const document = { ...entry, markdown };
  return { document, revision: revision(document) };
}
export function readCanvasDocuments(workspace: string, index: CanvasWorkspaceIndex): Promise<CanvasDocumentDetail[]> {
  return Promise.all(index.documents.map((entry) => readDocumentEntry(workspace, entry)));
}
export async function writeCanvasDocument(workspace: string, document: CanvasMarkdownDocument, selectMain = true): Promise<CanvasDocumentDetail> {
  if (!isCanvasDocument(document) || Buffer.byteLength(document.markdown) > 2 * 1024 * 1024) throw new CanvasError("Invalid or oversized canvas document");
  const index = await ensureCanvasIndex(workspace);
  const entry = index.documents.find((entry) => entry.id === document.id);
  if (!entry && index.documents.length >= 200) throw new CanvasError("The workspace supports up to 200 documents");
  await writeAtomic(workspace, `documents/${validId(document.id)}.md`, document.markdown);
  if (entry) entry.title = document.title;
  else index.documents.push({ id: document.id, title: document.title });
  if (selectMain) index.mainDocumentId ??= document.id;
  await writeJson(workspace, "index.json", index);
  return { document, revision: revision(document) };
}
export async function readCanvasTable(workspace: string, tableId: string): Promise<CanvasTableDetail | undefined> {
  validId(tableId);
  if (!(await readCanvasIndex(workspace))?.tables?.some((table) => table.id === tableId)) return undefined;
  return readTableFile(workspace, tableId);
}
async function readTableFile(workspace: string, tableId: string): Promise<CanvasTableDetail> {
  const file = `tables/${tableId}.json`, text = await readCanvasFile(workspace, file, 4 * 1024 * 1024);
  if (text === undefined) throw new CanvasError(`canvas/${file}: table file is missing`, 409);
  const table = parseCanvasJson<CanvasTable>(text, file, CANVAS_TABLE_SCHEMA);
  if (!isCanvasTable(table) || table.id !== tableId) throw new CanvasError(`canvas/${file}: invalid table IDs or cell types`);
  return { table, revision: revision(text) };
}
async function writeCanvasTable(workspace: string, table: CanvasTable): Promise<CanvasTableDetail> {
  if (!isCanvasTable(table)) throw new CanvasError("Invalid canvas table");
  const text = `${JSON.stringify(table, null, 2)}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new CanvasError("Canvas table is too large");
  const index = await ensureCanvasIndex(workspace);
  const tables = index.tables ??= [];
  const entry = tables.find((entry) => entry.id === table.id);
  if (!entry && tables.length >= 200) throw new CanvasError("The workspace supports up to 200 tables");
  await writeAtomic(workspace, `tables/${validId(table.id)}.json`, text);
  if (entry) entry.title = table.title;
  else tables.push({ id: table.id, title: table.title });
  await writeJson(workspace, "index.json", index);
  return { table, revision: revision(text) };
}
export async function readCanvasBoard(workspace: string, id: string): Promise<CanvasBoardDetail | undefined> {
  return (await inspectCanvasBoard(workspace, id))?.detail;
}
/** Reads a board and lists tolerated problems that canvas_check reports but the editor ignores. */
export async function inspectCanvasBoard(workspace: string, id: string): Promise<{ detail: CanvasBoardDetail; issues: string[] } | undefined> {
  const name = `boards/${validId(id)}.json`, text = await readCanvasFile(workspace, name);
  if (text === undefined) return undefined;
  const raw = parseCanvasJson<Omit<CanvasBoard, "editorLayout">>(text, name, CANVAS_BOARD_SCHEMA);
  const layoutName = `editor/${id}.json`, layoutText = await readCanvasFile(workspace, layoutName);
  const layout = layoutText === undefined ? createAssetCanvasDocument().editorLayout : parseCanvasJson<CanvasBoard["editorLayout"]>(layoutText, layoutName, CANVAS_LAYOUT_SCHEMA);
  const editorLayout = fitCanvasLayout(raw.nodes, layout), issues: string[] = [];
  for (const node of raw.nodes) {
    const { width, height, ...position } = editorLayout.nodes[node.id]!;
    if (isResizableCanvasNodeType(node.type) || (width === undefined && height === undefined)) continue;
    // Older agent edits could size content-sized nodes; ignore the size so those boards still open.
    editorLayout.nodes[node.id] = position;
    issues.push(contentNodeSizeIssue(node));
  }
  const board = { ...raw, editorLayout, nodes: raw.nodes.map((node) => applyCanvasNodeLayout(node, editorLayout.nodes[node.id]!)) };
  // The file schemas were checked above; validate cross-node rules once.
  try { validateAssetCanvasDocument(board); }
  catch (cause) { throw new CanvasError(`canvas/${name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (board.id !== id) throw new CanvasError(`canvas/${name}: board ID does not match its file name`);
  return { detail: { board, revision: revision([text, layoutText ?? ""]) }, issues };
}
function canvasBoardContent({ editorLayout: _, nodes, ...content }: CanvasBoard) {
  return { ...content, nodes: nodes.map(canvasNodeContent) };
}
async function writeCanvasBoard(workspace: string, board: CanvasBoard): Promise<CanvasBoardDetail> {
  if (!isCanvasBoard(board)) throw new CanvasError("Invalid canvas board");
  const text = `${JSON.stringify(canvasBoardContent(board), null, 2)}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new CanvasError("Canvas board is too large");
  await writeAtomic(workspace, `boards/${validId(board.id)}.json`, text);
  await writeJson(workspace, `editor/${board.id}.json`, board.editorLayout);
  return (await readCanvasBoard(workspace, board.id))!;
}
export async function canvasReferencesAsset(workspace: string, id: string, localPaths: readonly string[] = []): Promise<boolean> {
  const index = await readCanvasIndex(workspace);
  const manifest = await readCanvasAssets(workspace);
  const ids = new Set([id, ...Object.entries(manifest.assets).filter(([, asset]) => asset.libraryAssetId === id).map(([key]) => key)]);
  const paths = [...new Set([...localPaths, ...Object.entries(manifest.assets).filter(([key]) => ids.has(key)).map(([, asset]) => asset.path)])];
  if (!index) {
    try { await lstat(path.join(workspace, "canvas")); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
    throw new CanvasError("Canvas index data is missing", 409);
  }
  // Count literal or URL-encoded local paths conservatively, including Markdown links and file-node content.
  const mentionsPath = (content: string) => {
    const decoded = content.replace(/(?:%[a-f\d]{2})+/gi, (value) => { try { return decodeURIComponent(value); } catch { return value; } });
    if (paths.some((file) => decoded.includes(file) || decoded.replace(/\/\.\//g, "/").includes(file))) return true;
    return content.split(/[\s"'<>()[\]`\\]+/).some((token) => {
      try { token = decodeURIComponent(token); } catch { /* Keep undecodable text literal. */ }
      return paths.some((file) => path.posix.normalize(token).includes(file));
    });
  };
  for (const entry of index?.boards ?? []) {
    const detail = await readCanvasBoard(workspace, entry.id);
    if (!detail) throw new CanvasError("Canvas board data is missing", 409);
    if (canvasNodeAssetIds(detail.board.nodes).some((assetId) => ids.has(assetId))) return true;
    if (mentionsPath(JSON.stringify(detail.board.nodes)) || detail.board.nodes.some((node) => node.type === "file" && node.data.directory && paths.some((file) => file.startsWith(`${node.data.path}/`)))) return true;
  }
  if (index && paths.length) {
    for (const detail of await readCanvasDocuments(workspace, index)) if (mentionsPath(detail.document.markdown)) return true;
    for (const entry of index.tables ?? []) if (mentionsPath(JSON.stringify((await readTableFile(workspace, entry.id)).table))) return true;
  }
  return false;
}

export async function canvasLibraryAssetUsage(workspace: string): Promise<Map<string, boolean>> {
  const index = await readCanvasIndex(workspace);
  const manifest = await readCanvasAssets(workspace);
  const usage = new Map<string, boolean>();
  const libraryId = (id: string) => manifest.assets[id]?.libraryAssetId ?? id;
  for (const id of Object.keys(manifest.assets)) usage.set(libraryId(id), false);
  for (const entry of index?.boards ?? []) {
    const detail = await readCanvasBoard(workspace, entry.id);
    if (!detail) throw new CanvasError("Canvas board data is missing", 409);
    for (const id of canvasNodeAssetIds(detail.board.nodes)) {
      if (!usage.has(libraryId(id))) usage.set(libraryId(id), false);
    }
    for (const node of detail.board.nodes) {
      if ("assetId" in node.data && node.data.assetId) usage.set(libraryId(node.data.assetId), true);
    }
  }
  return usage;
}
export async function renameCanvasAssetPaths(workspace: string, from: string, to: string): Promise<void> {
  await withCanvasLock(workspace, async () => {
    const manifest = await readCanvasAssets(workspace);
    const renamed = Object.values(manifest.assets).filter((asset) => asset.path === from || asset.path.startsWith(`${from}/`));
    if (!renamed.length) return;
    const links = renamed.map((asset) => {
      const oldPath = asset.path;
      asset.path = `${to}${oldPath.slice(from.length)}`;
      if (oldPath === from && asset.name === path.posix.basename(oldPath)) asset.name = path.posix.basename(to);
      return [oldPath, asset.path] as const;
    });
    const index = await readCanvasIndex(workspace);
    const documents = index ? await readCanvasDocuments(workspace, index) : [];
    await writeJson(workspace, "assets.json", manifest);
    for (const detail of documents) {
      let markdown = detail.document.markdown;
      for (const [oldPath, newPath] of links) {
        const link = (file: string) => `../../${file.split("/").map(encodeURIComponent).join("/")}`;
        markdown = markdown.replaceAll(`](${link(oldPath)})`, `](${link(newPath)})`);
      }
      if (markdown !== detail.document.markdown) await writeAtomic(workspace, `documents/${detail.document.id}.md`, markdown);
    }
  });
}

export async function removeCanvasAssetReferences(workspace: string, assetIds: string | readonly string[], options: { localOnly?: boolean; checkOnly?: boolean } = {}): Promise<void> {
  const requested = new Set(typeof assetIds === "string" ? [assetIds] : assetIds);
  if (!requested.size) return;
  await withCanvasLock(workspace, async () => {
    const index = await readCanvasIndex(workspace);
    const manifest = await readCanvasAssets(workspace);
    const ids = new Set([...requested, ...Object.entries(manifest.assets).filter(([, asset]) => !options.localOnly && asset.libraryAssetId && requested.has(asset.libraryAssetId)).map(([key]) => key)]);
    const boards = await Promise.all((index?.boards ?? []).map(async (entry) => {
      const detail = await readCanvasBoard(workspace, entry.id);
      if (!detail) throw new CanvasError("Canvas board data is missing", 409);
      const removed = new Set(detail.board.nodes.filter((node) => node.type === "asset" && ids.has(node.data.assetId)).map((node) => node.id));
      const removesReference = (reference: AssetCanvasReference) => reference.type === "library" ? ids.has(reference.assetId) : removed.has(reference.nodeId);
      for (const node of detail.board.nodes) {
        if (node.type !== "model-3d" || !node.data.images.length) continue;
        // For unrecognized custom connections the stored T/A pose may require directional inputs.
        const protocol = node.data.model && resolveModel3D(node.data.model)?.protocol;
        if (!requiresModelTurnaround(node.data.options, protocol ?? "tripo", node.data.operation ?? "image")) continue;
        const first = node.data.images.findIndex(removesReference);
        if (first >= 0 && node.data.images.slice(first + 1).some((image) => !removesReference(image))) {
          const view = ["Front", "Left", "Back", "Right"][first];
          throw new CanvasError(`Replace the ${view} image in "${node.title || node.id}" on board "${entry.name}" before deleting its asset. Removing it would shift the other views.`, 409);
        }
      }
      return { detail, removed, removesReference };
    }));
    if (options.checkOnly) return;
    const removedLinks = new Set([...ids].flatMap((assetId) => manifest.assets[assetId] ? [`../../${manifest.assets[assetId]!.path.split("/").map(encodeURIComponent).join("/")}`] : []));
    if (index && removedLinks.size) {
      const removedImages = new RegExp(`!\\[[^\\]\\n]*\\]\\((?:${[...removedLinks].map((link) => link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\)`, "g");
      for (const detail of await readCanvasDocuments(workspace, index)) {
        const markdown = detail.document.markdown.replace(removedImages, "");
        if (markdown !== detail.document.markdown) await writeAtomic(workspace, `documents/${detail.document.id}.md`, markdown);
      }
    }
    for (const { detail, removed, removesReference } of boards) {
      if (!canvasNodeAssetIds(detail.board.nodes).some((assetId) => ids.has(assetId))) continue;
      detail.board.nodes = detail.board.nodes.filter((node) => !removed.has(node.id)).map((node) => {
        const data = { ...node.data };
        if ("assetId" in data && data.assetId && ids.has(data.assetId)) delete data.assetId;
        if ("referenceAssetId" in data && data.referenceAssetId && ids.has(data.referenceAssetId)) {
          delete data.referenceAssetId;
          delete data.referenceSha256;
          delete data.voiceSourceNodeId;
        } else if ("voiceSourceNodeId" in data && data.voiceSourceNodeId && removed.has(data.voiceSourceNodeId)) {
          // Disconnect a removed source node without dropping a different pinned recording.
          delete data.voiceSourceNodeId;
        }
        if ("selectedAssetId" in data && data.selectedAssetId && ids.has(data.selectedAssetId)) {
          delete data.selectedAssetId;
          delete data.selectedSha256;
        }
        if ("images" in data) data.images = data.images.filter((reference) => !removesReference(reference));
        if ("references" in data && data.references) data.references = data.references.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId));
        if ("mask" in data && data.mask && removesReference(data.mask)) delete data.mask;
        if ("markup" in data && data.markup && removesReference(data.markup)) delete data.markup;
        if ("source" in data && data.source && (data.source.type === "library" ? ids.has(data.source.assetId) : removed.has(data.source.nodeId))) delete data.source;
        return { ...node, data } as AssetCanvasNode;
      });
      detail.board.edges = detail.board.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
      detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, canvasNodeLayout(node)]));
      await writeCanvasBoard(workspace, detail.board);
    }
    if ([...ids].some((assetId) => manifest.assets[assetId])) {
      for (const assetId of ids) delete manifest.assets[assetId];
      await writeJson(workspace, "assets.json", manifest);
    }
  });
}
type StoredJob = ToolJob & { input?: RunToolRequest; unreadInput?: { retainedInput: string }; recoveryId?: string };
function managedImageNodeSettings(node: Extract<AssetCanvasNode, { type: "image" }>) {
  const { assetId: _result, ...settings } = node.data;
  return settings;
}

export class CanvasStore {
  readonly #executions = new Map<string, Set<Promise<void>>>();

  isProjectBusy(id: string): boolean { return Boolean(this.#executions.get(id)?.size); }
  async waitForProject(id: string): Promise<void> {
    while (this.#executions.get(id)?.size) await Promise.allSettled([...this.#executions.get(id)!]);
  }
  readonly #jobs = new Map<string, StoredJob[]>();
  readonly #savedInputs = new Map<string, string>();
  readonly #controllers = new Map<StoredJob, AbortController>();
  #closed = false;
  constructor(private readonly projects: ProjectManager, private readonly library: AssetLibrary, private readonly tools: ToolRunner) {}
  #project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new CanvasError("Project not found", 404);
    if (project.workspaceAvailable === false) throw new CanvasError("Canvas requires an available project workspace", 409);
    return project;
  }
  async read(id: string, documentId?: string) { return readCanvasDocument(this.#project(id).workspacePath, documentId); }
  async exportAsset(id: string, assetId: string) { return { assetId: await canvasLibraryAsset(this.#project(id), this.library, assetId) }; }
  async modelPreview(id: string, assetId: string, rebuild = false) {
    const project = this.#project(id), libraryId = await canvasLibraryAsset(project, this.library, assetId);
    if (rebuild) {
      const asset = await this.library.rebuildModelPreview(libraryId);
      await withCanvasLock(project.workspacePath, async () => {
        const manifest = await readCanvasAssets(project.workspacePath), previous = manifest.assets[assetId];
        if (!previous) throw new CanvasError("Canvas asset not found", 404);
        const file = await this.projects.materializeLibraryAsset(id, libraryId, true, previous.canvasOnly === true);
        manifest.assets[assetId] = { ...previous, libraryAssetId: libraryId, model3d: asset.model3d, modelPreviewPath: file.modelPreviewPath, modelRuntimePath: file.modelRuntimePath };
        await writeJson(project.workspacePath, "assets.json", manifest);
      });
    }
    return this.library.openContent(libraryId, undefined, true);
  }
  async workspace(id: string): Promise<CanvasWorkspaceDetail> {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace);
      const tableIssues: NonNullable<CanvasWorkspaceDetail["tableIssues"]> = [];
      const tables = (await Promise.all((index.tables ?? []).map(async (entry) => {
        try { const detail = await readTableFile(workspace, entry.id); return { ...detail.table, revision: detail.revision, source: canvasTablePath(entry.id) }; }
        catch (cause) { tableIssues.push({ ...entry, source: canvasTablePath(entry.id), message: cause instanceof Error ? cause.message : String(cause) }); return undefined; }
      }))).filter((table) => table !== undefined);
      const documentIssues: NonNullable<CanvasWorkspaceDetail["documentIssues"]> = [];
      const documents = (await Promise.all(index.documents.map(async (entry) => {
        try { return await readDocumentEntry(workspace, entry); }
        catch (cause) {
          documentIssues.push({ ...entry, source: canvasDocumentPath(entry.id), message: cause instanceof Error ? cause.message : String(cause) });
          return undefined;
        }
      }))).filter((document) => document !== undefined);
      await ensureCanvasContract(workspace);
      const assets = await inspectCanvasAssets(workspace, await readCanvasAssets(workspace));
      return { ...index, ...assets, tables, tableIssues, documentIssues, documents: documents.map((detail) => ({ ...detail.document, revision: detail.revision, source: canvasDocumentPath(detail.document.id), main: detail.document.id === index.mainDocumentId })) };
    });
  }
  async createDocument(id: string, title: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, () => writeCanvasDocument(workspace, createCanvasDocument(title.trim() || "Untitled document"), project.type !== "asset-canvas"));
  }
  async save(id: string, document: CanvasMarkdownDocument, expected: string, documentId?: string) {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await readCanvasDocument(workspace, documentId);
      if (!current) throw new CanvasError("Document not found", 404);
      if (current.revision !== expected) throw new CanvasError("The document changed. Review the latest version before saving.", 409);
      if (current.document.id !== document.id) throw new CanvasError("The document ID must stay unchanged");
      return writeCanvasDocument(workspace, document, this.#project(id).type !== "asset-canvas");
    });
  }
  async table(id: string, tableId: string): Promise<CanvasTableDetail> {
    const detail = await readCanvasTable(this.#project(id).workspacePath, tableId);
    if (!detail) throw new CanvasError("Table not found", 404);
    return detail;
  }
  async createTable(id: string, title: string): Promise<CanvasTableDetail> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, () => writeCanvasTable(workspace, createCanvasTable(title)));
  }
  async saveTable(id: string, table: CanvasTable, expected: string): Promise<CanvasTableDetail> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await this.table(id, table.id);
      if (current.revision !== expected) throw new CanvasError("The table changed. Review the latest version before saving.", 409);
      return writeCanvasTable(workspace, table);
    });
  }
  async setMainDocument(id: string, documentId: string) {
    if (this.#project(id).type === "asset-canvas") throw new CanvasError("Main game design documents require a game project", 409);
    const workspace = this.#project(id).workspacePath;
    await withCanvasLock(workspace, async () => {
      if (!await readCanvasDocument(workspace, documentId)) throw new CanvasError("Document not found", 404);
      const index = (await readCanvasIndex(workspace))!; index.mainDocumentId = documentId;
      await writeJson(workspace, "index.json", index);
    });
  }
  async board(id: string, boardId: string): Promise<CanvasBoardDetail> {
    const workspace = this.#project(id).workspacePath;
    if (!(await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) throw new CanvasError("Canvas board not found", 404);
    const detail = await readCanvasBoard(workspace, boardId);
    if (!detail) throw new CanvasError("Canvas board data is missing", 409);
    return detail;
  }
  async saveBoard(id: string, board: CanvasBoard, expected: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await this.board(id, board.id);
      if (current.revision !== expected) throw new CanvasError("The board changed. Reload the latest board before saving.", 409);
      if (!isCanvasBoard(board)) throw new CanvasError("Invalid canvas board");
      const index = (await readCanvasIndex(workspace))!;
      const documents = index.documents;
      const existingTables = new Set(current.board.nodes.flatMap((node) => node.type === "table" ? [node.data.tableId] : []));
      if (board.nodes.some((node) => node.type === "table" && !existingTables.has(node.data.tableId) && !index.tables?.some((table) => table.id === node.data.tableId))) throw new CanvasError("Table reference not found", 404);
      const existingDocuments = new Set(current.board.nodes.flatMap((node) => node.type === "document" ? [node.data.documentId] : []));
      if (board.nodes.some((node) => node.type === "document" && !existingDocuments.has(node.data.documentId) && !documents.some((document) => document.id === node.data.documentId))) throw new CanvasError("Document reference not found", 404);
      await ensureCanvasAssets(project, this.projects, this.library, canvasNodeAssetIds(board.nodes), canvasNodeAssetIds(current.board.nodes));
      const detail = await writeCanvasBoard(workspace, board);
      await this.projects.touch(id);
      return detail;
    });
  }
  /** Add retained local review media without replacing the user's nodes or layout. */
  async presentLocalAssets(id: string, files: readonly { nodeId: string; path: string; title: string }[], boardId?: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace);
      const nodeIds = new Set(files.map(entry => entry.nodeId));
      const requested = boardId ? (await this.board(id, boardId)).board : undefined;
      let board = requested;
      if (!board?.nodes.some(node => nodeIds.has(node.id))) {
        // A board write can succeed before its caller retains the delivery receipt.
        const existing = [];
        for (const item of index.boards) {
          if (item.id === requested?.id) continue;
          const candidate = (await this.board(id, item.id)).board;
          if (candidate.nodes.some(node => nodeIds.has(node.id))) existing.push(candidate);
        }
        if (existing.length > 1) throw new CanvasError("The retained review nodes exist on multiple boards; review their original placement before recovery", 409);
        if (requested && existing.length) throw new CanvasError("The original Blender review board changed; review its retained placement before recovery", 409);
        board = requested ?? existing[0] ?? (await this.board(id, index.boards[0]!.id)).board;
      }
      const entries = [];
      for (const file of files) {
        validId(file.nodeId);
        const entry = { ...file, assetId: await this.projects.ensureLibraryAsset(id, file.path) };
        entries.push(entry);
        const node = board.nodes.find(node => node.id === entry.nodeId);
        if (node && (node.type !== "asset" || node.data.assetId !== entry.assetId))
          throw new CanvasError("A retained review node changed its asset or type; preserving the user's edit instead of replacing it", 409);
      }
      const pending = entries.filter(entry => !board.nodes.some(node => node.id === entry.nodeId));
      if (pending.length) {
        const manifest = await ensureCanvasAssets(project, this.projects, this.library, pending.map(entry => entry.assetId));
        const assets = await canvasAssetCatalog(workspace, manifest, pending.map(entry => entry.assetId));
        for (const entry of pending) {
          const asset = assets.find(asset => asset.id === entry.assetId)!;
          board.nodes.push({ id: entry.nodeId, type: "asset", position: { x: 0, y: 0 }, title: entry.title, data: { assetId: entry.assetId, mediaType: asset.mediaType } });
        }
        board.editorLayout = fitCanvasLayout(board.nodes, board.editorLayout);
        for (const node of board.nodes) node.position = board.editorLayout.nodes[node.id]!;
        await writeCanvasBoard(workspace, board);
        await this.projects.touch(id);
      }
      return { boardId: board.id, nodeIds: entries.map(entry => entry.nodeId), assetsByPath: Object.fromEntries(entries.map(entry => [entry.path, entry.assetId])) };
    });
  }
  async #registerAgentCanvasSource(id: string, source: AgentCanvasSource, manifest: Awaited<ReturnType<typeof readCanvasAssets>>) {
    const project = this.#project(id), workspace = project.workspacePath;
    let assetId: string;
    if ("path" in source) {
      const file = await getWorkspaceMedia(workspace, source.path);
      assetId = Object.entries(manifest.assets).find(([, asset]) => asset.path === file.relativePath)?.[0]
        ?? await this.projects.ensureLibraryAsset(id, file.relativePath);
    } else if ("attachmentReference" in source) {
      source.signal?.throwIfAborted();
      const bytes = Buffer.from(source.image.data, "base64"), digest = createHash("sha256").update(bytes).digest("hex");
      if (!["image/png", "image/jpeg", "image/webp"].includes(source.image.mediaType)) throw new CanvasError("Attachment references require PNG, JPEG or WebP");
      const extension = source.image.mediaType === "image/jpeg" ? "jpg" : source.image.mediaType.slice(6);
      assetId = (await this.library.add(`attachment-${digest}.${extension}`, bytes, {
        origin: "uploaded", purpose: "reference", signal: source.signal, saved: false,
        sourceKey: `project:${id}:attachment:${createHash("sha256").update(JSON.stringify([id, source.attachmentReference, digest])).digest("hex")}`,
      })).id;
    } else assetId = source.assetId;
    const assets = await ensureCanvasAssets(project, this.projects, this.library, [assetId]);
    return { assetId, path: assets.assets[assetId]!.path };
  }

  /** Register project-owned or authorized attachment reference bytes without creating a generation node. */
  async registerCharacterViewSource(id: string, source: AgentCanvasSource) {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      await ensureCanvasIndex(workspace);
      await ensureCanvasContract(workspace);
      return this.#registerAgentCanvasSource(id, source, await readCanvasAssets(workspace));
    });
  }

  /** Publish an agent request and its sources atomically before any provider call. */
  async createAgentMediaNode(id: string, nodeId: string, create: (reference: (source: AgentCanvasSource) => Promise<AssetCanvasReference>) => Promise<AssetCanvasNode>, boardId?: string, referenceMode?: "pinned"): Promise<{ boardId: string; nodeId: string }> {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace);
      await ensureCanvasContract(workspace);
      const selected = boardId ?? index.boards[0]!.id;
      const { board } = await this.board(id, selected);
      if (board.nodes.some(node => node.id === nodeId)) return { boardId: selected, nodeId };
      const manifest = await readCanvasAssets(workspace);
      const node = await create(async source => {
        const { assetId } = await this.#registerAgentCanvasSource(id, source, manifest);
        const existing = board.nodes.find(node => "assetId" in node.data && node.data.assetId === assetId
          && (referenceMode !== "pinned" || node.type === "asset")
          && (!("audioReference" in source && source.audioReference) || node.type === "voice" || node.type === "asset" && node.data.mediaType === "audio"));
        if (existing) return { type: "node", nodeId: existing.id };
        const asset = (await canvasAssetCatalog(workspace, await readCanvasAssets(workspace), [assetId]))[0]!;
        const sourceId = randomUUID();
        board.nodes.push({ id: sourceId, type: "asset", position: { x: 0, y: 0 }, title: asset.name, description: "path" in source ? `Project source: ${source.path}` : "attachmentReference" in source ? `Chat attachment: ${source.attachmentReference}` : `Library source: ${source.assetId}`, data: { assetId, mediaType: asset.mediaType } });
        return { type: "node", nodeId: sourceId };
      });
      node.id = nodeId;
      board.nodes.push(node);
      board.editorLayout = fitCanvasLayout(board.nodes, board.editorLayout);
      for (const entry of board.nodes) entry.position = board.editorLayout.nodes[entry.id]!;
      await writeCanvasBoard(workspace, board);
      await this.projects.touch(id);
      return { boardId: selected, nodeId };
    });
  }

  async #characterViewBindings(id: string) {
    if (this.#project(id).type !== "web-game") return undefined;
    const storage = new CharacterViewBindings(await this.projects.getLocalImageRecoveryAnchor(id));
    return { storage, records: await storage.load() };
  }

  /** Reserve the address before the node can be observed through the Canvas. */
  async reserveCharacterViewNode(id: string, input: CharacterViewNodeReservation): Promise<{ boardId: string; nodeId: string }> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const state = await this.#characterViewBindings(id);
      if (!state) throw new CanvasError("Managed character views require a Web Game project", 409);
      const index = await ensureCanvasIndex(workspace);
      const boardId = validId(input.boardId ?? index.boards[0]!.id);
      const nodeId = validId(input.nodeId);
      const { setId, designRevision, direction, viewRevision, displayHeadToGround, planFingerprint } = input;
      const candidate: CharacterViewBinding = { boardId, nodeId, setId, designRevision, direction, viewRevision, displayHeadToGround, planFingerprint };
      const previous = state.records.find(record => record.boardId === boardId && record.nodeId === nodeId ||
        sameCharacterViewRevision(record, candidate));
      if (previous) {
        if (previous.boardId !== boardId || previous.nodeId !== nodeId ||
            !sameCharacterViewRevision(previous, candidate) || previous.planFingerprint !== candidate.planFingerprint)
          throw new CanvasError("This managed character revision is already bound to different inputs or a different node", 409);
        return { boardId, nodeId };
      }
      if ((await this.board(id, boardId)).board.nodes.some(node => node.id === nodeId))
        throw new CanvasError("A different Canvas node already uses this managed direction's ID", 409);
      state.records.push(candidate);
      await state.storage.save(state.records);
      return { boardId, nodeId };
    });
  }

  async sealCharacterViewNodes(id: string, views: readonly CharacterViewNodeSeal[]): Promise<void> {
    const workspace = this.#project(id).workspacePath;
    await withCanvasLock(workspace, async () => {
      const state = await this.#characterViewBindings(id);
      if (!state) throw new CanvasError("Managed character views require a Web Game project", 409);
      if (!views.length || views.length > 8) throw new CanvasError("Seal one through eight managed directions");
      const manifest = await readCanvasAssets(workspace);
      for (const view of views) {
        const record = state.records.find(record => record.boardId === view.boardId && record.nodeId === view.nodeId);
        if (!record || view.planFingerprint !== record.planFingerprint)
          throw new CanvasError("This direction does not match its managed plan reservation", 409);
        const { board } = await this.board(id, view.boardId);
        const node = board.nodes.find(node => node.id === view.nodeId);
        if (node?.type !== "image" || !node.data.model || node.data.outputFormat !== "png" ||
            node.data.background !== "transparent" || !node.data.images.length)
          throw new CanvasError("Managed directions require an explicit image model, references and transparent PNG settings");
        for (const reference of [...node.data.images, node.data.mask, node.data.markup]) {
          if (reference?.type === "node" && board.nodes.find(node => node.id === reference.nodeId)?.type !== "asset")
            throw new CharacterViewSealRejected("Pin a saved image asset as the direction's reference");
        }
        const linkedText = await this.#linkedPrompt(id, board, node.data.promptSource?.nodeId);
        const request = await this.#imageNodeInput(node, linkedText, reference => {
          const assetId = resolveAssetCanvasAssetId(board.nodes, reference);
          if (!assetId || !manifest.assets[assetId]) throw new CanvasError("A managed direction reference is missing");
          return this.#readCanvasImage(id, manifest.assets[assetId]!.path, assetId, "image", true);
        });
        const prepared = await this.tools.prepare("generate-image", request, id);
        await this.tools.assertMediaInputOptions("generate-image", prepared);
        if (record.inputFingerprint && !matchesCharacterViewFingerprint(prepared, record.inputFingerprint))
          throw new CharacterViewSealRejected("The managed direction no longer matches its frozen inputs. Use a new direction revision.");
        record.inputFingerprint ??= characterViewFingerprint(prepared);
        record.nodeFingerprint = characterViewFingerprint(managedImageNodeSettings(node));
      }
      // A batch becomes ready in one durable index replacement.
      await state.storage.save(state.records);
    });
  }

  async #managedResultDigest(job: ToolJob) {
    const assetId = job.run?.files[0]?.assetId;
    if (!assetId) throw new CanvasError("Managed character result has no retained original", 409);
    const { snapshot } = await this.library.openSnapshot(assetId, RASTER_BYTES);
    try { return snapshot.sha256; } finally { await snapshot.release(); }
  }

  #readCharacterViewAuthoring(root: string, setId: string): Promise<CharacterViewAuthoringMarker | undefined> {
    const file = path.join(root, "assets", "generated", "character-sets", setId, "authoring.json");
    return readSafeProjectFile(root, file, 2 * 1024 * 1024)
      .then(bytes => JSON.parse(bytes.toString("utf8")))
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
  }

  #matchesCharacterViewAuthoring(current: CharacterViewAuthoringMarker | undefined, record: CharacterViewBinding) {
    const view = current?.views?.[record.direction];
    return current?.schemaVersion === 1 && current.setId === record.setId &&
      current.designRevision === record.designRevision && view?.viewRevision === record.viewRevision &&
      view.planFingerprint === record.planFingerprint && view.boardId === record.boardId && view.nodeId === record.nodeId;
  }

  async #assertCharacterViewAuthoring(workspace: string, record: CharacterViewBinding) {
    const current = await this.#readCharacterViewAuthoring(await realpath(workspace), record.setId);
    if (!this.#matchesCharacterViewAuthoring(current, record))
      throw new CanvasError("The managed direction plan has not been committed or has changed. No generation was submitted.", 409);
  }

  async #observeCharacterView(id: string, record: CharacterViewBinding): Promise<StoredJob | undefined> {
    const attempt = record.attempt;
    if (!attempt || attempt.phase === "prepared") return undefined;
    if (attempt.phase === "succeeded") {
      const sha256 = await this.#managedResultDigest(attempt.job);
      if (sha256 !== attempt.resultSha256)
        throw new CanvasError("The retained character direction result no longer matches its original", 409);
      await ensureCanvasAssets(this.#project(id), this.projects, this.library, [attempt.job.run!.files[0]!.assetId!]);
      return { ...attempt.job, recoveryId: attempt.recoveryId, characterView: { direction: record.direction, viewRevision: record.viewRevision, displayHeadToGround: record.displayHeadToGround, sha256 } };
    }
    const current = this.#jobs.get(id)?.find(job => job.id === attempt.job.id && job.recoveryId === attempt.recoveryId);
    if (attempt.phase === "admitted" && current?.status === "running") return current;
    if (attempt.phase === "not-submitted") return { ...attempt.job, recoveryId: attempt.recoveryId };
    return {
      ...attempt.job, recoveryId: attempt.recoveryId, status: "failed",
      error: attempt.job.error ?? "The managed direction may already have been submitted. Recover its original result; no replacement was sent.",
      submissionOutcome: "unknown",
    };
  }

  async characterReviewNeighbors(id: string, boardId: string, nodeId: string) {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const records = (await this.#characterViewBindings(id))?.records ?? [];
      const candidate = records.find(record => record.boardId === boardId && record.nodeId === nodeId);
      if (!candidate) return [];
      const current = await this.#readCharacterViewAuthoring(await realpath(workspace), candidate.setId);
      if (!this.#matchesCharacterViewAuthoring(current, candidate)) return [];
      const neighbors = [];
      for (const direction of characterReviewDirections[candidate.direction]) {
        const view = current?.views?.[direction];
        if (!view) continue;
        const source = records.find(record => record.direction === direction && this.#matchesCharacterViewAuthoring(current, record));
        const assetId = view.accepted?.assetId ?? (source?.attempt?.phase === "succeeded" ? source.attempt.job.run?.files[0]?.assetId : undefined);
        if (assetId) neighbors.push({ direction, assetId });
        if (neighbors.length === 2) break;
      }
      return neighbors;
    });
  }

  /** Managed original lookup works even after checkpoint restore or Canvas job compaction. */
  async managedCharacterViewJob(id: string, query: { boardId?: string; nodeId?: string; jobId?: string; recoveryId?: string }): Promise<ToolJob | undefined> {
    return withCanvasLock(this.#project(id).workspacePath, async () => {
      const state = await this.#characterViewBindings(id);
      if (!state) return undefined;
      const matchingNode = (record: CharacterViewBinding) =>
        (query.boardId === undefined || record.boardId === query.boardId) &&
        (query.nodeId === undefined || record.nodeId === query.nodeId);
      const candidate = state.records.find(record => matchingNode(record) &&
        (query.jobId === undefined || record.attempt?.job.id === query.jobId || record.attempt?.previousJobs.includes(query.jobId)) &&
        (query.recoveryId === undefined || record.attempt?.recoveryId === query.recoveryId));
      if (!candidate) {
        if (query.jobId && query.boardId !== undefined && query.nodeId !== undefined && state.records.some(matchingNode))
          throw recoveryUnavailable("This job does not belong to the managed direction. No replacement was submitted.");
        return undefined;
      }
      const job = await this.#observeCharacterView(id, candidate);
      return job ? this.#publicJob(job) : undefined;
    });
  }

  async #readCanvasImage(id: string, relative: string, assetId: string, nodeType: AssetCanvasNode["type"], managed = false): Promise<PromptImage> {
    const project = this.#project(id);
    const source = await getWorkspaceMedia(project.workspacePath, relative);
    if (nodeType === "model-3d" && source.contentType === "image/webp") {
      try { return await readWebpModelReference(project.workspacePath, source); }
      catch (cause) { throw new CanvasError(cause instanceof Error ? cause.message : String(cause)); }
    }
    if (nodeType === "model-3d" && source.contentType !== "image/png" && source.contentType !== "image/jpeg")
      throw new CanvasError("3D generation requires PNG, JPEG or WebP reference images");
    if (!(managed ? ["image/png", "image/jpeg", "image/webp"] : ["image/png", "image/jpeg", "image/webp", "image/gif"]).includes(source.contentType))
      throw new CanvasError(managed ? "Managed direction references must be static PNG, JPEG or WebP" : "Reference images must be PNG, JPEG, WebP or GIF");
    const bytes = managed
      ? await readSafeProjectFile(project.workspacePath, source.absolutePath, RASTER_BYTES)
      : await readFile(source.absolutePath);
    return { mediaType: source.contentType as PromptImage["mediaType"], data: bytes.toString("base64"),
      libraryAssetId: await canvasLibraryAsset(project, this.library, assetId) };
  }

  async #linkedPrompt(id: string, board: CanvasBoard, sourceId?: string): Promise<string | undefined> {
    if (!sourceId) return;
    const linked = board.nodes.find(node => node.id === sourceId);
    if (linked?.type === "document") return (await this.read(id, linked.data.documentId))?.document.markdown;
    if (linked?.type === "text") return linked.data.text;
  }

  async #imageNodeInput(node: Extract<AssetCanvasNode, { type: "image" }>, text: string | undefined,
    image: (reference: AssetCanvasReference) => Promise<PromptImage>): Promise<RunToolRequest> {
    const prompt = combineAssetCanvasPrompt(text, node.data.prompt);
    if (!prompt) throw invalidMediaInput("Add a prompt before generating");
    return {
      prompt, resolution: node.data.resolution, aspectRatio: node.data.aspectRatio,
      ...(node.data.model ? { imageModel: node.data.model } : {}),
      ...(node.data.quality !== undefined ? { quality: node.data.quality } : {}),
      ...(node.data.outputFormat !== undefined ? { outputFormat: node.data.outputFormat } : {}),
      ...(node.data.outputCompression !== undefined ? { outputCompression: node.data.outputCompression } : {}),
      ...(node.data.background !== undefined ? { background: node.data.background } : {}),
      ...gptImage26Options(node.data),
      ...(node.data.mask ? { mask: await image(node.data.mask) } : {}),
      ...(node.data.markup ? { markup: await image(node.data.markup) } : {}),
      images: await Promise.all(node.data.images.map(image)),
    };
  }
  async recordAgentMediaFailure(id: string, boardId: string, nodeId: string, toolId: ToolId, error: string): Promise<void> {
    await withCanvasLock(this.#project(id).workspacePath, async () => {
      const jobs = await this.#loadJobs(id);
      if (jobs.some(job => job.context?.boardId === boardId && job.context.nodeId === nodeId)) return;
      const { board } = await this.board(id, boardId);
      const node = board.nodes.find(node => node.id === nodeId);
      if (node) await this.#rememberJob(id, { id: randomUUID(), toolId, title: node.title ?? node.type, createdAt: new Date().toISOString(), status: "failed", error,
        context: { projectId: id, boardId, nodeId } }, jobs);
    });
  }
  async changeBoards(id: string, action: { type: "create"; name: string } | { type: "rename" | "delete" | "move"; boardId: string; name?: string; direction?: number }) {
    if (this.#project(id).type === "asset-canvas") throw new CanvasError("Asset Canvas uses one default board", 409);
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace);
      if (action.type === "create") {
        if (index.boards.length >= 100) throw new CanvasError("The workspace supports up to 100 boards");
        const board = createCanvasBoard(); await writeCanvasBoard(workspace, board); index.boards.push({ id: board.id, name: action.name.trim() || "Untitled" });
      } else {
        const position = index.boards.findIndex((board) => board.id === action.boardId);
        if (position < 0) throw new CanvasError("Canvas board not found", 404);
        if (action.type === "rename") index.boards[position]!.name = action.name?.trim() || "Untitled";
        if (action.type === "move") { const target = Math.max(0, Math.min(index.boards.length - 1, position + (action.direction === -1 ? -1 : 1))); [index.boards[position], index.boards[target]] = [index.boards[target]!, index.boards[position]!]; }
        if (action.type === "delete") { if (index.boards.length === 1) throw new CanvasError("Keep at least one board", 409); index.boards.splice(position, 1); }
      }
      await writeJson(workspace, "index.json", index);
      if (action.type === "delete") {
        await rm(await canvasPath(workspace, `boards/${validId(action.boardId)}.json`), { force: true });
        await rm(await canvasPath(workspace, `editor/${action.boardId}.json`), { force: true });
      }
      return index;
    });
  }
  async insertAsset(id: string, documentId: string, assetId: string): Promise<CanvasDocumentDetail> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const manifest = await ensureCanvasAssets(this.#project(id), this.projects, this.library, [assetId]);
      const asset = (await canvasAssetCatalog(workspace, manifest, [assetId]))[0]!;
      if (asset.mediaType !== "image") throw new CanvasError("Choose an image asset");
      const detail = await readCanvasDocument(workspace, documentId);
      if (!detail) throw new CanvasError("Document not found", 404);
      const label = asset.name.replace(/[\[\]\n]/g, "");
      const link = asset.path.split("/").map(encodeURIComponent).join("/");
      const saved = await writeCanvasDocument(workspace, { ...detail.document, markdown: `${detail.document.markdown.trimEnd()}\n\n![${label}](../../${link})\n` }, this.#project(id).type !== "asset-canvas");
      if (asset.libraryAssetId && this.library.get(asset.libraryAssetId)) await this.library.save(asset.libraryAssetId);
      return saved;
    });
  }
  async #loadJobs(id: string): Promise<StoredJob[]> {
    if (this.#jobs.has(id)) return this.#jobs.get(id)!;
    await ensureCanvasIndex(this.#project(id).workspacePath);
    let jobs: StoredJob[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(await canvasPath(this.#project(id).workspacePath, "jobs.json"), "utf8"));
      if (!Array.isArray(value) || value.length > 1000 || value.some((job) => !job || typeof job.id !== "string" || job.context?.projectId !== id || typeof job.context?.boardId !== "string" || typeof job.context?.nodeId !== "string" || !["running", "succeeded", "failed", "cancelled"].includes(job.status))) throw new CanvasError("Invalid generation history");
      jobs = await Promise.all(value.map(async (job) => {
        const { unreadInput: _, ...stored } = job;
        let input = job.input, unreadInput: StoredJob["unreadInput"];
        if (input?.retainedInput !== undefined) {
          try { input = await this.#readJobInput(id, job); }
          catch {
            // Keep its exact disk binding. A damaged sidecar affects only this job.
            unreadInput = input;
            input = undefined;
          }
        }
        return { ...stored, input, unreadInput,
          sources: Array.isArray(job.sources) && job.sources.length <= 64 && job.sources.every((source: unknown) => source && typeof source === "object" && "assetId" in source && typeof source.assetId === "string" && "name" in source && typeof source.name === "string") ? job.sources : undefined,
          videoSubmission: ["not-submitted", "attempted"].includes(job.videoSubmission) ? job.videoSubmission : undefined,
          videoReferencePreparation: validVideoReferencePreparation(job.videoReferencePreparation) ? job.videoReferencePreparation : undefined,
          ...(job.status === "running" ? { status: "cancelled", error: "Generation was interrupted. Recover a saved result; unknown submissions are never resubmitted.",
            ...(!job.run && ["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId) ? { submissionOutcome: "unknown" as const } : {}) } : {}),
        };
      }));
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    this.#jobs.set(id, jobs);
    try { await this.#saveJobs(id); }
    catch (cause) { this.#jobs.delete(id); throw cause; }
    return jobs;
  }
  async #readJobInput(id: string, job: Omit<StoredJob, "input"> & { input: { retainedInput: string } }): Promise<RunToolRequest> {
    const key = revision(job.id);
    if (job.input.retainedInput !== key) throw recoveryUnavailable("Invalid retained generation input binding");
    const file = await canvasPath(this.#project(id).workspacePath, `.job-inputs/${key}.json`);
    let saved;
    try { saved = JSON.parse(await readFile(file, "utf8")); }
    catch { throw recoveryUnavailable("Original generation input is unavailable; history retained and no replacement was submitted"); }
    if (saved?.version !== 1 || saved.jobId !== job.id || saved.boardId !== job.context?.boardId || saved.nodeId !== job.context?.nodeId || saved.toolId !== job.toolId || !saved.input || typeof saved.input !== "object" || Array.isArray(saved.input))
      throw recoveryUnavailable("The original generation input does not match this job; no replacement was submitted");
    return saved.input as RunToolRequest;
  }
  async #saveJobs(id: string) {
    const workspace = this.#project(id).workspacePath;
    const history = await Promise.all((this.#jobs.get(id) ?? []).map(async ({ unreadInput, ...job }) => {
      if (unreadInput) return { ...job, input: unreadInput };
      if (!job.input) return job;
      const key = revision(job.id), name = `.job-inputs/${key}.json`;
      const saved = { version: 1, jobId: job.id, boardId: job.context?.boardId, nodeId: job.context?.nodeId, toolId: job.toolId, input: job.input };
      const text = JSON.stringify(saved), digest = revision(text), cacheKey = `${id}:${key}`;
      if (this.#savedInputs.get(cacheKey) !== digest) {
        const file = await canvasPath(workspace, name, true);
        await chmod(path.dirname(file), 0o700);
        await writeAtomic(workspace, name, text);
        await chmod(file, 0o600);
        this.#savedInputs.set(cacheKey, digest);
      }
      return { ...job, input: { retainedInput: key } };
    }));
    // Save complete inputs first. A failed metadata write must not discard recovery data.
    return writeJson(workspace, "jobs.json", history);
  }
  async #rememberJob(id: string, job: StoredJob, history: StoredJob[]): Promise<void> {
    const seenNodes = new Set([JSON.stringify([job.context?.boardId, job.context?.nodeId])]);
    const pending = new Set(history.filter((entry) => {
      const node = JSON.stringify([entry.context?.boardId, entry.context?.nodeId]);
      const latest = !seenNodes.has(node);
      seenNodes.add(node);
      return entry.status === "running" || latest && (entry.status === "failed" || entry.status === "cancelled");
    }));
    if (history.filter((entry) => entry.status === "running").length >= 20) throw new CanvasError("Too many active generation jobs", 409);
    if (pending.size >= 1000) throw new CanvasError("Canvas job history is full. Resolve pending results before starting another generation.", 409);
    let recent = Math.min(80, 999 - pending.size);
    const kept = history.filter((entry) => pending.has(entry) || recent-- > 0);
    this.#jobs.set(id, [job, ...kept]);
    try { await this.#saveJobs(id); }
    catch (cause) { this.#jobs.set(id, history); throw cause; }
  }
  async #publicJob({ input, unreadInput, recoveryId, ...job }: StoredJob): Promise<ToolJob> {
    const id = recoveryId ?? job.id, outputs = (input as { outputs?: number } | undefined)?.outputs ?? 1;
    const terminal = job.status === "cancelled" || job.status === "failed";
    return {
      ...structuredClone(job),
      ...(unreadInput ? { error: [job.error, "The original generation input is unavailable. Restore it to recover this job."].filter(Boolean).join(" ") } : {}),
      ...(job.toolId === "generate-image" ? { canRecoverImage: await this.tools.hasSavedImageResult(id, outputs) } : {}),
      ...(job.toolId === "generate-video" ? { canRecoverVideo: await this.tools.hasSavedVideoTask(id) } : {}),
      ...(terminal && (job.toolId === "image-to-3d" || job.toolId === "animate-3d") ? { canRecoverModel3D: !!job.run || !!input && await this.#canRecover3D(job.toolId, input, id) } : {}),
      ...(terminal && !job.run && (unreadInput || await this.tools.mediaWasAttempted(job.toolId, id, outputs)) ? { submissionOutcome: "unknown" as const } : {}),
    };
  }
  async #canRecover3D(toolId: string, input: RunToolRequest, recoveryId: string): Promise<boolean> {
    try {
      await this.tools.assertMediaAvailable(toolId, input, true);
      return await this.tools.hasSavedModel3DTask(recoveryId);
    } catch { return false; }
  }
  async jobs(id: string): Promise<ToolJob[]> {
    return withCanvasLock(this.#project(id).workspacePath, async () => Promise.all((await this.#loadJobs(id)).map((job) => this.#publicJob(job))));
  }

  async boardJobs(id: string, boardId: string): Promise<CanvasBoardJobs> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      validId(boardId);
      const history = (await this.#loadJobs(id)).filter(job => job.context?.boardId === boardId);
      const reserved = (await this.#characterViewBindings(id))?.records.filter(record => record.boardId === boardId) ?? [];
      const characterViews: CanvasCharacterViewStatus[] = [];
      if (reserved.length) {
        const nodes = new Map((await this.board(id, boardId)).board.nodes.map(node => [node.id, node]));
        const root = await realpath(workspace);
        const markers = new Map<string, Promise<CharacterViewAuthoringMarker | undefined>>();
        for (const record of reserved) {
          const { nodeId, setId, designRevision, direction, viewRevision, attempt } = record;
          const node = nodes.get(nodeId);
          if (node?.type !== "image") continue;
          const view = { nodeId, setId, designRevision, direction, viewRevision };
          if (attempt && !["prepared", "not-submitted"].includes(attempt.phase)) {
            const running = attempt.phase === "admitted" && history.some(job => job.id === attempt.job.id && job.status === "running");
            let state: CanvasCharacterViewStatus["state"];
            if (running) state = "running";
            else if (attempt.phase === "succeeded") {
              const assetId = attempt.job.run?.files[0]?.assetId;
              const retained = assetId && await this.library.content(assetId).catch(() => undefined);
              state = retained ? "available" : "unavailable";
            } else {
              const recoverable = attempt.job.run || await this.tools.hasSavedImageResult(attempt.recoveryId);
              state = recoverable ? "recoverable" : "unknown";
            }
            characterViews.push({ ...view, state, jobId: attempt.job.id });
            continue;
          }
          if (!record.inputFingerprint) { characterViews.push({ ...view, state: "preparing" }); continue; }
          let marker = markers.get(setId);
          if (!marker) {
            marker = this.#readCharacterViewAuthoring(root, setId).catch(() => undefined);
            markers.set(setId, marker);
          }
          const current = await marker;
          const state = !current && !attempt ? "preparing"
            : !this.#matchesCharacterViewAuthoring(current, record) || !matchesCharacterViewFingerprint(managedImageNodeSettings(node), record.nodeFingerprint) ? "changed"
            : attempt?.phase === "not-submitted" ? "not-submitted" : "ready";
          characterViews.push({ ...view, state });
        }
      }
      return { jobs: await Promise.all(history.map(job => this.#publicJob(job))), characterViews };
    });
  }
  async start(id: string, boardId: string, nodeId: string, toolId: ToolId, input: RunToolRequest, verifyInputs?: (current: CanvasBoard) => Promise<void>, recoveryId?: string, imageRecoveryOnly = false, videoRecoveryOnly = false, model3DRecoveryOnly = false, confirmedAudioJobId?: string, retryJobId?: string, agentCanInspectImages?: boolean): Promise<ToolJob> {
    const workspace = this.#project(id).workspacePath;
    const { job, prepared, managed } = await withCanvasLock(workspace, async () => {
      if (this.#closed) throw new CanvasError("Generation is shutting down", 503);
      const state = await this.#characterViewBindings(id);
      const record = state?.records.find(record => record.boardId === boardId && record.nodeId === nodeId);
      if (record) {
        if (toolId !== "generate-image" || imageRecoveryOnly || videoRecoveryOnly || model3DRecoveryOnly ||
            retryJobId || confirmedAudioJobId)
          throw recoveryUnavailable("Use the original managed direction job for recovery or prepare a new view revision.");
        if (!record.inputFingerprint)
          throw new CanvasError("This managed character direction is still preparing. No generation was submitted.", 409);
        const observed = await this.#observeCharacterView(id, record);
        if (observed && record.attempt?.phase !== "not-submitted") return { job: observed };
        await this.#assertCharacterViewAuthoring(workspace, record);
      }
      const detail = await this.board(id, boardId);
      await verifyInputs?.(detail.board);
      const node = detail.board.nodes.find((node) => node.id === nodeId);
      const expectedNodeType = toolId === "generate-speech" && "voiceDesign" in input && input.voiceDesign ? "voice" : ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d", "generate-speech": "speech", "generate-sound-effect": "sound-effect", "generate-music": "music" } as Partial<Record<ToolId, string>>)[toolId];
      if (!node || !expectedNodeType || expectedNodeType !== node.type) throw new CanvasError("Generation node not found", 404);
      if (record && (node.type !== "image" || !matchesCharacterViewFingerprint(managedImageNodeSettings(node), record.nodeFingerprint)))
        throw new CanvasError("The managed direction settings changed. No generation was submitted.", 409);
      const jobs = await this.#loadJobs(id);
      // Agent submissions bring their original call identity; the Canvas Generate button does not.
      if (state && record && recoveryId) {
        const running = new Set(jobs.filter(job => job.status === "running").map(job => job.id));
        const other = state.records.find(view => view.setId === record.setId && view.designRevision === record.designRevision &&
          view.direction !== record.direction && view.attempt && running.has(view.attempt.job.id));
        if (other) throw toolPreflightError(
          `${record.direction} was not submitted. ${other.direction} is still generating for ${record.setId}. Inspect its saved image when it finishes, then request the next direction separately.`,
          "invalid_character_view_input",
        );
      }
      if (jobs.some((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId && job.status === "running")) throw new CanvasError("This node is already generating", 409);
      const previous = jobs.find((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId);
      if (retryJobId && previous?.id !== retryJobId) throw new CanvasError("This recovery was superseded. Refresh the node before continuing.", 409);
      if (previous?.status === "cancelled" && this.#controllers.has(previous)) throw new CanvasError("Wait for the cancelled generation to finish recording its result.", 409);
      if (!record && previous?.run && previous.toolId === toolId && previous.status !== "succeeded" && (!recoveryId || recoveryId === (previous.recoveryId ?? previous.id))) {
        if (!previous.input) throw new CanvasError("The saved output is in the Library. Restore it locally before generating again.", 409);
        const job = { ...previous, id: randomUUID(), createdAt: new Date().toISOString(), status: "running" as const, error: undefined, submissionOutcome: undefined };
        await this.#rememberJob(id, job, jobs);
        return { job, prepared: previous.input };
      }
      if (retryJobId && previous?.run) throw new CanvasError("This saved output cannot be restored. Recovery will not submit a new request.", 409);
      const canSubmit = !imageRecoveryOnly && !videoRecoveryOnly && !model3DRecoveryOnly;
      if (canSubmit) this.tools.assertJobHistoryAvailable();
      await this.tools.assertMediaAvailable(toolId, input, model3DRecoveryOnly);
      if (canSubmit && previous && mediaGenerationNeedsConfirmation(await this.#publicJob(previous)) && confirmedAudioJobId !== previous.id) {
        throw new CanvasError("The previous request may have been billed. Explicitly confirm a new request or recover the previous result.", 409);
      }
      if (confirmedAudioJobId && confirmedAudioJobId !== previous?.id) throw new CanvasError("This confirmation is out of date. Refresh the node before continuing.", 409);
      const resolved = await this.tools.prepare(toolId, input, id, canSubmit ? agentCanInspectImages : undefined);
      if (canSubmit) await this.tools.assertMediaInputOptions(toolId, resolved);
      if (record && !matchesCharacterViewFingerprint(resolved, record.inputFingerprint))
        throw new CanvasError("The managed direction input has changed since it was prepared. No generation was submitted.", 409);
      const prepared = structuredClone(resolved);
      const model = "imageModel" in resolved ? resolved.imageModel : "model" in resolved ? resolved.model : undefined;
      if (toolId === "generate-video" && "references" in prepared) for (const reference of prepared.references ?? []) reference.assetId = await canvasLibraryAsset(this.#project(id), this.library, reference.assetId);
      if (toolId === "generate-speech" && "referenceAssetId" in prepared && prepared.referenceAssetId) prepared.referenceAssetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.referenceAssetId);
      if (toolId === "animate-3d" && "assetId" in prepared) prepared.assetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.assetId);
      if (toolId === "image-to-3d" && "sourceAssetId" in prepared && prepared.sourceAssetId) prepared.sourceAssetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.sourceAssetId);
      const sourceIds = [
        ...("images" in prepared ? prepared.images?.map(image => image.libraryAssetId) ?? [] : []),
        ...("references" in prepared ? prepared.references?.map(reference => reference.assetId) ?? [] : []),
        "mask" in prepared ? prepared.mask?.libraryAssetId : undefined,
        "markup" in prepared ? prepared.markup?.libraryAssetId : undefined,
        "assetId" in prepared ? prepared.assetId : undefined,
        "sourceAssetId" in prepared ? prepared.sourceAssetId : undefined,
        "referenceAssetId" in prepared ? prepared.referenceAssetId : undefined,
      ].filter((assetId): assetId is string => typeof assetId === "string");
      const sources = [...new Set(sourceIds)].map(assetId => ({ assetId, name: this.library.get(assetId)?.name ?? assetId }));
      const prior = record?.attempt;
      const job: StoredJob = { sources, imageRecoveryOnly, videoRecoveryOnly, model3DRecoveryOnly, recoveryId: prior?.recoveryId ?? recoveryId ?? randomUUID(), id: prior?.phase === "prepared" ? prior.job.id : randomUUID(), toolId, ...(toolId === "generate-video" ? { videoSubmission: videoRecoveryOnly ? "attempted" as const : "not-submitted" as const } : {}), createdAt: new Date().toISOString(), status: "running", title: "prompt" in input ? (input.prompt ?? "Model 3D").slice(0, 200) : "text" in input ? (input.text.trim().slice(0, 200) || "Speech") : "Model 3D", context: { projectId: id, boardId, nodeId }, ...(model ? { model } : {}), input: structuredClone(resolved) };
      if (state && record) {
        const { input: _input, recoveryId: originalId, ...recordedJob } = job;
        if (prior?.phase === "not-submitted") recordCharacterViewJobAlias(prior);
        record.attempt = { recoveryId: originalId!, phase: "prepared", job: recordedJob, previousJobs: prior?.previousJobs ?? [] };
        await state.storage.save(state.records);
        await state.storage.retainInput(record, resolved);
      }
      await this.#rememberJob(id, job, record ? jobs.filter(entry => entry.id !== job.id) : jobs);
      if (state && record) {
        record.attempt!.phase = "admitted";
        try { await state.storage.save(state.records); }
        catch (error) {
          job.status = "cancelled";
          job.error = "The managed direction could not be admitted. No generation was submitted.";
          await this.#saveJobs(id);
          throw error;
        }
      }
      return { job, prepared, managed: !!record };
    });
    if (!prepared) return this.#publicJob(job);
    return this.#launchCanvasJob(id, job, prepared, managed);
  }

  #launchCanvasJob(id: string, job: StoredJob, prepared: RunToolRequest, managed = false): ToolJob {
    const controller = new AbortController(); this.#controllers.set(job, controller);
    const execution = this.#execute(id, job, prepared, controller, managed);
    let executions = this.#executions.get(id);
    if (!executions) { executions = new Set(); this.#executions.set(id, executions); }
    executions.add(execution);
    void execution.finally(() => {
      executions.delete(execution);
      if (!executions.size) this.#executions.delete(id);
    });
    const { input: _input, recoveryId: _recoveryId, ...publicJob } = job; return structuredClone(publicJob);
  }
  async generateNode(id: string, boardId: string, nodeId: string, confirmedAudioJobId?: string, defaultReferenceMode?: Model3DOptions["referenceMode"], agentCanInspectImages?: boolean,
    expectedToolId?: ToolId, originalRecoveryId?: string): Promise<ToolJob> {
    const submit = await this.prepareNode(id, boardId, nodeId, confirmedAudioJobId, defaultReferenceMode, agentCanInspectImages, undefined, expectedToolId, originalRecoveryId);
    return submit();
  }
  /** Capture the generation inputs without creating a job or submitting to a provider. */
  async prepareNode(id: string, boardId: string, nodeId: string, confirmedAudioJobId?: string, defaultReferenceMode?: Model3DOptions["referenceMode"], agentCanInspectImages?: boolean,
    reviewViews?: (images: readonly PromptImage[], paths: readonly string[]) => Promise<void>, expectedToolId?: ToolId,
    originalRecoveryId?: string): Promise<() => Promise<ToolJob>> {
    const project = this.#project(id);
    const managed = await withCanvasLock(project.workspacePath, async () => {
      const record = (await this.#characterViewBindings(id))?.records.find(record => record.boardId === boardId && record.nodeId === nodeId);
      if (!record) return undefined;
      if (confirmedAudioJobId) throw new CanvasError("Prepare a new managed direction revision before requesting a replacement", 409);
      if (!record.inputFingerprint)
        throw new CanvasError("This managed character direction is still preparing. No generation was submitted.", 409);
      const observed = await this.#observeCharacterView(id, record);
      return { record, job: observed && record.attempt?.phase !== "not-submitted" ? await this.#publicJob(observed) : undefined };
    });
    if (managed?.job) {
      const job = managed.job;
      return () => job.status === "failed" && (job.run || job.canRecoverImage) ? this.retry(id, job.id, true) : Promise.resolve(job);
    }
    const { board } = await this.board(id, boardId);
    const node = board.nodes.find(node => node.id === nodeId);
    if (!node || !["image", "video", "model-3d", "animate-3d", "speech", "voice", "sound-effect", "music"].includes(node.type)) throw invalidMediaInput("Choose a media generation node");
    const latest = managed ? undefined : await withCanvasLock(project.workspacePath, async () => (await this.#loadJobs(id)).find((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId));
    if (latest?.run && (latest.status === "failed" || latest.status === "cancelled")) return () => this.retry(id, latest.id);
    const manifest = await readCanvasAssets(project.workspacePath);
    const sourceAssets = new Map<AssetCanvasReference, string>();
    const assetId = (reference: AssetCanvasReference): string => {
      const id = resolveAssetCanvasAssetId(board.nodes, reference);
      if (!id || !manifest.assets[id]) throw invalidMediaInput("A referenced node has no saved output. Generate it first.");
      sourceAssets.set(reference, id);
      return id;
    };
    const image = (reference: AssetCanvasReference) => {
      const source = assetId(reference);
      return this.#readCanvasImage(id, manifest.assets[source]!.path, source, node.type, !!managed);
    };
    const usesPrompt = node.type !== "model-3d" || node.data.operation === "text" || node.data.operation === "retexture";
    const promptSource = usesPrompt && "promptSource" in node.data ? node.data.promptSource?.nodeId : undefined;
    const linkedText = await this.#linkedPrompt(id, board, promptSource);
    const start = (toolId: ToolId, input: RunToolRequest, reviewed = false) => {
      if (expectedToolId && toolId !== expectedToolId) throw invalidMediaInput("The generation node changed type. Read the current board before generating.", 409);
      return () => this.start(id, boardId, nodeId, toolId, input, async current => {
        const target = current.nodes.find(item => item.id === nodeId);
        const assets = sourceAssets.size ? await readCanvasAssets(project.workspacePath) : manifest;
        if (target?.type === node.type && isDeepStrictEqual(target.data, node.data) &&
          [...sourceAssets].every(([reference, source]) => resolveAssetCanvasAssetId(current.nodes, reference) === source && assets.assets[source]?.path === manifest.assets[source]?.path) &&
          (!promptSource || await this.#linkedPrompt(id, current, promptSource) === linkedText)) return;
        if (reviewed) throw toolPreflightError("Canvas settings or references changed during review. Show the current views and request approval again. No generation was submitted.", "invalid_model_reference");
        throw invalidMediaInput("The node settings or references changed before generation. Read the current node and try again.", 409);
      }, managed ? originalRecoveryId : undefined, false, false, false, confirmedAudioJobId, undefined, agentCanInspectImages);
    };
    if (node.type === "animate-3d") {
      if (!node.data.source || !node.data.actionIds.length) throw invalidMediaInput("Choose a source model and animation actions first");
      return start("animate-3d", { model: node.data.model, options: node.data.options, assetId: assetId(node.data.source), actionIds: node.data.actionIds, heightMeters: node.data.heightMeters });
    }
    if (node.type === "model-3d") {
      const operation = node.data.operation ?? "image";
      if (operation === "image" && !node.data.images.length) throw invalidMediaInput("Add a reference image before generating");
      let prompt: string | undefined;
      if (operation === "text" || operation === "retexture") prompt = combineAssetCanvasPrompt(linkedText, node.data.prompt ?? "");
      const images: PromptImage[] = [];
      for (const reference of node.data.images) images.push(await image(reference));
      const options = operation === "image" && defaultReferenceMode ? { referenceMode: defaultReferenceMode, ...node.data.options } : node.data.options;
      const request = { ...buildModel3DToolRequest(node.data, images, operation), operation, ...(prompt ? { prompt } : {}), ...(node.data.source ? { sourceAssetId: assetId(node.data.source) } : {}), ...(options ? { options } : {}) };
      if (reviewViews && operation === "image" && images.length >= 3) {
        await this.tools.assertMediaInputOptions("image-to-3d", await this.tools.prepare("image-to-3d", request, id, agentCanInspectImages));
        const sourceIds = node.data.images.map(assetId);
        const paths = sourceIds.map(sourceId => manifest.assets[sourceId]!.path);
        await reviewViews(images, paths);
        return start("image-to-3d", request, true);
      }
      return start("image-to-3d", request);
    }
    if (node.type === "voice") {
      if (!node.data.description.trim() || !node.data.sampleText.trim()) throw invalidMediaInput("Describe the voice and add sample text before generating", 400);
      return start("generate-speech", { voiceDesign: true, voiceDescription: node.data.description, text: node.data.sampleText, output: node.data.output ?? { format: "wav", sampleRate: 48000 }, language: node.data.language, style: node.data.style, speed: node.data.speed, ...(node.data.model ? { model: node.data.model } : {}) });
    }
    if (node.type === "speech") {
      const text = combineAssetCanvasPrompt(linkedText, node.data.text);
      if (!text) throw invalidMediaInput("Add text to synthesize before generating");
      if (node.data.voiceId && !node.data.referenceAssetId) throw invalidMediaInput("The legacy voice is unavailable; explicitly select reference audio or no reference", 400);
      return start("generate-speech", { text, language: node.data.language, style: node.data.style, output: node.data.output, ...(node.data.referenceAssetId ? { referenceAssetId: node.data.referenceAssetId } : {}), ...(node.data.referenceSha256 ? { referenceSha256: node.data.referenceSha256 } : {}), ...(node.data.model ? { model: node.data.model } : {}), ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}) });
    }
    if (node.type === "sound-effect" || node.type === "music") {
      const prompt = combineAssetCanvasPrompt(linkedText, node.data.prompt);
      if (!prompt) throw invalidMediaInput(`Add a prompt before generating ${node.type === "music" ? "music" : "a sound effect"}`);
      if (node.type === "sound-effect") return start("generate-sound-effect", {
        prompt,
        ...(node.data.output ? { output: node.data.output } : {}),
        ...(node.data.model ? { model: node.data.model } : {}),
        ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
        ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
        ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      });
      return start("generate-music", {
        prompt,
        ...(node.data.output ? { output: node.data.output } : {}),
        ...(node.data.model ? { model: node.data.model } : {}),
        instrumental: node.data.instrumental,
        ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
        ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
        ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      });
    }
    if (node.type !== "image" && node.type !== "video") throw invalidMediaInput("Unsupported generation node");
    if (node.type === "image") return start("generate-image", await this.#imageNodeInput(node, linkedText, image));
    const prompt = combineAssetCanvasPrompt(linkedText, node.data.prompt);
    if (!prompt) throw invalidMediaInput("Add a prompt before generating");
    const referenceIds = node.data.references.map(assetId);
    const catalog = await canvasAssetCatalog(project.workspacePath, manifest, referenceIds);
    const references = referenceIds.map((id) => {
      const asset = catalog.find((asset) => asset.id === id)!;
      if (asset.mediaType !== "image") throw invalidMediaInput("Video generation currently accepts image references only");
      return { type: "image" as const, assetId: id };
    });
    let resolvedPrompt: string;
    try { resolvedPrompt = resolveVideoMentions(prompt, node.data.references, node.data.referenceMentions); }
    catch (cause) { throw invalidMediaInput(cause instanceof Error ? cause.message : String(cause)); }
    return start("generate-video", { prompt: resolvedPrompt, model: node.data.model, resolution: node.data.resolution, aspectRatio: node.data.aspectRatio, duration: node.data.duration, references, ...(node.data.referenceMode ? { referenceMode: node.data.referenceMode } : {}) });
  }
  async #saveManagedJob(id: string, job: StoredJob, phase: NonNullable<CharacterViewBinding["attempt"]>["phase"], resultSha256?: string) {
    const state = await this.#characterViewBindings(id);
    const record = state?.records.find(record => record.boardId === job.context?.boardId && record.nodeId === job.context?.nodeId);
    if (!state || !record?.attempt || record.attempt.recoveryId !== job.recoveryId || record.attempt.job.id !== job.id)
      throw new CanvasError("Managed character view job no longer matches its original binding", 409);
    // Keep the confirmed result if the previous durable write committed before reporting an error.
    if (record.attempt.phase === "succeeded" && phase !== "succeeded") {
      Object.assign(job, record.attempt.job);
      delete job.input;
      delete job.error;
      delete job.submissionOutcome;
      return;
    }
    const { input: _input, recoveryId: _recoveryId, ...recordedJob } = job;
    record.attempt.job = recordedJob;
    record.attempt.phase = phase;
    record.attempt.resultSha256 = resultSha256;
    await state.storage.save(state.records);
  }

  async #execute(id: string, job: StoredJob, prepared: RunToolRequest, controller: AbortController, managed = false) {
    try {
      const retained = job.run;
      const run = retained ? await this.tools.recoverCanvasRun(retained.id, job.toolId, job.context!) : await this.tools.runPrepared(job.toolId, prepared, controller.signal, { recoveryId: job.recoveryId ?? job.id, projectId: id, canvasContext: job.context,
        ...(job.imageRecoveryOnly ? { imageRecoveryOnly: true } : {}), ...(job.videoRecoveryOnly ? { videoRecoveryOnly: true } : {}), ...(job.model3DRecoveryOnly ? { model3DRecoveryOnly: true } : {}) }, async (summary) => {
        if (!validVideoReferencePreparation(summary)) throw new CanvasError("Invalid video reference preparation summary", 400);
        await withCanvasLock(this.#project(id).workspacePath, async () => {
          controller.signal.throwIfAborted();
          job.videoReferencePreparation = structuredClone(summary);
          await this.#saveJobs(id);
        });
      }, async () => {
        await withCanvasLock(this.#project(id).workspacePath, async () => {
          controller.signal.throwIfAborted();
          job.videoSubmission = "attempted";
          await this.#saveJobs(id);
        });
      });
      job.run = run;
      if (!retained) {
        delete job.submissionOutcome;
        await withCanvasLock(this.#project(id).workspacePath, async () => {
          if (managed) await this.#saveManagedJob(id, job, "admitted");
          await this.#saveJobs(id);
        });
      }
      controller.signal.throwIfAborted();
      const output = run.files[0];
      if (!output?.assetId) throw new CanvasError("Generation returned no Library asset", 502);
      await withCanvasLock(this.#project(id).workspacePath, async () => {
        if (controller.signal.aborted) return;
        const workspace = this.#project(id).workspacePath, boardId = job.context!.boardId!;
        await ensureCanvasAssets(this.#project(id), this.projects, this.library, [output.assetId!]);
        const resultSha256 = managed ? await this.#managedResultDigest(job) : undefined;
        const bindings = managed ? await this.#characterViewBindings(id) : undefined;
        const binding = bindings?.records.find(record => record.boardId === boardId && record.nodeId === job.context!.nodeId);
        if ((await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) {
          const detail = await readCanvasBoard(workspace, boardId), node = detail?.board.nodes.find((node) => node.id === job.context!.nodeId);
          const expectedType = job.toolId === "generate-speech" && "voiceDesign" in prepared && prepared.voiceDesign ? "voice" : ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d", "generate-speech": "speech", "generate-sound-effect": "sound-effect", "generate-music": "music" } as Partial<Record<ToolId, string>>)[job.toolId];
          if (detail && node && expectedType && node.type === expectedType &&
              (!managed || node.type === "image" && matchesCharacterViewFingerprint(managedImageNodeSettings(node), binding?.nodeFingerprint) &&
                (!node.data.assetId || node.data.assetId === output.assetId))) {
            Object.assign(node.data, { assetId: output.assetId });
            await writeCanvasBoard(workspace, detail.board);
          }
        }
        job.status = "succeeded";
        delete job.input;
        await this.#saveJobs(id);
        if (managed) await this.#saveManagedJob(id, job, "succeeded", resultSha256);
      });
      if (job.status === "succeeded") await this.tools.removeRun(run.id).catch(() => {});
    } catch (cause) {
      job.status = controller.signal.aborted ? "cancelled" : "failed"; job.error = cause instanceof Error ? cause.message : String(cause);
      if (job.run) {
        job.input ??= prepared;
        job.error += ". A generation result was received. Retry to attach the existing output without another generation.";
      }
      if (job.toolId === "generate-video" && cause instanceof ToolRunError && cause.notSubmitted) job.videoSubmission = "not-submitted";
      if (cause instanceof ToolRunError && cause.videoDiagnostic) job.videoDiagnostic = cause.videoDiagnostic;
      if (cause instanceof ToolRunError && cause.audioDiagnostic) job.audioDiagnostic = cause.audioDiagnostic;
      if (cause instanceof ToolRunError && cause.submissionOutcome === "unknown" || controller.signal.aborted && !job.run && ["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId)) job.submissionOutcome = "unknown";
      try {
        await withCanvasLock(this.#project(id).workspacePath, async () => {
          if (managed) {
            const notSubmitted = !job.imageRecoveryOnly && !job.run && cause instanceof ToolRunError &&
              cause.notSubmitted === true && !await this.tools.mediaWasAttempted(job.toolId, job.recoveryId!);
            if (!notSubmitted && !job.run) job.submissionOutcome = "unknown";
            await this.#saveManagedJob(id, job, notSubmitted ? "not-submitted" : "uncertain");
          }
          await this.#saveJobs(id);
        });
      } catch { /* Removed projects have no history to update. */ }
    } finally { this.#controllers.delete(job); }
  }
  async cancel(id: string, jobId: string): Promise<ToolJob> {
    return withCanvasLock(this.#project(id).workspacePath, async () => {
      const job = (await this.#loadJobs(id)).find((job) => job.id === jobId);
      if (!job) throw new CanvasError("Generation job not found", 404);
      if (job.status === "running") { job.status = "cancelled"; job.error = job.toolId === "image-to-3d" || job.toolId === "animate-3d" ? "Stopped waiting locally. Retry to resume; the provider task may still be running." : "Generation cancelled"; if (!job.run && ["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId)) job.submissionOutcome = "unknown"; this.#controllers.get(job)?.abort(); await this.#saveJobs(id); }
      const { input: _input, unreadInput: _unreadInput, recoveryId: _recoveryId, ...result } = job; return structuredClone(result);
    });
  }
  async retry(id: string, jobId: string, recoveryOnly = false): Promise<ToolJob> {
    const managed = await withCanvasLock(this.#project(id).workspacePath, async () => {
      const state = await this.#characterViewBindings(id);
      const record = state?.records.find(record => record.attempt?.job.id === jobId || record.attempt?.previousJobs.includes(jobId));
      if (!state || !record?.attempt) return undefined;
      const previous = await this.#observeCharacterView(id, record);
      const attempt = record.attempt;
      if (!previous || attempt.phase === "not-submitted")
        throw recoveryUnavailable("The managed direction has no submitted result to recover. No replacement was submitted.");
      if (previous.status === "succeeded" || previous.status === "running") return { job: previous };
      const current = this.#jobs.get(id)?.find(job => job.id === attempt.job.id);
      if (current && this.#controllers.has(current))
        throw recoveryUnavailable("Wait for the original managed generation to finish recording its result.");
      if (!previous.run && !await this.tools.hasSavedImageResult(attempt.recoveryId))
        throw recoveryUnavailable("No saved managed image is available. The original may have been submitted; no replacement was sent.");
      const input = await state.storage.originalInput(record);
      const jobs = await this.#loadJobs(id);
      const job: StoredJob = { ...previous, id: randomUUID(), createdAt: new Date().toISOString(), status: "running",
        input, imageRecoveryOnly: true, error: undefined, submissionOutcome: undefined };
      recordCharacterViewJobAlias(attempt);
      const { input: _input, recoveryId: _recoveryId, ...recordedJob } = job;
      attempt.job = recordedJob;
      attempt.phase = "admitted";
      await state.storage.save(state.records);
      await this.#rememberJob(id, job, jobs);
      return { job, prepared: input };
    });
    if (managed) return managed.prepared
      ? this.#launchCanvasJob(id, managed.job, managed.prepared, true)
      : this.#publicJob(managed.job);
    const job = await withCanvasLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).find((job) => job.id === jobId));
    if (!job || !["failed", "cancelled"].includes(job.status)) throw recoveryUnavailable("This job cannot be retried");
    if (job.unreadInput) {
      job.input = await this.#readJobInput(id, { ...job, input: job.unreadInput });
      delete job.unreadInput;
    }
    if (!job.input) throw recoveryUnavailable("This job has no saved generation input");
    if (job.run) return this.start(id, job.context!.boardId!, job.context!.nodeId, job.toolId, job.input, undefined, job.recoveryId ?? job.id, false, false, false, undefined, job.id);
    if (["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId) && (recoveryOnly || job.submissionOutcome === "unknown" || /unknown|interrupted|cancelled/i.test(job.error ?? ""))) throw recoveryUnavailable("The previous audio request may have been billed. Its result is unknown; recovery cannot submit another paid request. Preserve this job and continue work that does not require a replacement.");
    if (job.toolId === "generate-image" && !await this.tools.hasSavedImageResult(job.recoveryId ?? job.id, (job.input as { outputs?: number }).outputs ?? 1)) throw recoveryUnavailable("No saved image result is available. Recovery never submits a new generation; check the provider record. The original submission may be unknown. Preserve this job and continue work that does not require a replacement.");
    if (job.toolId === "generate-video" && !await this.tools.hasSavedVideoTask(job.recoveryId ?? job.id)) throw recoveryUnavailable("No saved video task is available. Recovery never submits a new generation. Preserve this job and continue work that does not require a replacement.");
    const recoveryId = ["generate-speech", "generate-sound-effect", "generate-music"].includes(job.toolId) ? randomUUID() : job.recoveryId ?? job.id;
    return this.start(id, job.context!.boardId!, job.context!.nodeId, job.toolId, job.input, undefined, recoveryId, job.toolId === "generate-image", job.toolId === "generate-video", ["image-to-3d", "animate-3d"].includes(job.toolId), undefined, job.id);
  }
  async cancelProject(id: string) { for (const job of this.#jobs.get(id) ?? []) if (job.status === "running") await this.cancel(id, job.id); this.#jobs.delete(id); }
  async close() { this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(); await Promise.allSettled([...this.#executions.values()].flatMap((executions) => [...executions])); }
}
