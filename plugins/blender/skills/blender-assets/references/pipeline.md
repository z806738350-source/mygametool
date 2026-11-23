# Blender stages and delivery

Use this reference to configure source intake, measured parts, mesh cleanup
and final export. Keep the source identity, stage files, observations and user
decisions in the project's asset document.

## Review the initial Tripo model

Once the generated model is saved, let the user inspect and rotate it on the
initial-model review card. Continue to the first Blender stage only after their
approval of that exact original. If the result was already saved or the review
was interrupted, reopen it with `review_tripo_model` and its `sourceAssetId`.
For an unavailable FBX preview, use `get_model_asset` with `rebuildPreview`
and reopen the review. The original remains saved.

When the user requests changes, wait for their feedback and adjust the proposal
or source views. If a revision requires a new paid Tripo submission, obtain the
user's authorization. Present the revised initial model for its own approval.
Use the approved original for Blender and keep the later matched static and
final reviews.

## Production brief and source

Supply `brief` on the first production `run_blender` call. Set `goal` to the
intended use and `visualCriteria` to features that can actually be checked.
Select `route: "tripo"` with the already generated project's `sourceAssetId`,
`"existing"` with the selected project-bound asset or a supported project
source file, or `"procedural"` for fresh construction with `parts` or `custom`.
For a Tripo original use the bundled `inspect`, `clean` or `export` as its
first stage. The retained scene is then available for custom refinement.
Save the returned run ID. The next stage inherits the brief through the
unchanged `scene.blend` returned by the previous run in the same workflow.
The returned `sourceOriginal` identifies a bound original by asset ID, file
format and SHA-256 digest throughout those stages. Record these with the
candidate so a later revision can be traced back to the same original.
Keep diagnostics separate from production candidates.

For example, a static prop's brief might be:

```json
{
  "goal": "Prepare the selected ceramic lantern for an overhead game camera.",
  "route": "tripo",
  "visualCriteria": [
    "The arched handle stays clear of the neck in the front and oblique views.",
    "The painted blue band wraps around the body with a continuous seam."
  ],
  "requireTextures": true
}
```

Set `requireTextures` for an actual texture-map requirement, and `maxTriangles`
for an agreed triangle budget. Set `brief.topologyPolicy: "watertight"` when
the final mesh must be closed. Set `topologyPolicy: "watertight"` in the stage
configuration to measure boundaries as you work. The brief's requirement also
applies at final presentation. A flat-color asset can use material factors.
Set `requireRig` for a requested skin, and `requiredClips` to the exact
case-sensitive action names called for in the brief. A door rotating around
an object pivot can require an action without requiring a skinned mesh.
The host checks brief requirements against the actual GLB. Optionally list extra
case-sensitive `requiredClips` in the export configuration to verify those as
well (for example `{"requiredClips":["Open","Close"]}`).

## Invocation and outputs

Use the registered `blender_status`, `run_blender` and `recover_blender_run`
tools. Bundled stages take `configPath`. Select the initial source as described
above and use the retained `sourcePath` for later stages. Declare extra project
files in `inputs`. Custom stages use `scriptPath` and may also take a configuration.
The host stages them into a private task directory and starts its bundled
`scripts/pipeline.py`. Do not copy an executable or install a plugin.
The runner allows 64 MiB per file and 128 MiB each for total inputs and total
outputs. For an oversized source, retain the original and report the measured
size and limit. A paid regeneration does not repair a local staging failure.

The underlying script accepts:

```text
--stage inspect|parts|clean|joints|rig|animate|export
--config config.json
[--input source.glb|source.fbx|source.blend]
--input-dir INPUT_DIRECTORY
--output-dir EMPTY_OUTPUT_DIRECTORY
```

Bundled `animate` is for upright bipeds. To author legless or multi-legged locomotion, use `run_blender` with `stage: "custom"`.

Paths after `--config`/`--input` are relative to the input directory. Inputs are
never saved over. The output directory must be empty. Every successful stage
saves `scene.blend` and `report.json`. Modeling stages add a roundtrip-checked
`review.glb` and auxiliary PNGs; `export` instead adds `model.glb`. Preview GLBs
come from the saved scene, excluding temporary joint markers and render helpers.
Animation previews include the clips for actual playback. Keep using the returned
source path, not a guessed filename.

Recover an interrupted stage with `recover_blender_run` and its original `runId`.
The host retains authoring runs under `assets/blender/<workflow>/runs/<runId>/`,
outside the isolated Linux command workspace. Use `read` or `read_project_file`
for `report.json`, `rig.json`, recipes and renders. For computed checks, declare
the evidence files in a diagnostic `run_blender` call's `inputs`.

Read `report.technicalChecksPassed` and the individual checks. A completed
process may report failed checks. `humanReview: "pending"` means the script has
recorded no human approval. The default `reviewPresentation: "internal"` keeps
intermediate Blender runs off the board. Set `previews:false` only when repeating
a previously inspected technical check.

## Shared settings

The bundled views use Blender world coordinates, with +Z up and a front camera
on −Y. Inspect the actual facing and dimensions after import. Configuration
distances are in meters. glTF export performs its own axis conversion.

| Setting                           | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `triangleBudget`                  | Positive triangle count; reports failure when exceeded.               |
| `previews`                        | Default `true`. Asset views cover front, side, back and three-quarter angles. Joint, region, stress and walk views use front and side. |
| `previewSize`                     | Square PNG size, default 384, allowed 64–1024.                        |
| `topologyPolicy`                  | `inspect` (default) reports boundary edges. Use `watertight` when zero boundaries are required or `allow-open` for intentionally open edges. |
| `allowedNonManifoldInteriorEdges` | Default 0. Only raise for a specifically reviewed topology exception. |
| `allowedDegenerateFaces`          | Default 0. Prefer repairing these faces.                              |

Boundary edges include open garment borders and split glTF UV/normal seams.
Compare source and output before deciding whether a hole needs repair. Interior
nonmanifold edges and degenerate faces fail the default check. Do not raise a
threshold merely to make a check green.

## Inspect the original

Use `inspect` with an empty configuration to inventory imported geometry and
capture the asset from four angles. The report records part parents and world
pivots, armatures and bone counts, actions and material texture use. It preserves
the incoming scene and produces an editable `scene.blend`, a `review.glb` and
review evidence. Inspect pivots or object hierarchies in the scene where relevant.
Continue from that saved scene to repair selected features, including when the
asset is already rigged. A completed intake can record a failed roundtrip or
topology check. Use the recorded defect and saved scene to guide the repair.
A source that already meets the brief can go to export.

## Parts: dimensions before geometry

Write `parts.json`, check its dimensions against the brief and reference, then run `parts`. Each
primitive has a unique name, positive XYZ size, XYZ position, optional XYZ Euler
rotation in degrees, and RGB/RGBA color in 0–1. Types are `box`, `cylinder`
(local Z axis), and `sphere`. Optional bevel is a width in meters, no greater
than half the smallest dimension. More complex outlines, cutouts, connections,
UVs or construction details belong in a custom script rather than a growing
primitive schema.

```json
{
  "triangleBudget": 1000,
  "parts": [
    {
      "name": "crate",
      "type": "box",
      "size": [1, 0.7, 0.6],
      "position": [0, 0, 0.3],
      "bevel": 0.02,
      "color": [0.26, 0.13, 0.05]
    },
    {
      "name": "lid",
      "type": "box",
      "size": [1.04, 0.74, 0.08],
      "position": [0, 0, 0.64],
      "bevel": 0.01,
      "color": [0.38, 0.22, 0.09]
    }
  ]
}
```

The report measures the assembled bounds, triangle counts, materials and
topology. It does not infer whether the pieces are mechanically attached.
Inspect the renders and compare them with the dimensions and reference.

## Clean a static copy

`clean` accepts a static GLB, FBX or unrigged `.blend`. It refuses
existing armatures or animation because normalization could invalidate them.
Shape keys and unapplied modifiers also need explicit handling on a separate
copy. By default it keeps coordinates, hierarchy, pivots, shared mesh data and
authored normals. It records incoming geometry in `report.sourceGeometry` and
companion source and candidate images in `report.sourcePreviews` and
`report.previews`. Compare `source-front.png` with `review-front.png` and do
the same for `side`, `back` and `three-quarter`.
Linked Blender libraries and external textures outside declared inputs are
rejected. A `.blend` output packs its images.

```json
{
  "height": 1.7,
  "yawDegrees": -90,
  "mergeDistance": 0.00001,
  "triangleBudget": 40000,
  "decimate": false,
  "previewSize": 768
}
```

Supplying `height` or `yawDegrees` enables normalization. The stage optionally
rotates around Blender Z, optionally scales uniformly to the target height, then
centers horizontal bounds and puts the lowest mesh point at Z=0. It transforms
each asset root while preserving its hierarchy. Inspect semantic front in the
references and decide whether the lowest point is the intended contact point.
Omit both settings to keep coordinates and origins in place. Welding uses an
explicit world-space `mergeDistance` in meters (default 0). Use
`recalculateNormals:true` when surface normals need repair. Topology-changing
operations can make an instance's mesh single-user. Verify UVs, material
assignments and documented seams on the revised asset.

`decimate:true` explicitly enables proportional collapse reduction toward the
triangle budget. It can distort UVs and silhouette; inspect the result and never
treat retaining texture images as proof of visual parity. Texture baking and
retopology need a dedicated custom script. With `decimate:false`, exceeding the
budget fails the check and leaves a recoverable copy.

Compare the original and candidate with matched framing at game-camera scale.
Check silhouette, negative space, material boundaries, seam continuity, texel
density and shading in neutral light. Inspect wireframe where topology or
deformation matters. Check pivots, seams between modules or moving-part
clearance where the brief calls for them. Repeat the affected views or
measurements after each repair.

### Static comparison for Tripo assets

After retopology or reduction, run bundled `static-review` on the retained
editable scene using the same Tripo workflow. Keep this comparison internal.
The stage compares the editable scene with the bound original before the asset
needs to export or have clips. The final bundled `export` repeats the
comparison against the reimported GLB.

Both models are grounded and aligned to the same body height for comparison in
rest pose, under the same orthographic camera and lighting. Set
`staticReview.sourceYawDegrees` or `staticReview.candidateYawDegrees` in the
configuration for either `static-review` or `export` if an asset's semantic front
differs from Blender's −Y convention.
Map the visible front correctly before judging quality. Use
`staticReview.excludeCandidateMeshes` to list the exact names of independently
made props, such as the separately counted weapon. Keep all original body,
outfit and worn parts in the comparison.

Open all four `static-review-*.png` paired views and read `static-review.json`.
Use the neutral material row to check shape, smooth shading and defined hard
edges, and the textured row to check color, UV seams and surface detail. Use
the report to investigate lost authored normals, sharp edge markings and
changed texture maps. Check feature outlines and negative spaces where the
model's overall silhouette can hide local damage. If a change is visibly worse,
go back to the affected modeling or material step, retain the original, repair
the candidate locally and compare the new run. A passing triangle budget does
not settle visual quality.

Restore geometry locally where the comparison shows a loss, and recover budget
from flatter or hidden areas when the game view and animation permit it. Treat
an estimated triangle target as adjustable by the smallest useful amount.
Honor an explicit maximum. If targeted repair still cannot meet both that cap
and the visual brief, retain the best candidates and show the trade-off with
their measured counts so the user can decide whether to raise the maximum.
If a repair adds triangles, give the before and after counts, the affected
areas and the reason in the delivery message. Count independently modeled
props separately.

## Checkpoints and early decisions

Each Canvas checkpoint presents the saved outputs of a completed background run.
Use `recover_blender_run` with the retained `runId`, the current `boardId` when
known, and `reviewPresentation: "checkpoint"` to show progress or evidence
for a choice only the user can make. Reuse the returned nodes. Seek a decision
before a visible departure from the reference or unapproved spending, or when a
persistent defect calls for a design change. For example, show the walking pose
where the boot passes through the coat and ask whether to keep its length or
shorten it. Continue independent work while the decision is pending.

## Export and actual game delivery

Before choosing the scene for the game, compare the working copy against the source
at the closest intended gameplay view using the [optimization guide](optimization.md).
Run bundled `export` with the final `.blend` from the same workflow. Use its run
ID for final presentation, including after custom modeling or animation. The
stage saves an editable source and
reuses `export_glb.py` for atomic GLB export, then imports it into an empty scene.
The default four `review-*.png` views depict that reimported candidate.
Leave previews enabled on a run intended for final presentation.
It compares triangle count, dimensions and world-space bounds on all three axes, deform bone names, authored actions and the
required clip names. It also checks that used material names and their connected
image textures survive reimport. Inspect the rendered result for UV alignment,
correct color, roughness and normals; structural preservation cannot establish
that the maps look right.
Clips are shifted to begin at zero seconds so a frame-1 start does not introduce
an extra engine pre-roll interval or change the declared locomotion speed.
It samples imported animation for vertex movement, including deformation, rigid
object motion and shape-key animation. A named but static clip fails the baseline check. Blender bone-display helper
meshes are excluded from geometry metrics.

For visual evidence from arbitrary clips, add up to four unique, exact action
names to the export configuration, for example
`{"motionReviewClips":["Open","Close"]}`. Keep previews enabled. Every
requested clip must exist. Check `checks.roundtrip.missingMotionReviewClips`
and the pass result. In `checks.roundtrip.playback`, the selected clip's
`motionReview` lists three chronological `{frame, file}` entries from the
reimported animation. Open the returned three-quarter PNGs, which use numeric
filenames such as `motion-01-01-three-quarter.png`. `report.previews` still
lists the four asset views. Use the sampled poses to inspect clearance,
silhouette or deformation. Check timing, transitions and in-between motion
during playback. For a multi-legged gait, inspect each foot through stance,
swing and the loop seam as described in [rigging and animation](rig-animation.md#locomotion-on-four-six-or-eight-legs).
For an authored [weapon action](rig-animation.md#weapon-actions), inspect the
intended contact or release interval on this GLB. Use a custom check for those
frames when the generic samples miss them. Include the relevant frames and
observed orientation in the final review.
The export's vertex-displacement check can pass when only one limb moves.

`roundtrip.runtimeReview` remains pending until the candidate is tested in the
game. Resolve `get_model_asset` and its `runtimePath` for game integration.
Check orientation, scale, pivots, materials, clip transitions and locomotion
speed in the target engine using `game_use` when available. For an asset-only
project, identify which checks still require a game scene. Keep the editable
`.blend` and reports.

This workflow's primary runtime output is GLB. Additional FBX export is possible
through custom Blender code, but the project's static FBX preview converter
does not validate rigged FBX. Do not replace the GLB roundtrip/game check with
an FBX file-exists check.

Read the technical report and open the images from this export run. If the
model cannot see their pixels, leave the visual criteria unverified and
present a checkpoint for human review. Final presentation needs one GLB, its
editable scene, passing checks and the requested deliverables. Use
`recover_blender_run` with this `runId`, the current `boardId` when known,
`reviewPresentation: "final"` and a `visualReview` containing the filenames seen
and one observation string. The lantern example might produce the following
observations.

```json
{
  "views": ["review-front.png", "review-three-quarter.png", "review-back.png"],
  "observations": "The handle clears the neck in the front and oblique views. The blue band meets under the hinge in the back view."
}
```

Use the actual filenames and findings from this run. In the user's language,
invite them to rotate the Canvas model and play any requested clips. Ask for final user acceptance on the exact candidate presented.

For a Tripo-derived export, include the four paired images in `visualReview.views`
along with the relevant final stills and motion frames. Add
`visualReview.staticReview` with `silhouette`, `normals`, `sharpEdges` and
`textures`. Each entry has a `verdict` of `"pass"` or `"regressed"` and
`notes` on the features you compared. Open the paired images with `read` or
`read_project_file`, inspect the returned pixels, and request final presentation
in a later response. A regressed verdict or an unresolved measured loss in the
report keeps the result in internal review. Repair the affected step and open
the new comparison before requesting final presentation.

## References

- [Original workflow shared by 0xKense1](https://x.com/0xKense1/status/2118717647357395170)
- [Blender command-line options](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- [Blender glTF animation/export behavior](https://docs.blender.org/manual/en/5.2/addons/scene_gltf2.html)

The source workflow separates agent planning, Blender processing, optional Tripo
initial geometry and human review. Numeric checks complement visual acceptance;
they never replace it.
