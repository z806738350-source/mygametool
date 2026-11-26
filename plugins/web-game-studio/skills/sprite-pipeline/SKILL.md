---
name: sprite-pipeline
description: Create and integrate 2D action strips and sprite atlases. Review an animation against the character's visible anatomy and the requested action, repair defects, and verify the published frames in play.
---

# Sprite Pipeline

Use the approved character, camera, scale and anchor. For eight static standing directions or a revision to a standing view, read the `eight-direction-character` guide.

## Make one motion reference per action

Before making the first frames of any new action, including idle and walk cycles, choose the one approved standing view that shows its movement most clearly. Pass it in `imagePaths` to `generate_image`, with a supported `resolution` and `aspectRatio` for that view. Set `imageModel` to the `gpt-image-2.6-sunburst` entry from `list_media_capabilities` and `outputFormat` to `gif`. Describe the motion and keep the camera fixed. Save one GIF per action and reuse it across facings, repairs and resumed work. If its download fails, use `recover_media` with the original call ID.

Decode the GIF locally into a numbered contact sheet and inspect the poses in playback order. A local preview can use `ImageDecoder` to draw the frames and `game_use` to capture the sheet. Identify the visible changes that define this action, such as a weight shift, contact, reversal or return to rest. Use those observations to direct each facing from its own approved standing art. Set playback timing for the game.

**Production order for eight-direction actions**

1. Select the standing view, generate the Sunburst GIF and inspect its frames as described above.
2. Make and integrate the E and W samples. Playtest both in the game and fix any issues found.
3. Once E and W pass playtesting, make the remaining six facings with the same reference and playtest the full action. The main agent continues independently by default.

## Choose what to check

Read the actual art and game animation configuration first. Identify the moving parts, how they attach, which side is visible, what the body contacts, and what the requested action should do over time. Account for occlusion and for motion the game supplies, such as world-space jump height. Make these decisions yourself from the request and artwork.

Choose observable events before assigning frame numbers. For a trot, look for diagonal support changes; for a jump, find compression, takeoff, apex, first contact and recovery. For a wingbeat, follow the wing roots and inspect stroke reversals; for a slither, follow the bend from head towards tail. Change the checks for a different gait, camera or character design. A silhouette can hide a far limb legitimately. Compare adjacent phases or an available neighbouring facing when uncertain.

## Create and repair

1. Inspect the runtime's frame size, direction convention, speed, anchor, timings and loop or one-shot behaviour. Choose the frame count to describe the requested action. Use approved art as the reference. Generate or edit one facing's continuous action as a strip when practical; keep identity and equipment consistent. Canvas assets use `generate_canvas_media`; standalone source art can use `generate_image`.
2. Inspect the event poses at game size and inspect **every frame** for temporary holes, broken joints, stray pixels, flicker and clipping. Compare against contrasting backgrounds and adjacent poses. Protect natural gaps, antialiasing, hair and effects. For long strips examine the selected events and request the missing ranges when visual evidence is needed.
3. For a **published biped walk**, keep the existing expert path. Call `review_sprite_walk` with `setId` and `direction`. Check opposite hand/foot contacts and the passing poses. For failed cutout directions, preview `repair_sprite_walk` using their direction names and the current revision. Inspect the strips, then apply the exact candidate digest and recheck the published atlas. The walk package is `public/characters/<setId>/walk.json`; use `gait: "biped"`. Both tools can take corrected anatomical rectangles or contact indices when a landmark is inconclusive.
4. For **other actions**, use `review_sprite_action` and `repair_sprite_action`. Read [action-review.md](references/action-review.md) for the file layout and visual review. For other anatomies, name and mark the relevant parts on the standing image yourself. Use their measured movement relative to the body to locate informative frames. The reference can be a single approved facing. Preserve the game's existing metadata and playback; verify the PNG and frame rectangles it actually uses.
5. Repair the cause. Restore painted overlap for a broken joint, correct a misplaced pose or its timing, or redraw the affected phase when the pixels to restore are hidden. Inspect each candidate, especially neighbouring frames and the loop boundary. If local repair cannot recover the intended art, use the existing art workflow within the task's generation permissions and review the result. Preserve good poses and directions. A runtime-only patch does not repair a delivered atlas.
6. Play the **published** action. Trigger a one-shot and its return to idle, or run a loop across its wrap and a direction change. For moving contacts, compare the planted limb with the ground while the actor actually moves. Use the game's real animation speed. Continue repair and recheck within the task; report genuinely unresolved parts and frames when evidence runs out.
