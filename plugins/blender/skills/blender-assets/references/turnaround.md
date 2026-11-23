# From concept art to a Tripo model

## Before generating a view

Read the original art. Identify the silhouette, proportions and a few features that distinguish the subject. For each asymmetric feature, record its attachment points on the subject’s own left or right. In each image prompt describe the camera and which of those landmarks should be visible from that angle.

Prepare separate full-body or full-object orthographic images in front, left profile, back and optional right profile order. Match the scale, pose and ground line. For a rig-ready humanoid, use the requested neutral pose with clear space around the limbs. Separate equipment that will be attached or swapped in game. Put style, finish and pose instructions in the view-generation prompts and Blender brief.

Reuse existing art for an angle when it shows the required view and pose. Split an existing sheet only if it already depicts distinct angles. For a new view, attach the original to its Canvas image node. Also attach the verified front when generating the side and back. For standalone generation, use `generate_reference_image` with the original in `imagePaths`. If an earlier image request may have run, recover that request before creating a replacement.

## Inspect each generated image

- **Front.** Compare the silhouette, head-to-body ratio, major colors and attachment points with the original before using the front as a reference for other views.
- **Left profile.** Position the camera on the subject’s left. Trace a strap from its near-side attachment to the point where it disappears behind the body. For example, on a front-facing character, a suspender rising toward the viewer’s right reaches the character’s left shoulder. The true left profile should show its shoulder attachment. If its opposite waist anchor is behind the torso, that anchor should be hidden. For a right profile, repeat the visibility check from the other side.
- **Back.** On humanoids, trace each forearm to the wrist and thumb. Use wrist rotation to determine how much of the palm or back of the hand is visible. Follow each ankle to the heel and toes. In a forward-facing neutral pose, the rear view usually shows the heels. Check a neutral figure with front-facing toe boxes or repeated front-view hands against the intended pose. For other subjects, trace their corresponding landmarks around to the back.

Keep passing views and repair the affected angle. Show the complete set on the Canvas. Call `inspect_3d_views` with the final ordered `imagePaths` and include the concept art as `originalPath` when available, using a project path or authorized attachment reference. Look at the returned images together. Give one concrete finding per view in chat and identify any uncertainty. Reinspect the complete set after a correction.

## Wait for the user, then hand off the original

Choose the project’s Tripo model through `list_media_capabilities` with `capability: "3d-generation"` and verify that it supports the complete set. Call `generate_3d_from_views` to open the turnaround review card, or `generate_canvas_media` for a saved node with `options.referenceMode` set to `turnaround`. The original art accompanies the review for comparison. Approval releases only the ordered modeling views shown on that card.

Wait for the user’s decision. If they request changes, obtain any missing feedback, revise the affected angles and present the complete set for a new review. If they cancel or leave the review unanswered, stop before submission. A study with fewer views requires a separate, explicit request.

Keep the task receipt, project `sourceAssetId` and original file, including the quad FBX when requested. Recover a previously submitted Tripo task before considering new generation. Begin Blender work on that original with `brief.route: "tripo"`. The bundled `inspect` stage captures its starting shape, texture and pivots. Compare this baseline with the approved art before changing geometry. Refine the retained scene; keep the source association through revisions.
