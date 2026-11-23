import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Model3DMetadata } from "../shared/contracts.js";

const shortText = Type.String({ minLength: 1, maxLength: 320, pattern: "\\S" });
export const blenderBrief = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 1024, pattern: "\\S" }),
    route: Type.Union([
      Type.Literal("tripo"),
      Type.Literal("existing"),
      Type.Literal("procedural"),
    ]),
    visualCriteria: Type.Array(shortText, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    requiredClips: Type.Optional(
      Type.Array(shortText, { maxItems: 32, uniqueItems: true }),
    ),
    requireRig: Type.Optional(
      Type.Boolean({
        description:
          "Require a skinned mesh. Rigid object animation does not need this.",
      }),
    ),
    requireTextures: Type.Optional(
      Type.Boolean({
        description:
          "Require texture maps. Solid material colors do not need this.",
      }),
    ),
    maxTriangles: Type.Optional(Type.Integer({ minimum: 1 })),
    topologyPolicy: Type.Optional(
      Type.Union(
        [
          Type.Literal("inspect"),
          Type.Literal("allow-open"),
          Type.Literal("watertight"),
        ],
        {
          description:
            "Require watertight topology for closed shells; allow intended openings on surfaces such as leaves or cloth.",
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Asset goal, source route and observable acceptance criteria. Declare on the first production run; subsequent stages inherit from its scene.blend.",
  },
);

export const blenderStaticReviewViews = [
  "static-review-front.png", "static-review-side.png", "static-review-back.png", "static-review-three-quarter.png",
] as const;

const staticReviewCriteria = ["silhouette", "normals", "sharpEdges", "textures"] as const;
const staticReviewDecision = Type.Object({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("regressed")]),
  notes: shortText,
}, { additionalProperties: false });
const staticReviewDecisions = Type.Object({
  silhouette: staticReviewDecision,
  normals: staticReviewDecision,
  sharpEdges: staticReviewDecision,
  textures: staticReviewDecision,
}, { additionalProperties: false });
const staticSurface = Type.Object({
  triangles: Type.Integer({ minimum: 1 }),
  customNormalMeshes: Type.Integer({ minimum: 0 }),
  sharpEdges: Type.Integer({ minimum: 0 }),
  normalMaps: Type.Integer({ minimum: 0 }),
  normalMappedTriangles: Type.Integer({ minimum: 0 }),
});
const staticReviewReport = Type.Object({
  views: Type.Array(Type.String(), { minItems: blenderStaticReviewViews.length, maxItems: blenderStaticReviewViews.length, uniqueItems: true }),
  sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  candidateArtifact: Type.Union([Type.Literal("scene.blend"), Type.Literal("model.glb")]),
  source: staticSurface,
  candidate: staticSurface,
  repairIssues: Type.Array(shortText, { maxItems: 16 }),
});

export const blenderVisualReview = Type.Object(
  {
    views: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), {
      minItems: 1,
      maxItems: 24,
      uniqueItems: true,
    }),
    observations: Type.String({
      minLength: 1,
      maxLength: 2000,
      pattern: "\\S",
    }),
    staticReview: Type.Optional(staticReviewDecisions),
  },
  {
    additionalProperties: false,
    description:
      "For final presentation only. Name the retained render files opened from this run and describe the visible result against the brief.",
  },
);

export function blenderDeliveryIssue(input: {
  stage: string;
  brief?: Static<typeof blenderBrief>;
  models: { model: Model3DMetadata }[];
  outputs: ReadonlyMap<string, Buffer>;
  technicalChecksPassed?: boolean;
  roundtripPassed: boolean;
  boundaryEdges?: number;
  previousLegacyFinal: boolean;
}): string | undefined {
  if (input.technicalChecksPassed === false)
    return "The retained report contains failed technical checks. Correct the failed stage and inspect the new export.";
  if (input.models.length !== 1)
    return "A final presentation needs exactly one inspectable GLB candidate. Export the intended model and inspect it before presenting it.";
  if (input.previousLegacyFinal) return;
  if (!input.brief)
    return "This run has no production brief. Start from its editable scene with the original requirements and run the bundled export.";
  if (
    input.stage !== "export" ||
    input.technicalChecksPassed !== true ||
    !input.roundtripPassed
  )
    return "Run the bundled export from the editable scene and inspect its passing technical report and GLB roundtrip.";
  if (!input.outputs.has("scene.blend"))
    return "The final export needs its editable scene.blend. Save the scene and export again.";
  const model = input.models[0].model;
  const missing = input.brief.requiredClips?.filter(
    (name) => !model.animations.includes(name),
  );
  if (missing?.length)
    return `The exported GLB is missing required clips: ${missing.join(", ")}. Repair or export the requested actions.`;
  if (input.brief.requireRig && !model.rigged)
    return "The brief requires a rigged mesh. Verify the skin and its weights in the exported GLB.";
  if (input.brief.requireTextures && !model.textured)
    return "The brief requires texture maps. Restore the material and textures in the exported GLB.";
  if (
    input.brief.maxTriangles !== undefined &&
    model.triangles > input.brief.maxTriangles
  )
    return `The exported GLB has ${model.triangles} triangles, above the brief's limit of ${input.brief.maxTriangles}.`;
  if (input.brief.topologyPolicy === "watertight" && input.boundaryEdges !== 0)
    return "The brief requires a watertight mesh. Verify zero boundary edges on the export scene, repair the open shell, and export again.";
}

export function blenderVisualIssue(
  review: Static<typeof blenderVisualReview> | undefined,
  outputs: ReadonlyMap<string, Buffer>,
): string | undefined {
  if (
    !review ||
    !review.views.every(
      (name) => /\.(?:png|jpe?g)$/i.test(name) && outputs.has(name),
    )
  )
    return "Open this export's rendered views, inspect them against the brief and provide visualReview with their exact run-relative filenames and your observations.";
}

export function blenderStaticReviewIssue(
  review: Static<typeof blenderVisualReview> | undefined,
  outputs: ReadonlyMap<string, Buffer>,
  sourceSha256: string | undefined,
  { requireDecision = true }: { requireDecision?: boolean } = {},
): string | undefined {
  const report = boundBlenderStaticReview(outputs, sourceSha256);
  if (!report || (requireDecision && report.candidateArtifact !== "model.glb")) {
    return "Regenerate the static review report and all four paired renders using the retained Tripo original. Use static-review on the editable scene for an intermediate check or the bundled export for final acceptance.";
  }
  if (report.source.customNormalMeshes > 0 && report.source.sharpEdges > 0 &&
      report.candidate.customNormalMeshes === 0 && report.candidate.sharpEdges === 0 && report.candidate.normalMappedTriangles === 0) {
    return "Static review found that the candidate lost all authored normals and marked sharp edges. Restore the surface shading on the editable scene, then rerun static-review or export and inspect the new pairs before requesting final acceptance.";
  }
  if (report.repairIssues.length) {
    return `Static review calls for repair. ${report.repairIssues.join(" ")} Correct the retained scene and inspect fresh pairs before requesting final acceptance.`;
  }
  if (!requireDecision) return;
  const decisions = review?.staticReview;
  if (!Check(staticReviewDecisions, decisions) || !blenderStaticReviewViews.every(name => review?.views.includes(name))) {
    return "Open all four paired static review renders from this export. List them in visualReview.views and report a verdict with an observation for silhouette, normals, sharp edges and textures in visualReview.staticReview.";
  }
  const regressions = staticReviewCriteria.filter(criterion => decisions[criterion].verdict === "regressed");
  if (regressions.length) {
    return `Static review found visible regression in ${regressions.join(", ")}. Repair the editable scene and review fresh pairs before requesting final acceptance. Restore local mesh density where it improves fidelity. Honor an explicit maximum, adjust an estimated target when justified, and report the measured triangle increase and reason at delivery.`;
  }
}

export function boundBlenderStaticReview(
  outputs: ReadonlyMap<string, Buffer>,
  sourceSha256: string | undefined,
): Static<typeof staticReviewReport> | undefined {
  const bytes = outputs.get("static-review.json");
  if (!sourceSha256 || !bytes) return;
  let report: unknown;
  try { report = JSON.parse(bytes.toString("utf8")); }
  catch { return; }
  if (Check(staticReviewReport, report) && report.sourceSha256 === sourceSha256 &&
      blenderStaticReviewViews.every(name => report.views.includes(name) && outputs.has(name)))
    return report;
}
