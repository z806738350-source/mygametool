---
name: ink-studio
description: Build and playtest a small original Web Game using Ink Studio's bundled WebGL 2 renderer, procedural pixel-art scenes, and editable game rules.
---

# Ink Studio

Use this workflow when the user selects Ink Studio to try a gameplay idea, or asks to revise an existing Ink Studio game.

1. **Confirm the intended change.** Preserve the theme, controls, and rules the user specifies. Build one complete, playable loop for a new prototype. In an existing game, inspect the entry page and source first, preserve its working setup, and change the requested behavior. Ask only when a decision would materially change the result.
2. **Prepare the project runtime.** Call `ensure_ink_runtime` with no arguments. Use its returned `toolkitPath` and `rendererPath` relative to the project workspace, then derive the relative imports from the game module that uses them. The returned `directory`, `manifestPath`, and `upstreamCommit` identify the bundled version. Treat the runtime files as dependencies. If preparation fails, report the actionable reason.
3. **Build the playable scene.** Use a small static HTML, CSS, and JavaScript project for a new game. Call `read_workflow_guide` with `{ "guide": "ink-studio", "reference": "browser-api.md" }` before coding. Follow the example: use `makeBuilder` and `KIT.sculpt` to build the visible scene, then call the bundled `createRenderer` and its `render` method to draw it. Importing the modules without using those APIs does not produce an Ink Studio scene. Keep gameplay and tuning in readable source and use a real control loop to move the visible player or change the scene. The requested procedural art uses the bundled browser modules and needs no CDN, package installation, or paid art generation.
4. **Set the splat look on the first playable asset.** For a new scene, start with smaller, denser splats on the main gameplay asset and turn off pixelation for a sharper silhouette. Use the [splat detail comparison](references/browser-api.md#compare-splat-detail) in Play before applying the look to the rest of the scene. Use a coarse pixel grid when the user requests that style. When revising an existing game, apply this step to the requested visual changes and respect the established art direction.
5. **Build in stages.** Establish a visible first frame, then add and verify the moving player, a reusable projectile, an enemy, and finally independently moving Boss parts. After each stage inspect the scene and real input before adding the next. Do not treat a successful module import or finite data as proof that a part is visible.
6. **Play and revise.** Follow [the playtest reference](references/playtest.md). Use `game_use` if available to check the actual displayed page, inputs, state transitions, and restart. Inspect and fix failures before handing off. For follow-up feedback, update the existing project and repeat the relevant playtest. Report any check you could not carry out.

Use the existing OhMyGame preview and Play entry. Keep the shipped project portable under a static HTTP server.

Classify failures by their actual stage: module loading, scene/material/bake, WebGL 2 context creation, renderer/shader initialization, runtime context loss, or gameplay. Preserve the original error and component name for diagnosis; do not label a scene error as unsupported WebGL. This pinned bake profile is the supported runtime; it does not include the full `KIT.diorama` authoring API.
