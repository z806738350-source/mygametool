---
name: web-3d-asset-pipeline
description: Prepare turnaround views from concept art for image-to-3D modeling, then create, optimize, and integrate browser-game GLB or glTF assets.
---

# Web 3D Asset Pipeline

Use this skill for shipped 3D assets rather than scene, camera, or gameplay architecture. Preserve established scale, axes, naming, pivots, and material conventions.

## Pipeline

1. Define the asset's gameplay purpose, visible size, interactions, animation needs, collision role, and target budget.
   For dimension-driven props, buildings or vehicles, use `read_workflow_guide` with `blender-assets`, approve `parts.json`, and use the controlled local Blender stages. For organic models, use Tripo only for the initial shape when needed, then use that Blender workflow for cleanup, reviewed joints, weights and animation. Preserve original models and every local run. Human acceptance of shape, deformation and motion remains separate from numerical checks.
2. Create or acquire the source using the user's requested workflow. Use `generate_canvas_media` for saved canvas nodes, `generate_3d_from_views` for standalone production models from inspected views, `generate_3d_asset` for text or mesh processing, or a matching installed reconstruction skill when appropriate.
3. Normalize transforms, units, axes, pivots, hierarchy names, and material assignments.
4. Ship GLB or glTF 2.0 unless the existing engine has a different established runtime contract.
5. Remove unused nodes, duplicate materials, excess geometry, and oversized textures.
6. Add collision proxies, LODs, animation clips, or baked-lighting data only when the runtime needs them.
7. Integrate through stable asset keys and validate the actual runtime load.

## Modeling from existing concept art

1. Identify the approved design and open any existing views. Agent image-to-3D defaults to `turnaround`. When the user wants a production model from that art, save `options.referenceMode: "turnaround"` on its Canvas node. Use `"provided-views"` only for an explicitly requested study with fewer views. Prepare separate orthographic front, left profile and back images, plus a right profile if available. This applies to creatures, props and buildings as well as characters. Check the selected model in `list_media_capabilities`. If it cannot accept three views, keep the job pending and report the constraint.
2. Reuse each view that already matches. An angled illustration can establish the design. To create a missing view directly, use `generate_reference_image` with the original art in `imagePaths`, starting with the front if needed. For a saved image node, use its Canvas generation workflow. Inspect the front before using it alongside the original as a reference for the side and back. Keep the whole subject visible at the same scale, with level framing and consistent materials. Track details around the object: a latch on the left of a chest must stay on that physical side, and rear hinges must agree with the side view.
3. For a rig-ready Tripo humanoid, also set `options.pose` to `a-pose` or the requested `t-pose`. For a T-pose show the entire figure with arms straight out at shoulder height and legs apart. For an A-pose angle the arms down away from the torso. Keep the outfit, pose and asymmetric equipment consistent as the viewpoint moves around the figure. Keep hands empty and weapons as separate assets so they do not fuse to the hand.
4. Open the pixels of **each** file before connecting it. A valid front faces the viewer squarely, the left camera view shows the subject's own left side squarely, and the back shows the rear surface. An existing sheet can be split where it already depicts distinct views. A rotated or mirrored copy of one drawing cannot supply unseen geometry. Leave any unresolved slot empty, keep the turnaround setting and finish preparing the views before calling `generate_canvas_media` or `generate_3d_from_views`. If a view cannot be inspected, stop before the 3D call. For Tripo pass the separate files in front, left, back, optional right order. For a direct call supply these paths in `imagePaths`; keep surface and shape requirements in the inspected images. Keep image-edit instructions on the image-generation nodes.

## Optimization

- Prefer material and texture reuse over unique resources per mesh.
- Choose geometry compression based on runtime support and decode cost.
- Use KTX2 or BasisU when the loader and asset pipeline already support them.
- Size textures for on-screen use rather than source-art resolution.
- Keep collision meshes simpler than visible geometry.
- Measure before adding LODs or aggressive compression to small assets.

## Validation

Check load errors, scale, orientation, pivot behavior, material appearance, animation names, collision alignment, memory or download cost, and disposal. Do not claim visual parity from file metadata alone.

Use `../three-webgl-game/SKILL.md` or `../react-three-fiber-game/SKILL.md` for runtime scene integration and `../game-playtest/SKILL.md` for player-facing verification.
