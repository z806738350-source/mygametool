import { defineTool, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { toolPreflightError } from "./agent-tool-errors.js";
import {
  direction,
  image,
  record,
  rect,
  sawSpriteCandidate,
  setId,
} from "./sprite-walk-agent.js";
import type { WalkProject } from "./sprite-walk-review.js";
import {
  inspectPublishedSpriteAction,
  type repairPublishedSpriteAction,
} from "./sprite-action-package.js";

const actionId = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,47}$" });
const name = Type.String({ minLength: 1, maxLength: 64 });
const frame = Type.Integer({ minimum: 0, maximum: 127 });
const parts = Type.Array(
  Type.Object(
    {
      name,
      region: rect,
      anchor: Type.Optional(rect),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 6 },
);
type Parts = Static<typeof parts>;

function sameMarkedRegions(a: Parts | undefined, b: Parts) {
  if (!a || a.length !== b.length) return false;
  const equal = (
    x: Static<typeof rect> | undefined,
    y: Static<typeof rect> | undefined,
  ) =>
    !x || !y
      ? x === y
      : x.x === y.x &&
        x.y === y.y &&
        x.width === y.width &&
        x.height === y.height;
  return a.every(
    (v, i) => equal(v.region, b[i]!.region) && equal(v.anchor, b[i]!.anchor),
  );
}
const landmarks = Type.Optional(
  Type.Partial(
    Type.Object(
      {
        body: rect,
        frontNear: rect,
        frontFar: rect,
        hindNear: rect,
        hindFar: rect,
        leftFoot: rect,
        rightFoot: rect,
      },
      { additionalProperties: false },
    ),
  ),
);
const profile = { bodyPlan: Type.Optional(name), motion: Type.Optional(name) };
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const assessment = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("inconclusive"),
    ]),
    observations: Type.Array(
      Type.Object(
        {
          part: name,
          partIndex: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 6,
              description:
                "1-based number of a custom region in the marked standing image, including when using a different part name.",
            }),
          ),
          phase: name,
          frame,
          observation: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

function actionReviewHistory(
  history: readonly SessionEntry[],
  target: {
    setId: string;
    actionId: string;
    direction: string;
  },
) {
  const receipts: Record<string, unknown>[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") break;
    if (
      m.role !== "toolResult" ||
      m.isError ||
      m.toolName !== "review_sprite_action"
    )
      continue;
    const seen = record(record(m.details)?.spriteActionReview);
    if (
      !seen ||
      seen.setId !== target.setId ||
      seen.actionId !== target.actionId ||
      seen.direction !== target.direction
    )
      continue;
    receipts.push(seen);
  }
  return receipts;
}

function lastMarkedParts(
  receipts: readonly Record<string, unknown>[],
  revision?: string,
) {
  for (const row of receipts)
    if (
      typeof row.revision === "string" &&
      (!revision || row.revision === revision) &&
      Check(parts, row.partSelection)
    )
      return { parts: row.partSelection, partsRevision: row.revision };
}

function viewedActionFrames(
  receipts: readonly Record<string, unknown>[],
  revision: string,
  selected?: Parts,
) {
  const frames = new Set<number>();
  let failedMeasurement = false,
    visualDefect = false;
  for (const seen of receipts) {
    if (seen.revision !== revision) continue;
    if (seen.measuredStatus === "fail") failedMeasurement = true;
    if (seen.source === "visual" && seen.status === "fail") visualDefect = true;
    if (
      selected &&
      (!Check(parts, seen.partSelection) ||
        !sameMarkedRegions(seen.partSelection, selected))
    )
      continue;
    if (Array.isArray(seen.previewFrames))
      for (const f of seen.previewFrames)
        if (Number.isSafeInteger(f)) frames.add(f);
  }
  return { frames, failedMeasurement, visualDefect };
}
function visualEvidenceError(message: string): never {
  throw toolPreflightError(message, "invalid_sprite_action_input");
}

export function createSpriteActionReviewTool(
  project: WalkProject,
  supportsImages: boolean,
  gate: () => void,
  history: () => SessionEntry[],
  inspect = inspectPublishedSpriteAction,
) {
  return defineTool({
    name: "review_sprite_action",
    label: "Review character action",
    description:
      "Inspect the published action PNG for this body, action and direction. Start with setId, actionId, direction. Inspect actual marked frames and the motion plan. Choose up to six parts yourself for unfamiliar anatomy, e.g. wingtip relative to a wing root: name, region and optional anchor in standing-image pixels. Read the measured keyframes, request additional frames, and reuse the markings for the same revision. Omit parts for calibrated motions unless additional anatomy needs checking. For motion that pixels cannot automatically verify, submit visualReview with part/phase/frame/observation from the returned images. Cover each marked part and its measured keyframes, plus at least two distinct phases. Use the image’s 1-based partIndex for aliases. A measured defect requires repair.",
    parameters: Type.Object(
      {
        setId,
        actionId,
        direction,
        ...profile,
        landmarks,
        parts: Type.Optional(parts),
        frames: Type.Optional(
          Type.Array(frame, { minItems: 1, maxItems: 12, uniqueItems: true }),
        ),
        visualReview: Type.Optional(assessment),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, { visualReview, ...input }, signal) => {
      gate();
      const receipts = actionReviewHistory(history(), input);
      let inherited = input.parts ? undefined : lastMarkedParts(receipts);
      const inspectMarks = () =>
        inspect(
          project,
          inherited ? { ...input, ...inherited } : input,
          signal,
          supportsImages,
        );
      let report = await inspectMarks();
      // Restoring an earlier published atlas can also restore a previously inspected selection.
      if (inherited && inherited.partsRevision !== report.revision) {
        inherited = lastMarkedParts(receipts, report.revision);
        if (inherited) report = await inspectMarks();
      }
      const { preview, ...result } = report;
      const target = {
        setId: input.setId,
        actionId: input.actionId,
        direction: input.direction,
        revision: result.revision,
      };
      const visual = supportsImages && !!preview;
      let status = result.status,
        source: "measurement" | "visual" = "measurement";
      if (!visual && status === "pass") status = "inconclusive";
      const selection = result.parts.length
        ? (input.parts ?? inherited?.parts)
        : undefined;
      if (selection && status === "pass") status = "inconclusive";
      const seen = viewedActionFrames(receipts, result.revision, selection);
      if (seen.visualDefect && status !== "fail") {
        status = "fail";
        source = "visual";
      }
      if (visualReview) {
        const observations = visualReview.observations;
        if (
          !visual ||
          observations.some(
            (o) =>
              !seen.frames.has(o.frame) ||
              (o.partIndex !== undefined &&
                (!selection || o.partIndex > selection.length)) ||
              !o.part.trim() ||
              !o.phase.trim() ||
              !o.observation.trim(),
          )
        )
          visualEvidenceError(
            "Inspect these exact frames on the current published revision first. Describe a visible part and its pose at each cited phase.",
          );
        if (visualReview.status === "pass" && status !== "pass") {
          if (!result.hasVisibleMotion)
            visualEvidenceError(
              "The saved action contains no distinct visible poses. Verify any runtime-driven movement separately before reporting it.",
            );
          if (status === "fail" || seen.failedMeasurement)
            visualEvidenceError(
              "Correct the measured defect and review the saved PNG. Visual observations cannot dismiss a measured failure.",
            );
          const cited = new Set(observations.map((o) => o.frame));
          for (const [i, part] of result.parts.entries()) {
            const matching = observations.filter((o) =>
              o.partIndex !== undefined
                ? o.partIndex === i + 1
                : result.parts.length === 1 ||
                  o.part.trim().toLowerCase() ===
                    part.name.trim().toLowerCase(),
            );
            if (
              !matching.length ||
              part.keyframes.some(
                (k) => !matching.some((o) => o.frame === k.frame),
              )
            )
              visualEvidenceError(
                `Describe marked part ${i + 1} at each of its observed keyframes. Use partIndex ${i + 1} with any descriptive part name.`,
              );
          }
          if (
            cited.size < 2 ||
            new Set(observations.map((o) => o.phase.trim())).size < 2 ||
            result.motion.keyframes.some((k) => !cited.has(k.frame)) ||
            result.damage.some((f) => !cited.has(f.frame))
          )
            visualEvidenceError(
              "Inspect and describe each flagged frame and identified keyframe, covering at least two distinct action phases before confirming this motion.",
            );
        }
        if (visualReview.status !== "pass" || status === "inconclusive") {
          source = "visual";
          if (status !== "fail") status = visualReview.status;
        }
      }
      const review = {
        ...target,
        status,
        measuredStatus: result.status,
        source,
        previewFrames: visual ? result.previewFrames : [],
        ...(visual && selection && { partSelection: selection }),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              ...review,
              ...(visualReview && { visualReview }),
              ...(!visual && {
                limitation:
                  "No action image reached the connection. Visual acceptance is unavailable.",
              }),
            }),
          },
          ...(visual ? [image(preview!)] : []),
        ],
        details: { spriteActionReview: review },
      };
    },
  });
}

const repairSchema = Type.Object(
  {
    setId,
    actionId,
    ...profile,
    expectedRevision: revision,
    candidateDigest: Type.Optional(revision),
    directions: Type.Array(
      Type.Object(
        { direction, landmarks, parts: Type.Optional(parts) },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export function createSpriteActionRepairTool(
  supportsImages: boolean,
  history: () => SessionEntry[],
  run: (
    input: Static<typeof repairSchema>,
    signal?: AbortSignal,
  ) => ReturnType<typeof repairPublishedSpriteAction>,
) {
  const tool = defineTool({
    name: "repair_sprite_action",
    label: "Repair character action",
    description:
      "Prepare supported local repairs to a published action's damaged PNG frames. Directional repairs reuse the last standing-image parts marked for this action revision. Override directions[].parts to select different regions. First omit candidateDigest and inspect all returned strips. Publish the exact reviewed pixels by repeating with the returned digest. Redraw the identified poses through the existing art workflow if reconstruction is not supported. Then review each requested direction on the saved PNG.",
    parameters: repairSchema,
    executionMode: "sequential",
    execute: async (_id, input, signal) => {
      const target = { setId: input.setId, actionId: input.actionId };
      if (!supportsImages)
        return {
          content: [
            {
              type: "text" as const,
              text: "No visual connection is available to inspect the candidate. No changes were made.",
            },
          ],
          details: { spriteActionAttempt: target },
        };
      const entries = history();
      if (
        input.candidateDigest &&
        !sawSpriteCandidate(
          entries,
          "repair_sprite_action",
          "spriteActionPreview",
          input,
        )
      )
        visualEvidenceError(
          "Inspect this exact candidate and its strips in the current task before applying its digest.",
        );
      const directions = input.directions.map((selection) => {
        if (selection.parts) return selection;
        const seen = actionReviewHistory(entries, {
          ...target,
          direction: selection.direction,
        });
        const prior = lastMarkedParts(seen, input.expectedRevision);
        return prior ? { ...selection, parts: prior.parts } : selection;
      });
      const { previews, ...result } = await run(
        { ...input, directions },
        signal,
      );
      const images = (previews ?? []).flatMap((p) => [
        { type: "text" as const, text: p.direction },
        image(p.data),
      ]);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
          ...images,
        ],
        details: {
          spriteActionAttempt: target,
          ...(images.length && result.candidateDigest && !input.candidateDigest
            ? {
                spriteActionPreview: {
                  ...target,
                  revision: input.expectedRevision,
                  candidateDigest: result.candidateDigest,
                },
              }
            : {}),
          ...(result.changed.length
            ? {
                spriteActionRepair: {
                  ...target,
                  revision: result.revision,
                  changed: result.changed,
                },
              }
            : {}),
        },
      };
    },
  });
  return Object.assign(tool, { canReuseResult: () => false });
}
