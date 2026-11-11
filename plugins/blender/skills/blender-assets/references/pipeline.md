# Repeatable Blender stages

The bundled pipeline is a starting implementation for measured primitive props
and explicitly described humanoid rigs. The main Agent authors and revises the
JSON and, where needed, custom Blender Python. It does not infer anatomy, cut
fused garments, retopologize a character, invent good animation, or approve its
own artwork. Keep the original reference images, Tripo GLB, stage sources and
human decisions. Existing models do not require another Tripo request.

## Invocation and outputs

Use the registered `blender_status`, `run_blender` and `recover_blender_run`
tools. A stage takes `configPath`, a prior `sourcePath` except for `parts`, and
explicit additional `inputs` if required. These paths are project-relative.
The host stages them into a private task directory and starts its bundled
`scripts/pipeline.py`. Do not copy an executable or install a plugin.

The underlying script accepts:

```text
--stage parts|clean|joints|rig|animate|export
--config config.json
[--input source.glb|source.blend]
--input-dir INPUT_DIRECTORY
--output-dir EMPTY_OUTPUT_DIRECTORY
```

Paths after `--config`/`--input` are relative to the input directory. Inputs are
never saved over. The output directory must be empty. Every successful stage
saves `scene.blend` and `report.json`. Review stages also produce PNGs. `export`
adds `model.glb`. Keep using the returned source path, not a guessed filename.
An interrupted stage is not permission to discard its earlier outputs.

`report.technicalChecksPassed` describes only the checks actually recorded.
`humanReview` remains `pending`; it is never an approval token. A process can
finish successfully with failed technical checks. Read them before continuing.
Missing information or unsupported data produces an error report. Set
`previews:false` only for a repeat of an already inspected technical check;
production reviews need actual images and the user's decisions.

The shipped baseline has been exercised with Blender 5.3. Its ordinary Python
uses Blender's `bpy`, `bmesh` and `mathutils`, with no external Python packages.
Preview rendering uses CPU Cycles. Custom scripts must follow the tool's same
input/output boundary, disable automatic blend-file execution, pack textures,
and explicitly save their `.blend` with `bpy.ops.wm.save_as_mainfile(filepath=..., compress=False)`
(the publisher validates an ordinary `BLENDER` file header, not a compressed wrapper).
Custom scripts can `import pipeline` and `import export_glb` to reuse these helpers;
the host preserves the exact executed sources in `recipe/` alongside each result.
The runner is responsible for process and
file isolation; Python argument validation is not a sandbox.

## Shared settings

Coordinates inside `.blend` and the configuration are **meters, +Z up, -Y
forward, +X toward the character's left**. glTF export performs its own axis
conversion. Do not add another export rotation.

| Setting                           | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `triangleBudget`                  | Positive triangle count; reports failure when exceeded.               |
| `previews`                        | Default `true`; saves stage-specific front/side PNGs.                 |
| `previewSize`                     | Square PNG size, default 384, allowed 64–1024.                        |
| `allowedNonManifoldInteriorEdges` | Default 0. Only raise for a specifically reviewed topology exception. |
| `allowedDegenerateFaces`          | Default 0. Prefer repairing these faces.                              |

Boundary edges are reported separately: open garment borders and glTF UV/normal
seams can be intentional. A count alone cannot tell a hole from a seam. Interior
nonmanifold edges and degenerate faces fail the default check. Do not raise a
threshold merely to make a check green.

## Parts: dimensions before geometry

Write `parts.json`, show the dimensions to the user, then run `parts`. Each
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
Inspect the renders and compare them with the approved dimensions/reference.

## Clean: preserve the original, normalize a copy

`clean` accepts a static self-contained GLB or unrigged `.blend`. It refuses
existing armatures or animation because normalization could invalidate them.
Shape keys and unapplied modifiers also need explicit handling on a separate
copy. Shared mesh instances become single-user before their transforms are baked.
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

`yawDegrees` rotates around Blender Z before normalization. Inspect semantic
front; do not infer it from a bounding box. The default 0 leaves facing as-is.
`height` scales uniformly, centers horizontal bounds, and puts the lowest mesh
point at Z=0. The feet may still need a different floor if a cape extends below
them. `mergeDistance` merges nearby vertices within each object, default
0.00001 m; set 0 to disable it. UVs and material assignments are retained.
The routine recalculates normals and reports topology; it does not fill holes,
separate fused clothing, or repair all connectivity defects.

`decimate:true` explicitly enables proportional collapse reduction toward the
triangle budget. It can distort UVs and silhouette; inspect the result and never
treat retaining texture images as proof of visual parity. Texture baking and
retopology need a dedicated custom script. With `decimate:false`, exceeding the
budget fails the check and leaves a recoverable copy.

## Joints and regions: explicit anatomical input

Run `joints` on the normalized `scene.blend`. `joints` is a dictionary of named
XYZ positions. Each bone names its head/tail joints and optional parent; parents
must form a valid acyclic hierarchy. Optional `rollDegrees` controls its local
axes. Optional `deform:false` is for control bones. Coordinate estimates must
be corrected against the actual front/side render, not copied blindly.

This minimal skeleton illustrates naming and structure; it is **not** a fitted
human template. Add the actual clavicles, arms, hands, fingers, neck and garment
bones required by the model before rigging it.

```json
{
  "joints": {
    "hips": [0, 0, 0.9],
    "spine": [0, 0, 1.1],
    "chest": [0, 0, 1.4],
    "neck": [0, 0, 1.5],
    "head": [0, 0, 1.75],
    "hip.L": [0.11, 0, 0.9],
    "knee.L": [0.11, -0.035, 0.48],
    "ankle.L": [0.11, 0, 0.09],
    "toe.L": [0.11, -0.18, 0.06],
    "hip.R": [-0.11, 0, 0.9],
    "knee.R": [-0.11, -0.035, 0.48],
    "ankle.R": [-0.11, 0, 0.09],
    "toe.R": [-0.11, -0.18, 0.06]
  },
  "bones": [
    { "name": "hips", "head": "hips", "tail": "spine" },
    { "name": "spine", "head": "spine", "tail": "chest", "parent": "hips" },
    { "name": "head", "head": "neck", "tail": "head", "parent": "spine" },
    { "name": "thigh.L", "head": "hip.L", "tail": "knee.L", "parent": "hips" },
    {
      "name": "shin.L",
      "head": "knee.L",
      "tail": "ankle.L",
      "parent": "thigh.L"
    },
    {
      "name": "foot.L",
      "head": "ankle.L",
      "tail": "toe.L",
      "parent": "shin.L"
    },
    { "name": "thigh.R", "head": "hip.R", "tail": "knee.R", "parent": "hips" },
    {
      "name": "shin.R",
      "head": "knee.R",
      "tail": "ankle.R",
      "parent": "thigh.R"
    },
    { "name": "foot.R", "head": "ankle.R", "tail": "toe.R", "parent": "shin.R" }
  ],
  "weighting": "automatic",
  "regions": [
    {
      "name": "belt",
      "object": "Character",
      "bounds": [
        [-0.25, -0.2, 0.85],
        [0.25, 0.2, 0.95]
      ],
      "weights": { "hips": 1 }
    }
  ],
  "stressPoses": [
    { "name": "head-turn", "rotations": { "head": [0, 35, 0] } },
    {
      "name": "step",
      "rotations": { "thigh.L": [30, 0, 0], "shin.L": [-40, 0, 0] }
    }
  ]
}
```

Replace `Character` with the actual name from the geometry report. A region
matches that object, optionally an inclusive XYZ `bounds` box and/or explicit
`vertices` indices. Without either, it covers the whole object. `weights` names
1–4 deform bones with nonnegative weights, normalized by the script. Later
matching rules override earlier ones. Vertex indices refer to the current
normalized mesh and must be reconsidered after any topology change.

The joints stage produces projected joint markers on front/side images plus
`regions-front.png` / `regions-side.png`. The report maps region names to colors
and counts uncovered vertices. Gray means unspecified. Face colors use the
majority of their vertices; inspect boundary triangles separately when needed.
These colors visualize the supplied rules, **not** an automatically correct
body/clothes classification. No regions produces an incomplete check.

## Rig: inspect deformation, not just bone count

Use the same reviewed joint/region configuration with `rig`.

- `weighting:"regions"` (default) requires explicit rules to cover every vertex.
- `weighting:"automatic"` first uses Blender bone heat, then applies the rules.
  Bone heat can fail on disconnected or fused geometry. Failure is not permission
  to use a new paid rigging service or claim a partial binding is complete.
- Actual deform influences are pruned to four per vertex and renormalized.
  The report counts unweighted and non-normalized vertices.
- `stressPoses` maps bone names to local Euler rotations in degrees. Include
  arm-up, arm-forward, step and head-turn poses for a humanoid, with the actual
  bone names/axes. Each pose produces its own front/side render and worst edge
  stretch ratio/mesh/vertex indices. `maximumEdgeStretch` defaults to 2.
- Missing stress poses marks rig checks incomplete. A pass does not prove the
  silhouette, clothing separation, joint collapse or anatomy are acceptable.

Fused sleeves/capes may need mesh separation, retopology and explicit garment
bones before they can deform well. Those are model-specific custom edits.
Preserve the previous stage and show the user the changed mesh and stress images.

## Animate: a measured two-leg baseline

`animate` accepts exactly one unanimated armature from the rig stage. It refuses
to overwrite clips. It adds `Idle` and `Walk`, uses two-bone leg IK with knee
poles, bakes the result to ordinary pose/object channels, removes the constraints,
and stashes each action separately. All clips share the same rest skeleton.
It is an editable baseline for an upright biped facing -Y, not a general motion
generator. Creatures, finger animation, combat and cloth motion need custom code.

Add this to the same configuration, using the actual bone names:

```json
{
  "locomotion": {
    "hips": "hips",
    "left": {
      "upper": "thigh.L",
      "lower": "shin.L",
      "foot": "foot.L",
      "poleAngleDegrees": -90,
      "contactPoint": [0.11, -0.07, 0]
    },
    "right": {
      "upper": "thigh.R",
      "lower": "shin.R",
      "foot": "foot.R",
      "poleAngleDegrees": -90,
      "contactPoint": [-0.11, -0.07, 0]
    },
    "frames": 32,
    "fps": 24,
    "stride": 0.24,
    "lift": 0.07,
    "rootMotion": false,
    "floorZ": 0,
    "maximumSlip": 0.015,
    "maximumPenetration": 0.01
  }
}
```

Each leg must be an upper → lower → foot hierarchy. `contactPoint` is required:
choose an actual sole point in the normalized rest coordinates, not the ankle.
The test transforms this point by the foot's deformation matrix. The script
also samples the lowest **deformed mesh vertex** against `floorZ`; this catches
toe, cloth or other geometry passing below the floor. This is not a mesh/mesh
self-intersection test. Inspect foot orientation; custom bone rolls can require
a different `poleAngleDegrees`.

The baseline uses a 60% stance phase and 40% swing, opposite legs half a cycle
apart. `stride` is each foot's stance travel and `lift` is swing height, in meters.
For a T-pose source, provide `locomotion.poseRotations` as a map of bone names to
local XYZ Euler degrees for the candidate neutral posture. An optional
`locomotion.swingRotations` map adds those angular amplitudes sinusoidally during
Walk only. For example, a specifically checked arm axis may use
`"poseRotations":{"upper_arm.L":[-60,0,0],"upper_arm.R":[-60,0,0]}` and
`"swingRotations":{"upper_arm.L":[0,0,7],"upper_arm.R":[0,0,-7]}`.
These numbers are model-specific; verify actual local bone axes and cloak
deformation. Without these maps, the baseline leaves arms in the source rest pose.
The report gives `travelDistance = stride / 0.6` for the full walk cycle.
With `rootMotion:true`, the armature translates that distance along -Y. With
`false`, it stays in place and contact slip is measured **after adding the
declared virtual root travel**. The game must move the character at
`travelDistance / durationSeconds` or its feet will slide relative to the world.
Do not describe in-place raw world-foot coordinates as planted.

Reports include contact slip, sole and mesh penetration, pose-loop position and
rotation mismatch, and the expected root travel. Loop error compares poses in
armature space so intentional root translation does not count as an error.
Preview output shows four Walk phases from front and side; inspect actual game
playback and obtain human approval before describing motion as natural.

## Export and actual game delivery

Run `export` with the final `.blend`. The stage saves an editable source,
reuses `export_glb.py` for atomic GLB export, then imports it into an empty scene.
It compares triangle count, height, deform bone names and exact clip names.
Clips are shifted to begin at zero seconds so a frame-1 start does not introduce
an extra engine pre-roll interval or change the declared locomotion speed.
It samples imported animations and measures actual deformed-vertex movement;
a named but static clip fails the baseline check. Blender bone-display helper
meshes are excluded from geometry metrics.

`roundtrip.runtimeReview` remains pending. Use the project's registered model
asset tools, resolve the runtime path and load the GLB in the actual engine.
Play every action, check texture/scale/pivot, transition between clips and test
the configured locomotion speed. Keep the original `.blend` and reports.

This workflow's primary runtime output is GLB. Additional FBX export is possible
through custom Blender code, but the project's static FBX preview converter
does not validate rigged FBX. Do not replace the GLB roundtrip/game check with
an FBX file-exists check.

## References

- [Blender command-line options](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- [Blender glTF animation/export behavior](https://docs.blender.org/manual/en/5.2/addons/scene_gltf2.html)

The source workflow separates agent planning, Blender processing, optional Tripo
initial geometry and human review. Numeric checks complement visual acceptance;
they never replace it.
