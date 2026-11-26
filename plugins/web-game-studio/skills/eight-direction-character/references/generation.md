# Prepare a batch and generate it

Use the source already in the project or conversation. For an attachment, copy the exact `attachment:batch/id` from its receipt into `{kind:"attachment",reference:…}`. For a saved project image, use `workspace` and its relative path. For a selected Canvas asset, resolve the board node's `data.assetId` through `canvas/assets.json`, inspect the file at its saved path, and plan with `{kind:"canvas",reference:assetId}`. The registered file is directly usable. The host reads and records the source digest when it is omitted from the first plan.

**First plan.** Call `list_media_capabilities` with `{"capability":"image"}`. Find the project's `effectiveModel` and its matching candidate. Use its supported reference count, resolution, aspect ratio, PNG and transparency options, and the user's model/quality settings. Discover the full `prepare_character_views` schema with `tool_search` when available.

The following is a first plan for a character whose inspected project file already qualifies as S. Replace the example design, display height and file with the actual ones. Use a stable lowercase `setId`.

```json
{
  "action": "plan", "setId": "courier", "expectedAuthoringSha256": null,
  "plan": {
    "designRevision": "d1", "delivery": "complete-set",
    "original": {"kind":"workspace","reference":"art/courier-front.png"},
    "baseline": {"kind":"workspace","reference":"art/courier-front.png"},
    "identity": "Short blue coat and round cap", "camera": "Fixed slightly elevated orthographic view",
    "stance": "Standing, arms relaxed", "asymmetry": "Bag on the character's left hip",
    "displayHeadToGround": 96,
    "views": [{"direction":"S","viewRevision":"r1","source":{"kind":"workspace","reference":"art/courier-front.png"}}]
  }
}
```

A view with `source` registers an existing candidate. For a direction to generate, supply `direction`, `viewRevision`, `prompt`, `references`, `model:{provider,id}`, `resolution` and `aspectRatio` in that view instead. Put the first missing N in the same plan if S is ready. Use actual model/option values from the capability result. Describe the physical heading, fixed camera, neutral stance, equipment sides, transparent background and clear margins.

**When S must be generated**, set both `original` and provisional `baseline` to the original reference. Prepare only S. Once its pixels pass review, keep the same set ID and latest authoring digest. Use a new `designRevision` and pass the returned S source twice, as `baseline` and as the S view’s `source`. This carries forward the saved original, identity, camera, stance, equipment sides and display height. Only the directions you list enter the new revision. Include the missing N in this batch with S among its references.

For example, if `front` is the exact Canvas source from the S receipt and `north` is the N generation entry using it, the new plan is `{designRevision:"d2", baseline:front, views:[{direction:"S", viewRevision:"r1", source:front}, north]}`. Use the actual source objects in the tool call.

**Continue the same design.** After each committed plan, keep `result.authoringSha256` for the next `expectedAuthoringSha256`. For another batch use `plan:{designRevision,views}` with the same revision to carry forward the saved sources and design. Supply only the new or revised views. A changed prompt or references for a prepared direction require a new `viewRevision`. A prepared generation can be published directly using its retained output and its original view revision.

Call `canvas_check` with `{}` to validate the saved Canvas. Choose one direction. Call `generate_canvas_media` once with only `result.views[direction].boardId` and `nodeId`. Wait for its result, inspect the pixels, then call the next direction in a new tool-call round under the same user instruction. Apply this sequence even when the plan contains all six remaining nodes.

**Decide on this candidate before the next generation.** Open its exact `reviewRead` with `read_project_file` or the controlled `read`. `reviewColumns` names the candidate first, followed by saved comparison directions. With comparisons, the upper row is light and the lower row is dark. A standalone candidate appears on light and dark side by side. Check edges at game size, then look at the actual orientation and proportions. Increase `characterPreviewHeight` up to 384 when a detail is ambiguous. To include a different saved view, pass its project path in `characterComparePaths` (one or two paths). Read just `{path}` for the original framing and native landmarks. These reads work directly on the saved Canvas images.

For a diagonal, compare its head **and** shoulders, hips and feet with the straight view and the corresponding turn on the other side. Identify which surfaces become visible and how much of each is exposed. A sliver of the correct side can still be an under-rotation. For a rectangular head, compare the side-to-back span on NE and NW at the same height. For a round head use ears, cheeks, seams or other landmarks. Allow real anatomical or equipment asymmetry. When the second diagonal is available, recheck the first against it too. Before the next job, give a short factual verdict identifying the head and body landmarks you compared and whether to keep or revise the view. If the turn is hard to distinguish at play size, enlarge the same comparison before deciding.

If one part looks straight while the body has turned, or the corresponding turns differ visibly, keep the flawed candidate and revise that direction immediately within the user’s authorization. Save a new plan for the same design and direction with a fresh `viewRevision`. In its prompt name the observed mismatch and which parts already look right. Generate the replacement, inspect it beside the same comparison views, and use the accepted source for later directions. No new user message is needed when this correction was authorized. Recover an unresolved submission by its original job first.

**After an interruption**, read the existing authoring file and job receipts. For a submitted managed node, use `recover_canvas_media` with its original `boardId`, `nodeId`, and `recoverJobId`. Reuse a recovered success. If the host cannot resolve a submitted request, report that direction as unknown. Distinguish it from completed work and directions confirmed unsubmitted. During automatic continuation, recover existing jobs and finish available local work. If a new paid direction is blocked, tell the user which directions remain and resume them on their next instruction in this project.
