# Rigging and animation

Use this reference when an asset needs deforming joints, weights or animation. Inspect the selected model's existing skeleton and actions first. Keep a usable rig when editing a model. For an articulated door or wheel, test the rigid pivot and its full travel. A skin is needed only for mesh deformation.

The bundled coordinate examples use Blender world coordinates in meters, +Z up and a front view on −Y. Start each stage from the last retained `scene.blend`. Use [the custom Python guide](custom-python.md) for model-specific repairs or clips beyond the bundled stages.

## Joints and regions: explicit anatomical input

Run `joints` on the retained `scene.blend`. `joints` is a dictionary of named
XYZ positions. Each bone names its head/tail joints and optional parent; parents
must form a valid acyclic hierarchy. Optional `rollDegrees` controls its local
axes. Optional `deform:false` is for control bones. Coordinate estimates must
be corrected against the actual front/side render, not copied blindly.

This example illustrates naming and hierarchy. Fit joint positions to this subject
and add the clavicles, arms, hands, fingers, neck or garment bones required by the brief.

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
  "regionCoverage": "automatic-remainder",
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
matching rules override earlier ones. Vertex indices refer to the mesh in the
current working scene and must be reconsidered after any topology change.

The joints stage produces projected joint markers on front/side images plus
`regions-front.png` / `regions-side.png`. The report maps region names to colors
and counts uncovered vertices. Gray means unspecified. Face colors use the
majority of their vertices; inspect boundary triangles separately when needed.
The colors visualize the supplied rules. Check their boundaries against the
actual anatomy and clothing. By default every vertex needs a region. Set
`regionCoverage: "automatic-remainder"` together with `weighting: "automatic"`
when the rig should use automatic weights for the intentionally unlabeled
vertices. The example labels the belt and leaves the rest to automatic weights.
Deform bones must intersect the mesh bounding box with its fitting tolerance;
external controls can use `deform:false`. Passing the bounds check only locates
the bone relative to the asset. Inspect its anatomical location on the overlays.

## Rig: inspect deformation, not just bone count

Use the same reviewed joint/region configuration with `rig`.

- `weighting:"regions"` (default) requires explicit rules to cover every vertex.
- `weighting:"automatic"` first uses Blender bone heat, then applies the rules.
  Bone heat can fail on disconnected or fused geometry. Failure is not permission
  to use a new paid rigging service or claim a partial binding is complete.
- Actual deform influences are pruned to four per vertex and renormalized.
  The report counts unweighted and non-normalized vertices.
- `stressPoses` maps bone names to local Euler rotations in degrees. Choose
  movements that exercise the asset's functional joints. For a humanoid these
  can include arm elevation, reach, step and head turn. Each pose reports the
  worst edge stretch plus vertex movement for the combined pose and each rotated
  deform bone in isolation. `maximumEdgeStretch` defaults to 2. Inspect two
  angles at a suspect joint for collapse, interpenetration or an accessory that
  moves with the wrong bone.
- Missing stress poses marks rig checks incomplete. A pass does not prove the
  silhouette, clothing separation, joint collapse or anatomy are acceptable.

Fused sleeves/capes may need mesh separation, retopology and explicit garment
bones when permitted by the brief. If the brief excludes garment bones, repair
the garment geometry or weights on the existing skeleton.
Preserve the previous stage and compare the changed mesh and stress images with it.

## Weapon actions

Identify the weapon and its intended action from the brief and the actual shape.
Record the action as an observable result, such as which part leads during
contact, in `brief.visualCriteria` or the acceptance notes for a revision.
Use the reference to reproduce the weapon's design and the grip and orientation
shown in the presentation pose. For animation, follow the requested use of the
weapon. If the brief leaves the action open, choose a plausible action from the
weapon's geometry and intended game use, state the assumption, and proceed.

For every authored weapon action, locate the grip and the functional part on the
actual model in local coordinates before keying. For a cut, mark the sharp edge
and which way it cuts. For a thrust, use the tip and its forward axis. For a blunt
strike, use the intended impact surface. For a ranged action, identify its aim
and release point. Adjust the wrist or grip as appropriate so the functional part
aligns with the intended travel or aim when the action takes effect. Keep the
hold plausible through preparation, contact or release, and recovery.

Play the reimported GLB at normal speed and inspect frames immediately before,
at and after the intended contact or release from an angle where orientation is
clear. Sample the functional point across this interval if the frames leave the
direction unclear. Check that the intended edge, tip or striking surface leads
the motion, or that the aim and release agree. Check hold, clearance and timing
as well. Correct the relevant grip, wrist or path and repeat the check on the
revised export before presentation. A generic clip check confirms motion; use
this review to confirm the requested action. Game hit timing and damage remain
gameplay checks when they are part of the request.

## Legless locomotion

Reuse a suitable clip or author the movement with `custom`. For a snake slithering side to side, pass a bend along a chain of body bones. For a crawling earthworm, stagger the extension and contraction of segments around their ground contacts. A slime can squash and stretch with shape keys or a scaling bone, widening as it flattens if its volume should appear constant. Play the reimported GLB through the loop and check body contact, displacement and silhouette against the reference.

## Locomotion on four, six or eight legs

Keep a suitable existing clip. To author or change the gait, use a `custom` stage on the retained scene. Map every walking leg to its actual bone chain and ground-contact point. Preserve imported bone names, weights and action bindings. For a new skeleton, number leg pairs from front to back and label each segment and anatomical side, for example `leg01.upper.L` → `leg01.lower.L` → `leg01.foot.L`, mirrored on `.R`. Use the segments the animal actually has.

Map one stride to phases 0–1 and record each foot's touchdown phase and stance duration for the reference gait and speed. Two alternating groups might touch down at 0 and 0.5. L and R below are the creature's own sides.

- A quadruped trot can alternate diagonal pairs, left fore with right hind and then right fore with left hind. For a four-beat walk, give the feet distinct touchdown times.
- A six-legged creature can alternate the tripods L1/R2/L3 and R1/L2/R3.
- A spider-like gait can alternate L1/R2/L3/R4 with R1/L2/R3/L4. Offset individual contacts if the reference shows staggered timing.

Play the reimported clip through two cycles. Follow each foot from touchdown through stance, lift-off and swing. To judge stance slip, add the intended game displacement to an in-place clip's sampled foot position. For a root-motion clip, use the animated world position directly. Check floor penetration and clearance between neighboring legs. Compare the root-relative pose and foot trajectory across the loop seam. Use another camera angle or sample the mapped contact points in the custom script if feet overlap on screen. Report numerical per-foot results only for measurements actually taken.

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
choose an actual sole point in the working scene's rest coordinates.
The test transforms this point by the foot's deformation matrix. The script
also samples the lowest **deformed mesh vertex** against `floorZ`; this catches
toe, cloth or other geometry passing below the floor. This is not a mesh/mesh
self-intersection test. Inspect foot orientation; custom bone rolls can require
a different `poleAngleDegrees`.

The baseline uses a 60% stance phase and 40% swing, opposite legs half a cycle
apart. `stride` is each foot's stance travel and `lift` is swing height, in meters.
For a T-pose source, use `locomotion.poseRotations` to set the neutral arm pose.
Both this map and `locomotion.swingRotations` take bone names and local XYZ
angles in degrees. Walk adds the signed swing angles at left-foot contact and
subtracts them at right-foot contact. Check each shoulder's local axes and the
resulting wrist direction. Without either map, the arms keep their rest pose.
For a natural walk with freely swinging arms, play both steps of the reimported
GLB from the side. The right arm should lead with the left leg and the left arm
with the right leg. Check clothing deformation and preserve a held-object or
stylized pose when requested. Use `custom` for other timing.
The report gives `travelDistance = stride / 0.6` for the full walk cycle.
With `rootMotion:true`, the armature translates that distance along -Y. With
`false`, it stays in place and contact slip is measured **after adding the
declared virtual root travel**. The game must move the character at
`travelDistance / durationSeconds` or its feet will slide relative to the world.
Do not describe in-place raw world-foot coordinates as planted.

Reports include contact slip, sole and mesh penetration, pose-loop position and
rotation mismatch, and the expected root travel. The bundled report lists the
two foot bones used for contact measurements in `contactFootBones`. Loop error compares poses in
armature space so intentional root translation does not count as an error.
Preview output shows four Walk phases with a fixed camera for each of the front
and side views, making root travel and drifting contact easier to compare. Inspect those samples
and verify actual playback before presenting the motion for final user review.

Review the key poses of every requested action and the transitions in game. For final motion evidence, use the [export checks](pipeline.md#export-and-actual-game-delivery) on the reimported GLB.
