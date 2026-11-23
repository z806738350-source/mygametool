---
name: blender-assets
description: Use Blender in background mode to build, refine and optimize game props, environments, vehicles, characters and creatures from references or existing models. Check appearance and requested motion at gameplay scale before final user review.
---

# Blender Assets

Run every Blender stage headlessly with `run_blender`, including custom scripts, GLB verification and rendering. The main Agent reviews intermediate stages against the brief using the run report, saved model and rendered images. Continue from the completed tool result without waiting for a Blender window.

When a stage needs a new or revised script or configuration, include `save.content` or `save.edits` in that `run_blender` call. Wait for the result before starting the next Blender stage.

**Before a new Tripo submission from turnaround views**, show the inspected set and wait for the user's approval on the review card. Changed views need a fresh inspection and approval.

**After Tripo returns the initial model**, wait for the user's approval of that model before starting Blender work on it. Follow the [initial model review](references/pipeline.md#review-the-initial-tripo-model) when recovering a result or handling revision feedback.

**At final delivery**, present the checked export on the Canvas and wait for the user to accept that version before replacing approved game art. The user can also open the saved `scene.blend` manually. Pause at any additional checkpoint the user requests.

When technical details are missing, use what is known about the asset, camera, target device and expected on-screen count to choose reversible starting settings. State assumptions that affect the result and proceed. If a firm requirement conflicts with the requested look or use, explain what the player would notice and recommend a feasible option. Ask when proceeding requires a decision from the user. At turnaround and final review, explain what you checked in plain language and ask the user to judge the design or in-game feel. Include technical details when they inform the decision or the user requests them.

## Choose the next step

Check `blender_status` for local availability and reuse a current result from this turn. Refresh after a configuration change or unexpected failure. If Blender is unavailable, report the reason and retain the source. With `read_workflow_guide`, select `blender-assets` and pass the linked filename alone as `reference`. For a revision, start from the retained brief and report. Open only the stage references needed for the current edit that are missing from context.

| Starting point | First action | Stage guide |
| --- | --- | --- |
| Concept art, new Tripo model | **Before generating the first view**, inspect the original and map identifying features to the front, subject's left and back. Follow the inspection and approval steps before submitting. For local 2D design or weapon corrections, use [design proofs](references/design-proofs.md). Open the 3D pipeline when modeling begins. | [Turnaround and Tripo](references/turnaround.md) |
| Existing model, including a retained Tripo result | Preserve the selected original and inspect a working copy. Compare its silhouette, materials, UVs, pivots, rig and clips with the requested edit. Keep the parts that already work. | [Source inspection and cleanup](references/pipeline.md) |
| Dimensioned prop, vehicle or modular environment | Start with measured parts. Check silhouette and assembly against the dimensions. For a kit, test adjoining pieces on their grid. For moving hardware, test the pivot and clearance. A fully specified static prop can go straight from modeling checks to export. | [Measured parts and export](references/pipeline.md) |

For a rig, deformation or requested clips, open [rigging and animation](references/rig-animation.md) before placing joints or adapting a skeleton. Bundled `animate` drives one pair of legs on an upright biped. For legless or multi-legged locomotion, reuse a suitable clip or use `custom` to author one. For a custom modeling, animation or diagnostic script, open [Blender Python](references/custom-python.md) before writing it.

## Work from the retained source

For a game asset, use the [optimization guide](references/optimization.md) when planning the game copy. Apply improvements suited to the camera, device and instance count. Before delivery, compare the measured savings and appearance against the retained source.

On the first production `run_blender` call, record the goal, route, observable visual criteria and requested deliverables in the brief. Preserve the project asset ID or source path. Keep the same workflow and continue from the previous run's unchanged `scene.blend`. For an interrupted Blender run, use `recover_blender_run` with the original `runId`. For an already submitted Tripo task, recover the original task before considering another paid request.

After reducing a Tripo model, run the [static comparison](references/pipeline.md#static-comparison-for-tripo-assets). Repair visible regressions and compare again even if the triangle count meets the target. Adjust estimated targets when the views justify it, honor explicit maximums, and explain any triangle increase at delivery. Use the exact repaired export for final review.

Check the stage report and actual renders at the intended game-camera distance. Record the run, observed defect and correction in the asset document. Recheck the same view, pose or measurement after the edit. Keep unavailable visual evidence marked unverified. If the user asks to see progress, present the completed run on the Canvas with `recover_blender_run` and `reviewPresentation: "checkpoint"`. If a correction would change a defining feature or require additional spending, show the trade-off and wait for the user's decision.

## Deliver to the game

Run the bundled `export` stage on the final editable scene. Inspect its reimported GLB, rendered evidence and requested clips, then present that exact run with `recover_blender_run`. Use [the export and Canvas settings](references/pipeline.md) for the final call. For a game, resolve the model with `get_model_asset` and check scale, pivot, materials and playback in the target engine. For an asset-only brief, identify any checks that still require a game scene. Invite the user to rotate the candidate, play the relevant clips and say what they accept or want changed.
