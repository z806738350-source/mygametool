---
name: blender-assets
description: Create game models, rigs and animation in local Blender. The Agent checks and repairs each stage, then presents the finished model and motion for final user review.
---

# Blender Assets

By default the main Agent reviews intermediate stages and continues when the evidence
meets the user's brief. The user reviews the final candidate. If the user asks to
see progress, show it and keep working. If they ask to approve a stage, wait there
for their decision. Ask earlier when a decision only the user can make blocks work.
Blender performs geometry, rigging, animation and export. Tripo can supply the initial organic mesh.

Read [the pipeline reference](references/pipeline.md) before writing configuration.
Use `blender_status` to check the actual local capability. If it is unavailable, report
the reason; do not enable shell, MCP or a paid rigging service as a substitute.

## Choose the route

- **Props, buildings and vehicles:** describe dimensions, locations, material colors
  and connections in `parts.json`. Compare those numbers with the requested proportions
  and available orthographic views, then use the `parts` stage or a custom Blender script. A fully
  specified primitive prop does not need Tripo or generated reference images.
- **Characters and creatures:** inspect consistent front, left and back reference
  images (optional right). For humanoids prefer an A-pose with arms clear of the body
  and legs apart, or preserve the requested T-pose. Keep hands empty; create weapons
  separately. Use `list_media_capabilities`, the project-selected Tripo generation
  model and `generate_3d_from_views`. Keep its original GLB and task receipt. Existing
  suitable models skip generation. Check the initial shape against the references from
  multiple angles, including the back, before proceeding to cleanup or rigging.

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

Authoring runs under `assets/blender/<workflow>/runs/<runId>/` stay on the host;
the isolated Linux command copy excludes that entire directory, including JSON
and Python files. Use the registered project file reader (`read` or
`read_project_file`) to inspect `report.json`, `rig.json`, recipes and, when
the selected model supports images, the actual renders. For computed checks, use a diagnostic `run_blender` custom script
with those files explicitly declared in `inputs`. A missing path in
`isolated_shell` does not mean the original was lost. Do not regenerate it or
copy the whole authoring run into the game; use `get_model_asset` and its returned
`runtimePath` for game integration.

Check `blender_status.liveWorkWindow` before promising a live window. When available
on desktop, each task automatically opens a movable, resizable Blender observer
and closes it when work finishes or is cancelled. It shows copies of the worker's
actual intermediate scenes at checkpoints; the Agent is not performing each
operation through the GUI. Long native operations may hold the previous scene
until the next checkpoint. Report any observation warning separately from the
production result. Keep saved work; do not rerun a completed task or use paid
generation to repair a missing window.

Keep the default `reviewPresentation: "internal"` on `run_blender`. Inspect the
files at their returned paths and leave the main board free of process nodes.
Bundled modeling stages produce `review.glb` and export produces `model.glb`.
Custom modeling scripts should export a `review.glb` from their saved scene;
diagnostic scripts can return just the evidence they measured. To show progress on
request or evidence for a decision the user needs to make, call
`recover_blender_run` with the original `runId`,
`reviewPresentation: "checkpoint"` and the current `boardId` when known.
Reuse its returned Canvas nodes.

Custom scripts run inside Blender's bundled Python, in a private directory without
network or access to other host files. Parse `--input-dir` and `--output-dir` after
`--` in `sys.argv`; read only declared inputs and save results under output-dir.
Use `import pipeline` or `import export_glb` to reuse the bundled helpers. The
executed script and helpers are preserved together in the result's `recipe/`.
For live observation, use `from live_preview import checkpoint` and call
`checkpoint("Describe the completed operation")` after meaningful scene changes.
Use `force=True` for the loaded source and final scene. Updates are otherwise
limited to once per second; do not add sleeps or launch a GUI yourself. When
live observation is not enabled, the helper does nothing. The user can watch progress
in the live window and review the finished asset on the Canvas.
Do not install packages, launch helpers, or depend on user Blender preferences.
Save the editable `.blend` explicitly with `bpy.ops.wm.save_as_mainfile(..., compress=False)`; pack textures. Name datablocks explicitly and
select shader nodes by type rather than translated labels. Bake procedural materials
that glTF cannot represent. Never load an untrusted `.blend` with auto-execution enabled.

## Review and iterate

1. **Clean:** normalize scale, orientation and floor; preserve UVs and materials.
   Inspect topology and the project's triangle budget. Preserve the original when reducing geometry.
   Holes, disconnected regions and fused clothes need specific repairs, not blind
   remeshing. Do not claim cleanup solved topology that its report only counted.
2. **Joints and regions:** write explicit joint positions in `joints.json`; inspect
   front/side overlays and region colors. Coordinate values refer to the normalized
   Blender source. Verify the joint markers and garment boundaries before rigging. Color and position are
   candidate labels, never proof of body/clothing separation.
3. **Rig:** use the checked skeleton and rest pose. Correct weights with explicit
   per-object or vertex-region rules; add garment bones when the asset needs them.
   Keep weights from crossing unrelated sleeves, torso, belt and hem. Read the weight
   report and inspect stress poses (arms up/forward, step, head turn) from both sides of a suspect joint.
4. **Animate:** keep the same skeleton and rest pose. Review key poses before filling
   a new action. Use foot IK/contact intervals for walking. Inspect foot sliding,
   floor penetration, loop closure and deformation during playback. The bundled humanoid idle/walk is an editable starting
   point, not a universal animal or clothing solution.
5. **Export:** deliver editable `.blend`, GLB, reports and review images. The exporter
   reuses the bundled `export_glb.py` and verifies a clean reimport. Compare actual
   bones and animation clips, not just file existence. FBX is an additional exchange
   format only when the destination needs it; current local FBX previews cannot
   validate skeletal animation.

Read the stage report and inspect the corresponding renders with an image-capable
model. Record the run, evidence, observed defects and next action in the asset document.
Correct visible or measured defects locally and recheck that stage. After three
repair attempts, retain the best candidate and identify the remaining problem.
If essential evidence cannot be inspected, report what is unverified.

Ask for an early decision when the brief leaves a consequential design choice open,
the fix would visibly depart from the user's reference, the next step needs
additional spending the user has not authorized, or a persistent defect leaves
a choice between keeping the candidate and changing its design. Show the relevant
evidence and explain what each option would look like or cost. Ask one concrete
question in everyday language. Wait for the user's answer before taking the
dependent step. Continue work that does not depend on that answer.

## Deliver to the game

Check the exported GLB by reimporting it. Present one final candidate on the Canvas
by calling `recover_blender_run` with the inspected `runId`,
`reviewPresentation: "final"` and the current `boardId`
when known. For game delivery, use `get_model_asset` with the returned asset ID to
resolve its runtime path. Load that candidate in the target engine and verify scale,
pivot, orientation, materials and every requested clip. Use `game_use` when available.
Repair any playback failure before inviting the user to review. For an asset-only
project, verify the GLB and clips and identify which engine checks still need a game scene.

Once the candidate passes the applicable checks, point the user to its model node
and give a short invitation in their language, such as “Turn the character around
and play Walk. Does it look and move the way you want? You can accept it or tell me
what looks wrong.” Wait for that response before recording user acceptance or
replacing an approved game asset. If the user requests changes, revise the relevant
stage, repeat the affected checks and present the revised candidate. Keep the
Agent's observations and the user's decision separate in the asset document.
