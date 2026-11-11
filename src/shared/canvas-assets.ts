import { Type } from "typebox";
import type { AssetCanvasNode, LibraryAsset } from "./contracts.js";

export interface CanvasAsset {
  canvasOnly?: true;
  modelRuntimePath?: string;
  modelPreviewPath?: string;
  model3d?: LibraryAsset["model3d"];
  name: string;
  path: string;
  description?: string;
  prompt?: string;
  libraryAssetId?: string;
}
export interface CanvasAssetManifest { version: 1; assets: Record<string, CanvasAsset> }
export interface CanvasAssetCatalogEntry extends CanvasAsset, Omit<LibraryAsset, "name" | "prompt"> {}
export interface UnavailableCanvasAsset extends CanvasAsset {
  id: string;
  status: "missing" | "unavailable";
  message: string;
}

export const CANVAS_ASSETS_FILE = "canvas/assets.json";
const provenanceId = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" });
const generationSchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "^(?!.*://)[A-Za-z0-9~][A-Za-z0-9~_.:/@-]*$" })),
  protocol: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  parameters: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Union([
    Type.String({ maxLength: 256, pattern: "^(?!.*(?:://|data:|bearer|[?&](?:key|token|access|signature|authorization)=))[^\\s\\\\]*$" }),
    Type.Number({ minimum: -1_000_000_000, maximum: 1_000_000_000 }), Type.Boolean(),
  ]), { maxProperties: 64 }),
  taskId: Type.Optional(provenanceId), taskIds: Type.Optional(Type.Array(provenanceId, { maxItems: 16 })),
}, { additionalProperties: false });
export const CANVAS_ASSETS_SCHEMA = Type.Object({
  version: Type.Literal(1),
  assets: Type.Record(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,120}$" }), Type.Object({
    canvasOnly: Type.Optional(Type.Literal(true)),
    model3d: Type.Optional(Type.Object({
      originalSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      triangles: Type.Integer({ minimum: 0 }), textured: Type.Boolean(), rigged: Type.Boolean(), animations: Type.Array(Type.String()),
      animationClips: Type.Optional(Type.Array(Type.Object({ name: Type.String(), durationSeconds: Type.Number({ minimum: 0 }), channels: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }))),
      forwardAxis: Type.Optional(Type.Union([Type.Literal("+X"), Type.Literal("+Z")])), provider: Type.Optional(Type.String()),
      operation: Type.Optional(Type.Union([Type.Literal("image"), Type.Literal("text"), Type.Literal("retexture"), Type.Literal("remesh"), Type.Literal("animate")])),
      generation: Type.Optional(generationSchema),
      preview: Type.Optional(Type.Object({ status: Type.Union([Type.Literal("ready"), Type.Literal("unavailable")]), materialApproximation: Type.Literal(true), sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }, { additionalProperties: false })),
    }, { additionalProperties: false })),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.String({ minLength: 1, maxLength: 1000, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+" }),
    modelPreviewPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: "^(?:assets/(?:imported|canvas)/[^/\\\\]+|\\.data/model-assets/[a-f0-9]{64}/[a-f0-9]{64})\\.glb$" })),
    modelRuntimePath: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: "^(?:assets/models/[a-zA-Z0-9_-]+/model\\.gltf|assets/files/models/[a-f0-9]{64}\\.glb)$" })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    prompt: Type.Optional(Type.String()),
    libraryAssetId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  }, { additionalProperties: false }), { maxProperties: 10_000 }),
}, { additionalProperties: false });

export function canvasNodeAssetIds(nodes: readonly AssetCanvasNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    if ("assetId" in node.data && node.data.assetId) ids.add(node.data.assetId);
    if (node.type === "speech" && node.data.referenceAssetId) ids.add(node.data.referenceAssetId);
    if (node.type === "voice" && node.data.selectedAssetId) ids.add(node.data.selectedAssetId);
    const references = node.type === "image" ? [...node.data.images, ...(node.data.mask ? [node.data.mask] : [])] : node.type === "model-3d" ? node.data.images
      : node.type === "video" ? node.data.references : node.type === "animate-3d" && node.data.source ? [node.data.source] : [];
    if (node.type === "model-3d" && node.data.source?.type === "library") ids.add(node.data.source.assetId);
    for (const reference of references) if (reference.type === "library") ids.add(reference.assetId);
  }
  return [...ids];
}

export function canvasNodeTitle(node: AssetCanvasNode, documents: readonly { id: string; title: string }[] = [], assets: readonly { id: string; name: string }[] = [], tables: readonly { id: string; title: string }[] = []): string {
  if (node.title?.trim()) return node.title.trim();
  if (node.type === "voice") return node.data.description.trim().split("\n")[0]?.slice(0, 80) || "Voice";
  if (node.type === "document") return documents.find((doc) => doc.id === node.data.documentId)?.title || "Untitled document";
  if (node.type === "table") return tables.find((table) => table.id === node.data.tableId)?.title || "Table";
  if (node.type === "asset") return assets.find((asset) => asset.id === node.data.assetId)?.name || "Asset";
  if (node.type === "file") return node.data.path.split("/").at(-1) || "File";
  if (node.type === "text") return node.data.text.trim().split("\n")[0]?.slice(0, 80) || "Text";
  if (node.type === "speech") return node.data.text.trim().split("\n")[0]?.slice(0, 80) || "Speech";
  if (node.type === "sound-effect") return node.data.prompt.trim().split("\n")[0]?.slice(0, 80) || "Sound effect";
  if (node.type === "music") return node.data.prompt.trim().split("\n")[0]?.slice(0, 80) || "Music";
  return { image: "Image", video: "Video", "model-3d": "3D model", "animate-3d": "Animation" }[node.type];
}
