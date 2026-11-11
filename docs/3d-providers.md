# 3D provider workflows

In the local edition, connect KunpoAPI for Tripo or configure a supported custom
endpoint. The main Agent can use `list_media_capabilities` to check which
operations the project can actually run. The Models page lets users clear
saved keys for retired standalone connections. See [local provider setup](kunpo-local.md).

Meshy is disabled: generation, processing, rigging/animation, library and balance
queries, polling, remote recovery and artifact downloads are unavailable. This
also covers recognizable Meshy IDs, protocols and endpoints in old custom
connections; credentials and old presets cannot enable them. Existing local
assets, nodes, jobs and receipts remain, without automatic deletion, remapping
or regeneration. Kunpo Tripo remains available through its configured connection.
New projects keep the existing Kunpo Tripo defaults; old Meshy choices, including
legacy animation nodes without an explicit model, are not reinterpreted as Tripo.
An opaque third-party relay's undisclosed downstream cannot be inferred from its
name alone.

Local reading/preparation of an existing asset follows its usual project and
format checks. Local output delivery is also allowed when a persisted
ToolRun/runId already identifies that output and the original tool/context and
existing authorization/integrity checks match. A raw Meshy task ID, receipt or
stage cache alone does not grant remote recovery or a new submission. Missing
local output is not promised recoverable. This policy does not send cancellation
requests to already submitted provider work or retry it automatically.

The table describes upstream protocol capabilities reviewed on 2026-10-23,
not the local enabled-service list. Its Meshy column is historical only.

| Operation | Meshy (disabled; historical reference) | Tripo V3 | Hyper3D Rodin |
| --- | --- | --- | --- |
| Image / multiview generation | Yes | Yes | Yes, unordered references |
| Text generation | Preview geometry, then optional refine | Text-to-model | Rodin with prompt and no images |
| Retexture an external GLB | Text **or** one style image | Text **or** one image | One model **and** one image; optional prompt |
| Remesh / reduce faces | Triangle remesh | v3.0 decimate, triangle mesh, texture baking | No documented equivalent |
| Rig and preset animations | Textured humanoid, facing +Z, ≤300k triangles | Rig-check, rig, then retarget | No documented full rig/animation API |
| Action library | Live numeric IDs and previews | Bundled identifiers scoped to rig version/type | — |
| Own-key balance | Balance | Available and frozen credits | Remaining credits |

## Canvas and agent tools

The **Model 3D** node has Image to 3D, Text to 3D, Retexture, and Remesh modes. Text
and retexture prompts can connect to Text or Document nodes. Processing modes take
a source GLB connection. Retexture also accepts a style image; Hyper3D always needs
one. The source asset is preserved, and each result becomes a new Library asset.

**Animate 3D** has an explicit connection selector. Historical Meshy nodes retain
their numeric action IDs and order but cannot generate, load the move picker or
remotely recover. Change to a supported Kunpo Tripo connection deliberately;
changing connection, Tripo rig version or rig type clears incompatible moves.
Agents can call the read-only `list_animation_actions` with the same connection,
`rigModel` and `rigType` to inspect exact action names and IDs before animating.
The bundled Tripo creature catalogs can be much smaller than the humanoid list;
for example, v2.5 quadrupeds currently expose only `Walk`. Do not invent idle,
run or attack clips for a rig that does not list them. Names match without case
or surrounding whitespace; ambiguous and unavailable names are rejected rather
than selected approximately. These pure local failures, including unsupported
local rig-version/type pairs, retain a host-owned
`invalid_animation_action` receipt before source adoption, Canvas node/job
creation or provider submission. Correct names with a new call ID; the original
ID retains its failure. An empty integrated catalog does not authorize new clips.

A provider rig-check is a separate submitted stage. Its diagnostics distinguish
a source reported not riggable, an unconfirmed riggable result and a different
reported rig type. None is branded as a local no-effect rejection: existing
task receipts and possible charges remain protected. Recovery queries the
original recorded check without resubmitting it; changing a source or settings
requires review and the existing replacement authorization. Local catalog reads
do not prove a mesh is riggable. Historical unknown calls are not reclassified
from their error text, and continuation still cannot introduce an unrelated new
paid request.

Tripo v1 provides the documented humanoid
preset library; v2.5 and v3.0 provide biped and supported creature preset subsets.
Rig v3.0 (`v3.0-20260909`) is recommended for humanoids and reuses the v2.5
action identifiers; other supported rig types retain v2.5 quality and speed.
New Kunpo rig choices use the existing `v3.0-20260909` role default. Saved explicit
older choices remain unchanged. Avian rigging has no documented retarget preset
in the current catalog and is not exposed.

Generation model IDs identify geometry versions. Texture and rig selectors identify
their own operation versions: new Kunpo Tripo defaults use texture
`v3.5-20260815`, rig `v3.0-20260909`, and decimation `v3.0`. These defaults do not
rewrite old saved choices.
Tripo v3.0 triangle remeshing accepts 500–20,000 faces; the app defaults to
4,000 faces. Retained Meshy version metadata does not make its models available.
Fresh Agent image-to-3D requests default to `turnaround`. Save
`options.referenceMode: "turnaround"` on a Canvas node for production modeling
from existing concept art. An explicitly requested study using fewer views can
use `options.referenceMode: "provided-views"`. The Agent prepares and checks
separate front, left profile and back views of the same complete subject. A
right profile is optional. This also applies to props, creatures and buildings.
The original artwork can fill a slot when it matches the required view. To
generate a missing view directly, the Agent uses `generate_reference_image`
with the original artwork in `imagePaths`. A localized edit uses
`generate_image` with a real PNG mask. Interrupted calls use `recover_media`
with the original tool name and call ID. The
main Agent checks the actual angles and pose visually. If the selected main
Agent only accepts text, switch to a vision-capable model and inspect the
views before submitting. Before a new formal submission, OhMyGame checks
that the chosen 3D model accepts the views and that
each image decodes and has distinct pixels. Recovery uses the retained job.

For a direct production model, call `generate_3d_from_views` with
`imagePaths` ordered front, left, back and optionally right. Pass the selected
geometry model, face count, texture and supported generation options as needed.
Keep the design brief for checking the views and the finished model. The
image-based provider request has no text prompt or source mesh. On the older
`generate_3d_asset` entry, unused blank paths alongside actual image references
are treated as omitted. A real source mesh or conflicting single-image path
still needs a decision. When a text prompt is present, resolve any requirements
the pictures and settings do not convey before starting a new job.

Tripo's Fast texture quality requires texture v3.5. Rodin's historical pose
control is `TAPose`; this does not enable an unavailable connection. For an image-based rig-ready Tripo humanoid, add
`options.pose` of `t-pose` or `a-pose` as local view-preparation guidance. Tripo receives the inspected views
in front, left, back, optional right order.
Other unsupported option combinations fail before paid submissions.

`list_media_capabilities` reports `optionFieldsByOperation` for each 3D model or
processing connection. The shared tool schema lists options for several providers
and operations; it does not make every field valid for the selected operation.
For example, Tripo text-to-3D accepts geometry/texture settings but not
`options.pose`; describe the desired pose in its prompt. Image-only
`referenceMode` and Tripo pose guidance are consumed locally before dispatch.

Fresh calls validate the resolved options before retaining source assets, creating
an Agent Canvas node/job or opening a provider task journal. A known pure local
rejection carries the host-owned `invalid_media_options` receipt, identifies
unsupported fields and permits correction with a new call ID. The original ID
retains its failure. No options are silently removed to start another generation.
Recovery skips this fresh-input classification and keeps the original task/input
binding. Provider errors, policy/lookup errors and historical unknown calls do not
gain a no-effect receipt from their status code or error text; submitted stages,
outputs and possible charges remain protected.

![Bundled 3D model selector and Tripo v3 rig option (sample data)](assets/3d-model-catalog.png)

The existing `image-to-3d` agent tool accepts an `operation`, optional `prompt`,
`imagePath`/`imagePaths`, and processing `sourcePath`. Its identifier stays unchanged
for existing tool permissions. The `animate-3d` agent tool accepts the connection and
Tripo rig settings and resolves action names through that connection's library.

Supported processing and animation connections can remain available when their
generation models are hidden. Meshy is excluded regardless of model visibility.
Each enabled native provider appears once in these selectors, using the stable
`connection` ID; older geometry-version references still resolve to that connection.
Generation selectors keep their geometry versions. Moves load when the picker opens.
An open move picker reloads only when its connection or rig settings change, or a
failed load is retried; catalog updates preserve its loaded moves and previews.
Local operation connections refresh on configuration changes. While a cloud 3D
provider is signed in, the visible canvas refreshes its generation catalog every
30 seconds for cloud availability and allowance, and when the page becomes visible
again. Background polling does not refresh local operation connections or moves.
Tripo's documented presets use a searchable name list with ordered selection;
supported animation requests accept at most five different actions. Historical
Meshy preview metadata does not open a remote move picker.
Own-key balances live in provider settings, using one balance per compatible
protocol/base URL for custom connections. Hyper3D's free daily quota and per-generation
cost remain in the canvas because they affect the selected model's availability.
A custom 3D model stays generation-only until **Compatible 3D operations**
explicitly enables additional endpoints. Compatible calls honor the model's base
URL override, auth mode and runtime headers. Meshy-compatible configuration is
blocked rather than treated as a supported custom operation. Capability opt-in
for another supported service does not establish that its relay implements an endpoint.

## Recovering paid tasks

Remote recovery in this section applies only to enabled supported providers,
including Kunpo Tripo. Meshy recovery stops at the local-output boundary above;
it does not poll or download recorded tasks.

Canvas history and standalone tool history save resolved inputs. Each logical 3D
job also has a private task journal under `tools/model3d-tasks/`. Jobs sharing a
recovery ID reuse confirmed stages, including when a duplicated project retries
while the original is running. The daemon serializes submissions to each journal
and reads its latest saved stages; polling and downloads can run independently.
Before submission, it records a stage fingerprint; after the response, it records
task credentials.
Fingerprints cover the endpoint, authentication/headers and effective request body.
API keys are hashed into fingerprints and never saved in the journal. Hyper3D's
subscription credential stays in the private journal; it is not included in public
jobs or assets. Journal and standalone history files use owner-only permissions.
Canvas history stays in the project's existing `canvas/jobs.json`.

Saved Meshy rig/stage records remain historical evidence; they cannot trigger
rig reuse, availability queries or another animation task. Supported custom
connections reuse their adapter only while their effective configuration is unchanged.

**Retry** only queries/downloads known upload, generation, refine, rig-check, rig and
animation stages, including after a failed artifact download. It never creates a
missing upload or a later paid stage. Missing/empty/unsafe journals, unrecorded
stages and changed request fingerprints fail closed. Even a copied project must
wait for the original job to record its remaining stages before they can be
recovered. Standalone and canvas retry persist this recovery-only intent across
restart; reopening an existing journal also restricts direct agent-call replay.
Initial generation may still execute its complete selected workflow.

For `generate_3d_from_views`, `generate_3d_asset` and `animate_3d_asset`, use `recover_media` with the
original tool name and `recoverCallId` from the same conversation to reuse the saved
model or poll the recorded provider stages. A rig-check or rig can be
recoverable while its retarget stage has never started. Recovery stops there
and reports the missing stage. If saving the completed result into the project
fails, the tool retains the local output for another delivery attempt. Delivering
an already saved model or animation works after its input views or source GLB
have moved, or the original provider has been disconnected. Polling an upstream
task still requires its original inputs and connection.

Retry does not resubmit a known failed provider task. Starting Generate again is
an explicit new logical job and can charge for the workflow again; it is not a
way to download an old result. Continuing only an unsubmitted later stage needs
a separate explicit paid-action flow, which is not provided here. If a submission
response was lost before its task ID could be recorded, retry reports the ambiguity
and refuses another paid POST; inspect the provider dashboard before starting again.
Changing a connection or effective input blocks recovery until the original settings
are restored. Expired/deleted upstream artifacts cannot be recovered from the API;
locally saved successful assets remain available.

Cancellation stops local waiting. It does not promise provider cancellation or a
refund. Restarted interrupted jobs remain in history for explicit retry. Provider
operations allow up to 60 minutes overall, with bounded individual API requests.
The local edition has retired author Cloud services; its adapter also rejects
recovery when it cannot honor the saved-stage contract.

## Model checks and interoperability

New results are parsed as GLB and must contain triangle geometry. Library and canvas
metadata records triangle counts, textures, skins, animation names, origin operation,
connection and known forward axis. Tripo performs its own asynchronous riggability check
before rigging through the enabled connection.

Tripo-generated geometry uses its documented +X forward axis. Local inspection
or facing adjustment of a retained asset does not authorize Meshy rigging or
change the original asset. Models imported without known axis metadata still need a suitable
orientation; geometry inspection cannot infer a character's semantic front or
whether it is humanoid. Unsupported compressed GLBs report a decode error rather
than silently passing geometry checks.

## Documented capabilities still outside this implementation

| Provider | Further documented APIs / options |
| --- | --- |
| Meshy (disabled; historical reference only) | Text to Motion; standalone rig/export; format conversion; resize; UV unwrap; task management and usage history; additional generation controls including geometry/texture resolution, seeds, texture guidance, automatic size and thumbnails |
| Tripo | Image generation and multiview-image/edit APIs; import/convert; Smart UV and preview; segmentation/completion; standalone rig/export; task listing/cancellation and usage history; seeds, geometry quality, automatic size, low-poly/parts generation and compression; large-file presigned uploads |
| Hyper3D | Bang and Rodin Agentic beta; usage history; texture resolution/mode, seed, lighting removal, reference strength/detail controls; bounding-box/size and further tier-specific controls |

Retexture and preset rig/animation are covered only for enabled supported connections;
Meshy's historical API list is not an invitation to configure or call it. Standalone
conversion, UV work, segmentation/completion, text-to-motion, Agentic and alternative
file formats need their own input/output contracts and capability declarations.
Tripo's `quad: true` forces FBX output for generation and remeshing. The Library
preserves that FBX byte for byte as the primary asset. A separate, explicitly
labeled triangulated GLB supports preview and downstream model operations; GLB
does not preserve quad topology. Both files can be downloaded. The preview uses
approximate materials, so the FBX remains the editing and export source.

The local converter uses the existing locked MIT Three.js and glTF Transform
packages in one bounded worker at a time (30 seconds, 256 MiB heap). It supports
static binary FBX 7400–7700 with embedded PNG/JPEG textures, up to 64 MiB input;
external resources are never fetched. Unsupported FBX, animations, skinning,
morphs, texture transforms or conversion failures retain the original with an
unavailable preview. “Rebuild local preview” never submits a provider request.

Library metadata stores preview status and SHA-256; a paired `.preview.glb`
sidecar is copied into the project and bound by `CanvasAsset.modelPreviewPath`.
Canvas save/reopen and ZIP export/import preserve the pair. Downloaded generation
results are retained in the private task journal before conversion. Recovery
reuses the exact recorded task and, once cached, works offline without polling,
downloading or paid submission. Missing task IDs and mismatched fingerprints
still fail closed. Non-quad output must remain valid GLB; OBJ or segmented
outputs are never mislabeled as GLB.

The preview's normal download icon always downloads the actual original asset
(GLB or FBX), independent of current generation options. Normal FBX previews have
no extra footer actions. A failed preview exposes local rebuilding; this has no
generation/provider connection.

The main Agent's `get_model_asset` lists only project-bound models and resolves
their original, preview and game `runtimePath`; `rebuildPreview` repairs an FBX
locally. Assets from another project must first be explicitly added. Resolve an
exact `assetId` or `originalPath` listed by a call without a reference. A
game's `public/` runtime copy may not be a registered original. Supplying both
selectors or an unbound reference is a host-owned `invalid_model_reference`
preflight failure before model reading, adoption or materialization. List this
project's bindings and correct the reference using a new call ID; the rejected
ID retains its failure. An unbound lookup still returns HTTP 403 and never
discloses or reads another project's model, rebinds a runtime copy or authorizes
generation. Other filesystem, integrity, preparation and authorization errors
are not classified by matching their message or HTTP status. Game imports
keep editor sources under `.data/model-assets/`, which travels in project ZIPs
but stays outside isolated source transfer. Standard glTF plus local buffer files
under `assets/models/` supplies the runtime. Interleaved attributes are separated
without changing geometry or materials. The 2 MiB per-file, 8 MiB aggregate,
entry, link, credential and network restrictions remain unchanged for ordinary
source resources. Builds must preserve the relative glTF resource paths. Local
preparation never regenerates a model or silently reduces its quality.
If a validated GLB cannot be split within these source budgets (for example,
one embedded PBR texture exceeds 2 MiB), local preparation uses the existing
runtime-media channel instead. `runtimeMode: "media"` returns a lossless GLB at
`assets/files/models/<sha256>.glb`, with the existing 32 MiB per-file media limit.
`runtimeMode: "split"` keeps the standard glTF resource bundle. `ready` describes
the returned runtime resources, not generation status; retained originals remain
available when preparation fails. All resources stay integrity-checked and scoped
to the project. Old guests without runtime-media support still require their
reviewed component update, not relaxed source limits.

Model inspection also returns `model.animationClips` with names, durations in
seconds and channel counts. These are structural facts, not assertions about
looping, root motion or visible playback. Existing clip-name metadata is retained.

The Agent's animated GLB results above 2 MiB use this same retained-original
workflow, preserving skins, clip names and animation targets in the runtime resources.
When local preparation cannot produce runnable resources, the tool reports that
state and keeps the animation original without placing it in isolated source.
An unsupported animation format is retained and refused rather than relabeled GLB.

The project Assets view includes registered editor model originals, including
large GLB and FBX sources retained under `.data/model-assets/`. Its normal
download action saves the original; previews use the paired GLB. Failed FBX
previews offer project-scoped local recovery. The code tree and isolated source
transfer continue to exclude `.data`; loose runtime textures remain images.

## References

- [Meshy OpenAPI](https://docs.meshy.ai/openapi.json), [text generation](https://docs.meshy.ai/api/text-to-3d), [task lifecycle](https://docs.meshy.ai/api/task-lifecycle)
- [Tripo documentation](https://developers.tripo3d.ai/en/docs/models-and-versions), [rigging](https://developers.tripo3d.ai/en/docs/animations-rig), [retargeting](https://developers.tripo3d.ai/en/docs/animations-retarget), [retopology](https://developers.tripo3d.ai/en/docs/mesh-decimate), [retexture](https://developers.tripo3d.ai/en/docs/models-texture)
- [Rodin generation](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5), [retexture](https://docs.hyper3d.ai/en/api-specification/generate-texture), [balance](https://docs.hyper3d.ai/en/api-specification/check-balance)

Validation uses real GLB fixtures and mocked API contracts. It does not establish
live account entitlement or spend provider credits; live acceptance of selected
versions depends on the provider account and compatible server implementation.
