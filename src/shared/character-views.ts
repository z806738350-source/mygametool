import { Type, type Static } from "typebox";
import { IMAGE_MAX_REFERENCE_IMAGES } from "./contracts.js";

export const CHARACTER_VIEW_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type CharacterViewDirection = (typeof CHARACTER_VIEW_DIRECTIONS)[number];

export interface CharacterViewPoint {
  x: number;
  y: number;
}

export interface CharacterViewCanvas {
  width: number;
  height: number;
}

export interface CharacterViewRuntimeAsset extends CharacterViewCanvas {
  file: string;
  sha256: string;
  viewRevision: string;
}

export interface CharacterViewRuntimeManifest {
  schemaVersion: 1;
  setId: string;
  setRevision: string;
  designRevision: string;
  complete: boolean;
  coordinates: "top-left-pixel-edges-x-right-y-down";
  directionOrder: readonly CharacterViewDirection[];
  canvas: CharacterViewCanvas;
  pivot: CharacterViewPoint;
  headToGround: number;
  views: Partial<Record<CharacterViewDirection, CharacterViewRuntimeAsset>>;
}

export interface CharacterViewScaleInput {
  direction: CharacterViewDirection;
  sourceHeadY: number;
  sourceGroundPoint: CharacterViewPoint;
  scale: number;
}

const identifier = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const cas = Type.Union([digest, Type.Null()], { description: "Exact current file SHA-256, or null only when the file must not exist." });
const direction = Type.Union([
  Type.Literal("N"), Type.Literal("NE"), Type.Literal("E"), Type.Literal("SE"),
  Type.Literal("S"), Type.Literal("SW"), Type.Literal("W"), Type.Literal("NW"),
]);
const note = Type.String({ minLength: 1, maxLength: 1000 });
const point = Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, { additionalProperties: false });
const versionedView = { direction, viewRevision: identifier };

export const characterViewSourceSchema = Type.Object({
  kind: Type.Union([Type.Literal("attachment"), Type.Literal("workspace"), Type.Literal("canvas")]),
  reference: Type.String({ minLength: 1, maxLength: 1024, description: "Exact authorized attachment receipt, workspace-relative image path, or this project's registered Canvas asset ID, according to kind." }),
  expectedSha256: Type.Optional(digest),
}, { additionalProperties: false });

const planCandidate = Type.Object({
  ...versionedView,
  source: characterViewSourceSchema,
  provenance: Type.Optional(Type.Object({
    boardId: Type.String({ minLength: 1, maxLength: 100 }),
    nodeId: Type.String({ minLength: 1, maxLength: 100 }),
    jobId: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const planGeneration = Type.Object({
  ...versionedView,
  prompt: Type.String({ minLength: 1, maxLength: 16_000 }),
  references: Type.Array(characterViewSourceSchema, { minItems: 1, maxItems: IMAGE_MAX_REFERENCE_IMAGES }),
  model: Type.Object({
    provider: Type.String({ minLength: 1, maxLength: 100 }), id: Type.String({ minLength: 1, maxLength: 200 }),
  }, { additionalProperties: false }),
  resolution: Type.Union([Type.Literal("512"), Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")]),
  aspectRatio: Type.Union([
    Type.Literal("1:1"), Type.Literal("2:3"), Type.Literal("3:2"), Type.Literal("3:4"), Type.Literal("4:3"),
    Type.Literal("4:5"), Type.Literal("5:4"), Type.Literal("9:16"), Type.Literal("16:9"), Type.Literal("21:9"),
  ]),
  quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")])),
  complexity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  pixelSize: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*x[1-9][0-9]*$", maxLength: 32 })),
}, { additionalProperties: false });

export const characterViewDesign = Type.Object({
  original: characterViewSourceSchema,
  baseline: characterViewSourceSchema,
  identity: note,
  camera: note,
  stance: note,
  asymmetry: note,
  displayHeadToGround: Type.Number({ exclusiveMinimum: 0 }),
});
const planInput = Type.Object({
  designRevision: identifier,
  delivery: Type.Optional(Type.Union([Type.Literal("complete-set"), Type.Literal("complete-set-and-playtest")], {
    description: "Declare on the first plan only for a user request to finish all eight in this turn. Omit for samples, requested checkpoints, and single-direction revisions.",
  })),
  boardId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  ...Type.Partial(characterViewDesign).properties,
  views: Type.Array(Type.Union([planCandidate, planGeneration]), { minItems: 1, maxItems: 8 }),
}, {
  additionalProperties: false,
  description: "For a new set supply original, baseline, identity, camera, stance, asymmetry and displayHeadToGround. Later batches of the same design reuse them. To promote a reviewed front in this set, choose a new designRevision and pass the same source as baseline and as the S view. The saved brief carries forward and only the supplied views enter the new design. Other new designs require the full brief.",
});

const publishCandidate = Type.Object({
  ...versionedView,
  source: Type.Object({
    kind: Type.Union([Type.Literal("workspace"), Type.Literal("canvas")]),
    reference: Type.String({ minLength: 1, maxLength: 1024 }), expectedSha256: digest,
  }, { additionalProperties: false }),
  sourceHeadY: Type.Number({ minimum: 0, description: "Measured y coordinate of the crown on the source image. Record the observed anatomical head point, not an unrelated object." }),
  sourceGroundPoint: point,
  scale: Type.Number({ exclusiveMinimum: 0 }),
  sampling: Type.Union([Type.Literal("nearest"), Type.Literal("lanczos3")]),
  visualReview: note,
}, { additionalProperties: false });

const publishInput = Type.Object({
  designRevision: identifier,
  purpose: Type.Union([Type.Literal("sample"), Type.Literal("release"), Type.Literal("revision")]),
  expectedActiveSha256: cas,
  canvas: Type.Object({ width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  pivot: point,
  headToGround: Type.Number({ exclusiveMinimum: 0, description: "Shared projected crown-to-ground height in output pixels; preserve it on a single-direction revision." }),
  views: Type.Array(publishCandidate, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });

// A plain object tool schema works on both Pi and the coding-agent ToolBridge.
export const characterViewToolParameters = Type.Object({
  action: Type.Union([Type.Literal("plan"), Type.Literal("publish")]),
  setId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,47}$" }),
  expectedAuthoringSha256: cas,
  plan: Type.Optional(planInput),
  publish: Type.Optional(publishInput),
}, { additionalProperties: false });

export type CharacterViewSource = Static<typeof characterViewSourceSchema>;
export type CharacterViewToolInput = Static<typeof characterViewToolParameters>;
export type CharacterViewPlanInput = Static<typeof planInput>;
export type CharacterViewPublishInput = Static<typeof publishInput>;

// Use screen pixels so the same visual tolerance applies to larger exported textures.
const MAX_DISPLAY_HEAD_OFFSET = 2;

/** Check a measured crown and fixed ground point, independent of boot silhouette extent. */
export function checkCharacterViewScale(
  view: CharacterViewScaleInput,
  target: { headToGround: number; displayHeadToGround: number },
) {
  const sourceDistance = view.sourceGroundPoint.y - view.sourceHeadY;
  if (![view.sourceHeadY, view.sourceGroundPoint.x, view.sourceGroundPoint.y, view.scale, target.headToGround, target.displayHeadToGround, sourceDistance].every(Number.isFinite)
      || view.sourceHeadY < 0 || view.sourceGroundPoint.x < 0 || sourceDistance <= 0 || view.scale <= 0
      || target.headToGround <= 0 || target.displayHeadToGround <= 0) {
    throw new Error(`${view.direction}: use a measured head point above the ground point and positive scales.`);
  }
  const expectedScale = target.headToGround / sourceDistance;
  const renderedHeadToGround = sourceDistance * view.scale;
  const displayOffset = (renderedHeadToGround - target.headToGround) / target.headToGround * target.displayHeadToGround;
  if (!Number.isFinite(expectedScale) || !Number.isFinite(displayOffset)) {
    throw new Error(`${view.direction}: head-to-ground scale is out of range.`);
  }
  return { expectedScale, renderedHeadToGround, displayOffset, matches: Math.abs(displayOffset) <= MAX_DISPLAY_HEAD_OFFSET };
}

export function assertCharacterViewScale(
  view: CharacterViewScaleInput,
  target: { headToGround: number; displayHeadToGround: number },
) {
  const observation = checkCharacterViewScale(view, target);
  if (!observation.matches) {
    throw new Error(`${view.direction}: measured head-to-ground height differs by ${observation.displayOffset.toFixed(1)} display pixels. Recheck the visual landmarks or use uniform scale ${observation.expectedScale.toFixed(6)}.`);
  }
  return observation;
}
