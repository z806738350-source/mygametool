# Publish and deliver

Call `prepare_character_views` with `action:"publish"`, the same `setId`, the latest `expectedAuthoringSha256`, and a `publish` object. Supply the current `designRevision`, `expectedActiveSha256`, common `canvas`, `pivot`, `headToGround` and selected `views`. Use `expectedActiveSha256:null` for the first release. For an existing set use the current manifest's file SHA-256.

| Purpose | Selection and result |
| --- | --- |
| `release` | All eight reviewed directions. Creates or updates the active manifest. |
| `revision` | One changed direction with a new view revision. Keep the active design, canvas, pivot and head height. The host carries forward the other seven paths and digests. |
| `sample` | A requested partial deliverable. Produces a separate sample manifest. |

For each view pass its `direction`, prepared `viewRevision`, `source`, `sourceHeadY`, `sourceGroundPoint`, `scale`, `sampling` and a short `visualReview` describing what you saw. For a managed output use its returned `{kind:"canvas",reference:assetId,expectedSha256:sha256}`. For a source registered directly, use its `accepted.assetId` and `accepted.sha256` from the plan receipt. The publisher prepares the PNGs from these sources. Keep originals, including unused candidates, available for revision.

Use the returned `manifestPath` and `manifest.views` to locate the delivered PNGs. For an asset-only request, show the set and provide its files. When integrating into a game, resolve each `views[direction].file` against the manifest URL under the startup directory's public assets. Use the manifest's shared canvas and pivot in the existing renderer. Convert to fractional origin only if the renderer requires it.

For a requested playable result in a blank project, create a minimal startup page that loads this same manifest and draws the PNGs on Canvas 2D. Implement eight-direction switching and normalized keyboard movement, keeping the last facing on release. In an existing game, exercise the existing controls. With the page running, use `game_use` to cycle all eight views at a fixed point, move diagonally, stop, and inspect the scale and ground contact. After a revision, reopen the preview and check the new version between its neighbors.

If the user asked for an export, verify the exported static game loads the same manifest and eight PNGs over HTTP. If publication reports a geometry or capacity problem, use its measurements or limits to adjust the derivative geometry and retry locally. The saved candidates remain usable.
