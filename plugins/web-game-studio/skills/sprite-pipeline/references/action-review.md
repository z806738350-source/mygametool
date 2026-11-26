# Review a published sprite action

Use the runtime sheet and its actual source rectangles. The host reads `public/characters/<setId>/<actionId>.json`. A directional game can use any subset of N, NE, E, SE, S, SW, W, NW. An action with one facing only needs that facing. Keep existing playback metadata and timings. When adapting another layout, describe the actual runtime frames and verify them in game; do not author a duplicate sheet just for review.

A short single-facing example:

```json
{
  "image": "jump.png",
  "frameSize": { "width": 64, "height": 80 },
  "bodyPlan": "biped",
  "motion": "jump",
  "animations": {
    "E": {
      "reference": "idle-e.png",
      "loop": false,
      "frames": [
        { "x": 0, "y": 0, "durationMs": 80 },
        { "x": 64, "y": 0, "durationMs": 120 }
      ]
    }
  }
}
```

The example illustrates storage. Include the whole real sequence. `reference` is an aligned transparent standing PNG within this package; an existing managed standing manifest can supply it. Use `loop: true` for cycles so the last and first frames are compared. A local pixel repair writes only a dedicated `<actionId>.png` with distinct source rectangles. An atlas with shared cells can be inspected and corrected in its owning art workflow.

**Review.** Call `review_sprite_action` with `setId, actionId, direction`. Infer the body plan from the art and the motion from the task when authoring; existing clips without these labels can receive `bodyPlan` and `motion` in the call. The host measures `quadruped` + `trot` and `biped` + `jump`. Read the checks and actual event indices and inspect the labelled strip. A numerical check can only distinguish anatomy visible in this facing. Use an aligned landmark override for a misidentified but visible feature. If the engine moves the actor through the air or supplies ground movement, also inspect actual playback.

**Other anatomies and inconclusive measurements.** Locate the parts that matter in the returned standing image yourself. Supply `parts` using names appropriate to this artwork (for example, wingtip and tail bend). Each part has a `name`, a textured `region` in standing pixels and an optional stable `anchor` on the body. Rectangles use `x, y, width, height`. The tool compares each part with its anchor, returns observed extrema and reversals, and numbers the regions in `markedParts` order. When a patch rotates out of view or loses its texture, inspect the neighbouring poses. Request additional `frames` by zero-based index (up to 12 per sheet) as needed.

Record `visualReview` with `status` and `observations`. For each marked part, describe what is visible at its measured keyframes. Include suspicious frames and cover at least two distinct phases. Each observation names its `part`, `phase`, `frame` and the visible evidence in `observation`. Use the strip's one-based `partIndex` to identify a marked region by number. Report persistent uncertainty if the view hides the feature. Confirmed damage or a failed motion measurement needs repair.

**Repair.** Call `repair_sprite_action` with `setId, actionId, expectedRevision` and `directions`, for example `[{"direction":"E"}]`. The candidate strip reuses that direction's parts from the reviewed revision. Inspect it before repeating with the returned `candidateDigest`. Pixel repair uses evidence from the reference and nearby frames. Two reversed airborne jump frames can reuse the original poses in their measured order. For a clear lateral trot that has turned into a pace, the tool can transfer an existing hind stride if the clip loops, donor and destination durations agree, and the legs and hip seam can be isolated. If a defect persists, redraw its phase and the adjacent transition, then check again. Review the published revision and reopen it in the game before reporting a playable result.
