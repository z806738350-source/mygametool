---
name: blender-assets
description: Make repeatable game models, rigs and animation with the main Agent and controlled local Blender; optionally use Tripo for an organic initial mesh, with human review at each quality milestone.
---

# Blender Assets

The main Agent plans, writes scripts and inspects evidence. Blender performs geometry,
rigging, animation and export. Tripo supplies an initial organic mesh only when needed.
The user decides whether shape, deformation and motion are good enough.

Read [the pipeline reference](references/pipeline.md) before writing configuration.
Use `blender_status` to check the actual local capability. If it is unavailable, report
the reason; do not enable shell, MCP or a paid rigging service as a substitute.

## Choose the route

- **Props, buildings and vehicles:** describe dimensions, locations, material colors
  and connections in `parts.json`. Review those numbers and available orthographic
  views with the user, then use the `parts` stage or a custom Blender script. A fully
  specified primitive prop does not need Tripo or generated reference images.
- **Characters and creatures:** inspect consistent front, left and back reference
  images (optional right). For humanoids prefer an A-pose with arms clear of the body
  and legs apart, or preserve the requested T-pose. Keep hands empty; create weapons
  separately. Use `list_media_capabilities`, the project-selected Tripo generation
  model and `generate_3d_from_views`. Keep its original GLB and task receipt. Existing
  suitable models skip generation. Show the initial shape for human review before
  spending effort on cleanup or rigging.

Use existing media recovery tools for a submitted Tripo job. Local processing never
requires a new paid generation, and provider rigging is not a fallback for this route.

## Run a stage

Write the configuration or custom Python as ordinary project files. Call `run_blender`
with a stable `workflow` name, `stage`, `configPath`, and the prior `sourcePath` when
needed. List additional project-relative inputs explicitly in `inputs`; files not
listed are unavailable to the process. The stages are `parts`, `clean`, `joints`,
`rig`, `animate`, `export`, and `custom` (requires `scriptPath`). Consult the tool's
actual schema and the reference for exact settings.

Each run returns a new `runId` and independent output paths. Preserve the original
and previous runs. Use the returned `scene.blend` for the next stage. Keep configuration,
script and result paths in the project's asset production document. If delivery is
interrupted, call `recover_blender_run` with that runId; it recovers saved work and
never starts Blender or submits a provider request.

Custom scripts run inside Blender's bundled Python, in a private directory without
network or access to other host files. Parse `--input-dir` and `--output-dir` after
`--` in `sys.argv`; read only declared inputs and save results under output-dir.
Use `import pipeline` or `import export_glb` to reuse the bundled helpers. The
executed script and helpers are preserved together in the result's `recipe/`.
Do not install packages, launch helpers, or depend on user Blender preferences.
Save the editable `.blend` explicitly with `bpy.ops.wm.save_as_mainfile(..., compress=False)`; pack textures. Name datablocks explicitly and
select shader nodes by type rather than translated labels. Bake procedural materials
that glTF cannot represent. Never load an untrusted `.blend` with auto-execution enabled.

## Review and iterate

1. **Clean:** normalize scale, orientation and floor; preserve UVs and materials.
   Inspect topology and triangle budget. Use only an approved reduction target.
   Holes, disconnected regions and fused clothes need specific repairs, not blind
   remeshing. Do not claim cleanup solved topology that its report only counted.
2. **Joints and regions:** write explicit joint positions in `joints.json`; inspect
   front/side overlays and region colors. Coordinate values refer to the normalized
   Blender source. Get human confirmation before rigging. Color and position are
   candidate labels, never proof of body/clothing separation.
3. **Rig:** use the approved skeleton and rest pose. Correct weights with explicit
   per-object or vertex-region rules; add garment bones when the asset needs them.
   Keep weights from crossing unrelated sleeves, torso, belt and hem. Read the weight
   report and show stress poses (arms up/forward, step, head turn) to the user.
4. **Animate:** keep the same skeleton and rest pose. Review key poses before filling
   a new action. Use foot IK/contact intervals for walking. Inspect foot sliding,
   floor penetration, loop closure and deformation; show actual playback before
   claiming natural motion. The bundled humanoid idle/walk is an editable starting
   point, not a universal animal or clothing solution.
5. **Export:** deliver editable `.blend`, GLB, reports and review images. The exporter
   reuses the bundled `export_glb.py` and verifies a clean reimport. Compare actual
   bones and animation clips, not just file existence. FBX is an additional exchange
   format only when the destination needs it; current local FBX previews cannot
   validate skeletal animation.

Read every stage report and inspect actual images with an image-capable model. Return
uncertain visual decisions to the user. At dimensions/reference, initial-shape,
joint/region, deformation and animation milestones, show concrete evidence and ask
for human acceptance through the conversation/questionnaire. Wait for the answer.
Keep any accepted decisions and requested changes in the asset document. Never record
human approval from an Agent's own assessment, a script exit code or a passing metric.
Limit automatic repair of one stage to three attempts, then present the unresolved
problem and retain all evidence.

## Deliver to the game

Use `get_model_asset` on the exported model for the project's runtime asset path and
resource checks. Register the final result on the existing Canvas with its original
source links, then actually use the returned runtime resources in the game. Load it
in the project's engine, verify scale, pivot, orientation, texture, skeleton and every
clip, and use `game_use` when available. Distinguish structural checks, rendered
inspection, human acceptance and actual game playback. If one is missing, say which.
