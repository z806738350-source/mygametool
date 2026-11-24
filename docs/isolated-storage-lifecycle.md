# Isolated project storage lifecycle (protocol 2)

This is a source contract, not a running VM migration. Protocol 1 guests are
refused; existing volumes are never silently adopted, reformatted or removed.

## Deletion and recovery

Deleting a project closes its admission gate before draining work. Agent turns,
session initialization, compaction, contextual generation, preview and execution
cannot start after that gate closes. Active generation cleanup, unfinished
checkpoint recovery and retained guest changes cause a refusal. Pending source
and artifact returns must settle before host deletion.

Guest retirement rechecks namespace, generation, ownership, operation leases,
mounts and processes. Only confirmed retirement permits host deletion. A private,
durable host journal records both stages. Uncertain replies preserve the host
project and keep admission closed. Explicit retries inspect actual state;
unknown metadata is never treated as an absent volume or successful cleanup.

The managed local desktop launcher compacts Chromium's local storage after
the window exits when a project was deleted. It copies the live entries into
a replacement database, excluding only the deleted project's editor keys and
preserving settings and other origins. An interrupted cleanup is retried before
the next launch. This step runs after Chromium has closed the profile.

An explicit confirmed deletion may start the existing local VM through the same
owned lifecycle used by execution. It never creates a replacement VM or allocates
a project volume or identity merely to delete. A running VM is borrowed; one
started by this application retains its ownership receipt and is stopped on normal
application exit. Viewing and refreshing storage status still never start a VM.
The confirmation mentions this possibility, and project cards show a waiting state
while preventing repeated clicks.

Preparation must obtain a current inventory before writing `retiring-volume`.
Stopped, unreachable, cached, malformed or unknown inventory is not proof of an
absent volume. Only after preparation and the durable stage write may one
retirement request be sent; an existing volume is bound to its freshly inspected
generation. After each preparatory wait, shutdown and deletion-epoch guards prevent a late retirement from an
obsolete attempt. Only the guest's confirmed retirement permits host deletion.

If VM startup or inventory fails before any retirement request, a new deletion
returns to `aborted` and project admission reopens. Existing pending records keep
their phase; starting the application never resumes deletion automatically. Once
a retirement request has been sent, even a typed refusal is not permission to
erase that pending state: guest reconciliation may already have changed storage.
Lost replies and partial deletion require fresh inspection on an explicit retry;
they never cause an automatic second request. Dirty or active volumes remain
protected, and a partial deletion cannot guess away a remaining image.

Host removal is recursive and irreversible once `deleting-host` begins. Its
journal prevents automatic continuation, but it does not restore already removed
files after a partial filesystem failure or power loss. Missing or damaged host
metadata requires separate inspection rather than a claim that deletion or
recovery completed. The guest volume must have been confirmed retired before
this host phase can begin.

Explicit project deletion also waits for native Agent disposal, removes that
project's private Blender jobs and image-recovery originals, and drops its
conversation image and request-preview caches. Session files and checkpoints
are removed with project storage. Project-owned generation receipts/results and
native Codex/Qoder histories are removed as well, including attributable content
logs; shared results owned by another project are preserved. Cleanup errors leave
deletion pending and may be retried explicitly; normal cancellation or an uncertain tool result never
triggers this disposal. Completed deletion journals are removed, including
completed journals left by earlier app versions. Unsaved Library copies with
an explicit project source are removed unless another project owns or uses them;
shared copies retain that other project's association for its eventual deletion.
Unreadable project references block this cleanup. Explicitly saved Library assets,
independent uploads, unattributed assets and account settings remain intact.
Canvas and Playable uploads and project chat attachment references are unsaved
project copies; uploading directly to the Library still creates an independent
saved asset.

Legacy image recovery directories block deletion before guest retirement or
conversation cleanup. Removing an external workspace registration cleans its
ordinary chat-attachment directory only when the directory belongs to that workspace.
If the registered external folder is confirmed missing, startup and deletion can
still inspect its application-owned recovery data without recreating the folder.
Unconfirmed publications and source reservations whose device identity can no
longer be verified continue to block deletion; permission errors and replacement
links are not treated as missing folders.

Quick-start canvas initialization failures retain the new host project for user
inspection instead of invoking an unconfirmed automatic deletion. No settings
query or failed quick start acquires VM ownership as a cleanup side effect.

All four renderer deletion entry points inspect this project's canvas, document,
table, Playable and composer drafts; the DELETE client checks again immediately
before sending. After confirmed deletion, the browser removes that project's
drafts and saved canvas, document, table and playtest state. A project missing
from a listing is not evidence of deletion: loading damaged metadata can fail,
so listing never discards browser recovery drafts. This does not atomically lock
another window's unpersisted memory: browser protection covers mounted editor
readers and persisted drafts.

Every writable guest operation is dirty before writing. Capture alone does not
mark source saved: the host checks its unchanged baseline, publishes through the
workspace write guard, and acknowledges the exact operation, generation, token
and captured snapshot. Failure, cancellation, conflict and lost replies retain
unacknowledged changes and block a replacement prepare. Interrupted source sync
has a separate durable transaction; cancelling cannot mark it clean.

Source sync updates registered source paths with rollback material and exact
content checks. Dependencies, generated trees, caches and excluded outputs are
preserved. Ordinary source return remains bounded to 8 MiB / 2,000 files / 2 MiB
per file. Deletions, links, private paths, sensitive values and oversize results
remain refused. Such retained state needs separate inspection; it is not silently
discarded. Host originals use the existing bounded `isolated-changes/` policy.

A guest advertising `runtimeMediaVersion: 1` can prepare runtime media in the
same source transaction. It requests missing content, validates the received
bytes and keeps previously verified files when only code changes. A failed
upload does not publish a partial asset. The prepared manifest also allows the
host to restore byte-identical media from a build without sending the file
back through the ordinary source-return channel. Guests advertising
`buildMediaVersion: 1` can also stream build-generated media. The host checks
the filenames, sizes, content type, content digests, sensitive values and
successful end of stream before replacing the build directories. A failed
export discards the staged results. See [preview media and
size limits](preview-runtime.md) for supported locations and budgets.

Source capture can also return byte-identical copies of prepared runtime media
at eligible new media paths, or replace an existing media path with another
verified prepared asset. The host verifies the original bytes and destination
format, then publishes the copy through the same guarded source transaction.
The inspected original is saved independently of the moved inode: an external
program retaining an open handle can edit the moved file without destroying the
saved baseline. Both copies count against the existing recovery storage limit.
Unsupported changes to registered media and new large media without a verified original are retained for review. Recovery
compares each guest change with its baseline and the current host: independent
host edits stay intact, already-saved copies need no rewrite, and conflicting
edits to the same path still stop recovery without acknowledgement.

### Complete source manifests and change accounting

New compatible operations can explicitly negotiate `sourceManifestVersion: 1`
and bind `captureVersion: 3` to `sourceBaseManifestId`. Capture 3 adds a source
semantic contract while keeping capture-2 binary framing; it does not upgrade an
existing version-0/1/2 generation. The complete manifest records each eligible
path's `kind` (`source` or `media`), decoded size, SHA-256 and executable bit,
with profile `current-64` and `permissionSemantics: "executable-only"`. The host
and guest independently validate the full set and recompute its canonical
manifest ID. This does not copy ACLs or grant media-copy, raster or publication
authority from metadata.

A negotiated snapshot carries `sourceBaselineManifest`, `sourceManifest`,
`sourceDelta` and `sourceResultManifestId` together with
`sourceManifestVersion: 1`. The host checks them against the original binding,
legacy baseline and actual returned entries; missing, inconsistent or
unnegotiated metadata is refused. Review reports `sourceRawDelta` and, after
working preparation, `sourcePreparedDelta`. These are decoded content-byte
summaries derived from complete manifests, not transfer-wire sizes. Prepared
image bytes may differ from the immutable raw snapshot and remain bound to the
same full review and publication checks.

The legacy snapshot ID remains required: it does not bind kind or decoded size,
so it cannot replace the typed manifest ID. A V1 review binds base, raw and, only
when verified, prepared identities. Publication v4 separately records complete
host-before and merged-host-after manifests and recomputes their actual delta;
it never substitutes the guest's claimed delta for host backup/staging costs.
ACK binds the original base and raw result before checking an idempotent receipt.
After a lost ACK, fresh review can have a zero delta against its updated baseline;
verification still requires the original recovery operation's base/result tuple.
Old capture, journal and reservation readers cannot silently adopt these new
versions, and old dirty generations are not rewritten.

The current quotas are unchanged: ordinary source is at most 2 MiB/file and
8 MiB total; runtime media is at most 32 MiB/file and 64 MiB across the eligible
project path set; both share 2,000 files. Distinct paths with the same content
digest each count. The guest image remains 256 MiB and the versioned host recovery
envelope remains 512 MiB. Complete manifests describe this existing profile;
they do not enable a larger profile or migrate a user's volume.

Capacity and transfer accounting must keep these quantities separate:

| Quantity | Meaning |
| --- | --- |
| Accumulated project content | All eligible source/media paths in the complete current set, including unchanged files. It is not a per-package or per-chunk allowance. |
| First seed | Full decoded ordinary-source bytes plus declared media bytes; actual media payload depends on the guest's validated wanted-path request. |
| Changed before/after content | Separate whole-file sizes for added, modified and removed paths, including kind or executable-bit changes. A one-byte edit in a 32 MiB media file counts 32 MiB on each side, not one byte. |
| Requested and copied media | The validated wanted paths and bytes actually read and sent for those paths. Metadata or a planned delta alone does not establish this measurement. |
| Control header | Exact serialized UTF-8 JSON bytes, including the protocol's delimiter when present. Base64 ordinary source and complete metadata contribute independently of media payload. |

Preparation still sends ordinary source in full inline base64 under the existing
8 MiB decoded limit, even when only one source file changes. Media payload uses
the existing wanted-path transfer. `projectFiles` still reads/hashes the eligible
media set to establish current identity; avoiding a media upload does not avoid
that host scan. There is no binary patch transfer or all-bytes source delta.
Metadata-only capacity observations cannot infer actual requested or copied bytes.

### Verified raster derivatives and interrupted host publication

`rasterReturnVersion: 1` is negotiated separately and bound to each new prepared
generation. Missing or version-0 records retain their original strict policy,
including dirty generations created before an upgrade. Upgrading does not adopt,
return or discard those pending changes. All main Agents use this shared layer;
the capability does not enable host shell execution, external MCP or plugins.

A registered static PNG/JPEG/WebP may propose changed bytes with its original
baseline digest. The proposal is not approval: the host requires an unchanged
baseline and safe non-executable path, enforces a 512 KiB working-image limit,
matches the signature and extension, fully decodes both images under bounded
pixel/channel/time limits, rejects animation and high bit depth, and refuses
removing an alpha channel or making transparent pixels entirely opaque. New static rasters on this channel receive the same
output validation. PNG chunk CRCs and the complete end marker are checked too.
This proves format integrity, not that artwork or gameplay is visually correct.
Other registered-media edits still require review. Existing byte-identical
prepared media copies and source/media budgets remain supported as before.

Before live files move, a legacy version-2 host journal durably saves independent
original and returned bytes, hashes, sizes, modes, validation receipts, and the
namespace/project/generation/captured-snapshot binding. Those copies and the
staging/moved inodes count against the existing 32 MiB recovery budget. File and
directory sync barriers record staging, moving, linking and published phases.
Publication uses no-replace links, verifies the final batch, and acknowledges
the guest only after the committed host receipt is durable. Ordinary failures
roll back only owned files; concurrent saves are preserved and unresolved
results retain the journal. Originals are never automatically garbage-collected.

After an abrupt process exit, a pending journal blocks new execution, Agent
tools, generation and project mutation/deletion. Read-only inspection remains
available. An explicit recovery captures the guest again and reconciles only
the exact bound transaction under the workspace guard. It verifies every retained
version before continuing, recognizes its own interrupted staging links, and
refuses changed permissions, unknown links, missing/corrupt originals, different
generations/snapshots, later edits/deletions or an uncertain publication outcome.
A lost ACK can use the matching committed receipt without replacing the image
again. Repeated receipt handling does not rerun the command or generate media.
Startup never automatically writes pending changes back.

### Controlled review and adoption of a legacy batch

Legacy generations remain version 0 until resolved; installing this capability
does not approve, rewrite, or acknowledge any retained user batch. The shared
`recover_isolated_changes` tool adds `review` and `adopt`. After inspection,
`review` reads the complete candidate snapshot and builds a file list with
paths, additions/replacements, sizes, before/after hashes and source previews.
Static image candidates receive the same complete raster validation. Prepared
byte-identical media copies retain their existing validation. Unknown formats,
binary source, executable changes, deletions, invalid JSON, sensitive data,
conflicts and incomplete source previews block adoption. The complete source
preview budget is 64 KiB; truncated code is never silently approved.
Canvas registrations and generated schemas use their controlled Canvas workflow;
legacy edits to them are blocked. Board JSON must still match its schema and ID.

After `review` saves a host snapshot, the Agent can inspect a listed static
PNG/JPEG/WebP image before requesting adoption. Use `recover_isolated_changes`
with exactly `action: "read_image"`, `reviewId`, `path`, `variant` (`raw` or
`working`) and that variant's `sha256`. The current model must have verified
image input. The host reads only the exact saved review/artifact identity, not
an arbitrary private path or a newly opened guest volume. The result includes
actual image content and metadata with `freshGuest: false` and
`adoptionApproved: false`; it is the saved snapshot, not proof of current guest
state, approval or a model's visual understanding. A changed identity, protected
content or unverified image capability refuses the read.

Source images remain bounded by 32 MiB and 32 MP. Small images may retain their
original bytes; larger model inputs use a labelled display proxy no larger than
1 MiB or a 1536-pixel edge, without enlargement. An alpha-bearing proxy remains
PNG. Source and display SHA-256, sizes, dimensions and `isProxy` identify the
difference. This display-only conversion never replaces the retained original,
working image or runtime asset, and is not full-resolution visual acceptance.
Retained-image reads share one read slot, with at most four active/pending reads;
waiting reads can be cancelled before loading source bytes. Reading does not
rewrite a review receipt, recover or publish files, acknowledge the guest,
release reservations or clear an unknown operation. The complete batch still
requires the original approval and fresh publication checks described below.

The guest `review-source` operation takes a nonblocking exclusive inspection lock
and never changes the registry, prepares a task or acknowledges files. It can
inspect resident or sleeping legacy volumes after a VM restart without activating
them, evicting another volume or allocating a copy. A dormant volume receives a
temporary read-only ext4 mount with journal replay disabled; a read-only filesystem
check must succeed first. An unclean filesystem is retained for separate repair,
never silently repaired or journal-replayed. Mount device, backing image and
read-only flags are verified, and the review mount is released even on failure.
An interrupted read-only mount is revalidated and released on the next explicit
review; ordinary admitted recovery can also replace it with its normal mount.
Existing idle writable mounts are inspected in place. Status/refresh remains a
shared-lock metadata query and does not mount anything. An explicit
Agent `review` may start the existing VM through its owned lifecycle; omitting
the generation selects the freshly inspected dirty generation. Ordinary status
queries and refreshes still never start it. The project card offers **Open
execution storage** as an explicit way to start the existing VM after a restart;
it runs no project command and returns no files.

`adopt` accepts only the reviewed identity, never caller-supplied approval flags.
It presents the trusted Approval card with the complete batch and escaped source
previews. The card keeps the entire file list browsable in a bounded scroll
region. Expand a file to inspect exact byte sizes, original/returned SHA-256
values and the complete escaped source preview when supplied. The compact size
beside its path is only a display summary. Image-format validation is not visual
acceptance. Risk notes remain visible, and file problems block approval.
The user must confirm all listed writes and separately confirm any
code, scripts, JSON/configuration or Agent instructions. The authenticated answer
endpoint validates both confirmations against that pending request. Session-wide
permission, a chat statement, old permission to repair the software, or an Agent's
claim cannot authorize this batch. The operation writes the entire approved
batch; selective adoption is not offered because acknowledging it could hide
unselected retained changes. Recovery stores source without executing it;
approval does not certify code as harmless for future builds/previews.
While an unapproved review is pending, ordinary Agent file writes, execution and
media generation are paused across the shared tools. Read-only inspection and
the recovery tool stay available. Manual user edits remain possible and require
a fresh conflict check. Approving the exact latest batch preserves older
unapproved drafts as superseded history rather than leaving a permanent write
block. Refusal or expiration never acknowledges or discards retained changes.

Private `isolated-reviews/` receipts bind namespace, project, canonical workspace,
generation, guest snapshot, host manifest and every reviewed target. They record
approval and completion durably and are limited to 64 receipts / 8 MiB per
project, with at most 2 MiB per receipt. Review alone preserves originals in place;
actual adoption uses the existing independent originals and source-publication
journal. Unapproved reviews expire after 15 minutes. Fresh inspection may
supersede stale consent before publication, while retaining its receipt and
requiring a new exact confirmation. Corrupt receipts or conflicting active
approvals fail closed.
Fresh reviews receive distinct identities, so returning to earlier file bytes
does not overwrite a superseded approval. Source/media and independent-backup
capacity are checked before requesting confirmation and checked again when
publishing. Legacy source-only and separate-media transfer profiles retain their
corresponding file-permission behavior.

Only a trusted approved receipt enables a recovery operation scoped to that
exact `reviewSnapshotId`. The guest verifies it before reservation, capture and
acknowledgement; the global legacy policy is unchanged. Host changes, including
unrelated saves after approval, are checked before any partial publication is
resumed. The host checks the final target manifest before acknowledging. A
saved approved batch does not require an already mounted workspace for its
passive preflight; the admitted recovery opens and verifies its exact snapshot.
A completed duplicate returns its receipt without interrupting later work or
replaying a command. Cancellation, failure and restart retain approval, originals
and partial publication phases; startup never resumes automatically. The project
card can explicitly resume a saved approved batch after opening storage and
refreshing status. Pending approval cards without a user answer are denied when
their turn ends; they are never converted into durable consent.
Codex contexts older than `controlled-codex-v12` and Qoder contexts older than
`controlled-qoder-v11` are rebuilt from shared conversation history on the next
user turn, because their tool/context contracts changed. This makes the new
actions and controlled project reads available without discarding the shared
conversation or sending a model request merely to upgrade the software.
Existing review receipts, approvals and generation contracts are not upgraded;
rebuilding context does not replay an earlier user turn or tool call.

The application guard serializes application writes; each file replacement is
atomic, but an external process can observe a partly published batch. A failure
after some files are visible is retained and inspected rather than advertised as
a filesystem-wide atomic commit. Process-exit regression tests exercise durable
phases on ordinary files; they do not certify physical power-loss behavior or
arbitrary filesystem corruption. Review-required states keep both versions and
must not be cleared by repeating shell, recovery, or paid generation calls.

When an Agent encounters retained changes, it can call `recover_isolated_changes`
with `action: "inspect"`, then `action: "recover"` with the reported `generation`.
The tool drains preview execution, checks unfinished checkpoint recovery, and
uses the same guarded publisher as the project card. It does not rerun the failed
command, discard guest files, or request a model. A failed or uncertain recovery
must be inspected before continuing; the same uncertain generation is not retried.
Restarting the editor preserves retained guest changes and does not clear this
state. Conflicting edits require inspection through the project card rather than
repeated shell, build, preview or recovery attempts.

For supported retained static PNG/JPEG/WebP images, the current main-Agent path
is `inspect` → `review` → `optimize` when necessary → trusted `adopt` → read current
project files. The v2 review streams raw runtime-image candidates separately from
ordinary source and verified media. It binds their original hashes to the full
host baseline and retains independent raw originals and prepared working files;
new transactions reserve those artifacts together with publication and rollback
files under the versioned host envelope below. Existing version-2 journals keep
their original 32 MiB policy. It does not turn arbitrary files into trusted media copies.
New prepared generations can negotiate `captureVersion: 2` only with compatible
raster-inspection and retained-review capabilities and raster policy 2. Their
new/modified raster candidates require complete review and approval; an otherwise
successful command does not approve them. Existing version-0/1 generations keep
their recorded rules and are not upgraded by a software update.

Omitting `maxEdge` validates and retains identical bytes, pixels and dimensions,
under the 32 MiB / 32 Mi-pixel input and working-image bounds. Lossless preparation
at the same pixels is preferred when preparation is needed. An explicit supported
size prepares a derivative only when it fits the design; it is never a mandatory
art specification or an automatic quality increase. Atlas splitting/resizing has
no automatic layout guarantee: frame rectangles, anchors, padding and transparent
edges must be checked. Unsupported formats, decoding, capacity or full-batch problems
remain visible blockers. Video, audio, 3D and animated images are not implemented
by this image preparation path.

Approval identifies the exact raw and prepared snapshots, each image's original
and working dimensions and alpha validation, and the complete file/code batch.
Its resource information separates encoded bytes and pixel count from estimated
RGBA8 decode/base-texture bytes and the complete mip chain, including its base.
The tool's decode limit is not a device budget; GPU memory, target-device support
and FPS are unmeasured. When the actual target WebGL environment is available,
controlled `game_use` and existing instrumentation can check `MAX_TEXTURE_SIZE`
against both atlas dimensions. This is a capability ceiling, not a performance
budget. Atlas choices also need batching, draw-call and frame-time measurements;
an unavailable target environment remains explicitly untested.
An already matching target is labelled as verification without rewriting files;
it still requires the same complete confirmation before acknowledging retained
guest results. No source normalization is written into the guest by approval or
ACK. The next normal prepare uses the existing source-sync transaction.

If a reply is lost after verified publication, `verify` checks only the original
review, exact recovery operation, target bytes, acknowledgement and release. It
never submits a recovery or ACK. Unknown outcomes remain blocked. Trusted
settlement records preserved effects separately from the original command's
failure. Only exact current-task mappings can enter bounded repair-only or
verification-only continuation; old unmapped histories are not reclassified.
The Agent must then reread current project files before further effects. Startup
does not resume old tasks, adopt files or process a retained generation.

### Withdraw a rejected source deletion

In **Execution storage and recovery**, choose **Withdraw deletion, keep local
files** for a supported reviewed batch. This action handles a batch with only
ordinary source deletions and a verified common baseline from a released
isolated shell command. The review uses retained review version 2 and the
generation's existing source manifest contract. The exact reviewed batch can
be eligible even when ordinary recovery is unavailable.
If a new deletion is waiting for its first review, use **Open execution
storage** in the same panel. This prepares the review before the separate
withdrawal confirmation.

The host checks the saved review and the current files. It records the intent,
then sends the verified baseline bytes for the missing files to the isolated
store. The guest restores only those paths and verifies the resulting full
manifest. The host records the withdrawal before asking the guest to confirm
it. The host project files remain untouched. Mixed changes, a changed baseline,
or a conflicting operation remain pending for review.

After an interrupted result, use **Check or finish withdrawal** to inspect or
finish the same request. The saved result is scoped to the original reviewed
operation. Other pending changes may still prevent editing. A source change is
confirmed only after a new controlled edit returns and receives its normal
source acknowledgement.

### Versioned host recovery reservations

Legacy-contract source publications use journal version 3. Negotiated manifest-v1
publications use journal version 4 and reservation-intent version 2, separately
from guest protocol 2 and review version 2. Both carry a validated space plan and
the exact durable reservation ID. The shared project recovery store admits a complete logical
envelope of 512 MiB, counting retained history together with the new plan's raw/working
artifacts, independent before/after copies, staging and journal/review metadata.
Its plan charges `raw + working + 2 × (before + after) + 3M + J + E`, where `M`
is the bounded largest manifest, `J` is review metadata and `E` is a 32 MiB entry
allowance. Reuse deducts only already retained, rehashed raw/working artifacts.
The separate disk check counts the actual staging/moved-file lifecycle and uses
at least that entry allowance or the planned entries' filesystem allocation
cost, whichever is larger. Plans version the 32,768-entry bound and are checked
again on load. Version-2 journals cannot claim the new plan or a larger budget.

Before payload allocation or submission, the daemon serializes admission and
writes a private, fsynced `isolated-space-reservations/` intent, bound to the
workspace, filesystem device and host operation; generation/raw snapshot bind
when known. Admission subtracts this daemon's other promises on the same
filesystem and retains a 1 GiB host free-space floor. Before live inodes move,
headroom and the filesystem allocation unit are checked again. These are this
daemon's durable accounting promises, not an OS disk reservation or a guarantee
against unrelated writers, another daemon, physical power loss or filesystem
corruption. Originals are not automatically removed to make room.

Post-preflight failures remain possible. Known project-volume writes distinguish
`GUEST_VOLUME_FULL` from `GUEST_QUOTA_EXCEEDED`; guest control-metadata writes use
`GUEST_STORAGE_FULL`, `GUEST_STORAGE_QUOTA_EXCEEDED` or `GUEST_STORAGE_UNKNOWN`.
An unknown sync I/O failure uses `GUEST_IO_UNKNOWN`. Failures after durable sync
submission do not claim `changed: false` or established recoverability. Host
physical headroom, unresolved promises and actual write failures retain their
separate reasons. None of these errors permits a replacement command or
automatic deletion; inspect the retained transaction first.

Reservation tokens and prepared raster artifacts have private in-process brands.
A model argument, copied object, base64 source descriptor or verified-media-copy
descriptor cannot manufacture them. Prepared rasters are published through
private artifact references, rechecking retained file identity, length, hash,
baseline and full raster validation before staging; they are not routed through
ordinary base64 source transfer or promoted to generic verified media.
An interrupted publication reuses only its original reservation and exact
namespace/project/generation/raw-snapshot context. A missing or unreadable journal
does not release that promise. Incomplete or invalid candidate streams are isolated
in private incoming staging and never become admitted immutable artifacts or ACKs;
cleanup is limited to the staging identity owned by that attempt.

Startup restores promises even when a damaged project card was skipped, using
only that project's fixed workspace/private reservation location. Unknown,
damaged or inconsistent ledger metadata keeps new allocations blocked; an empty
restore or a timeout does not clear it. The application may still become ready
for inspection. Startup never replays a command, publication, approval, ACK or
model request. Offline regression fixtures cover these refusals; they do not
certify a running VM, target-device performance or physical power-loss recovery.

Guests advertising `sourceInspectionVersion: 1` provide a generation-bound,
read-only `inspect-source` operation. It reports added, modified, deleted and
blocked paths without returning file payloads, mounting a volume, reserving a
task or acknowledging source. Enumeration and reads use the existing source
limits; incomplete results explicitly require review. Private/cache trees stay
in the guest and are counted as excluded. Active work, an unmounted volume or an
unfinished source transaction is not silently inspected as an empty workspace.
The Agent tool and project card use these diagnostics before recovery. A known
blocker or unsafe host publication disables recovery; it does not clear dirty
state. A confirmed local refusal before recovery started can be inspected and
tried again. Lost replies or failures after recovery began keep retry protection.

### Media transfer scope

The same runtime channel supports PNG, JPEG, WebP, GIF, AVIF, MP4, MOV, WebM,
M4A, MP3, WAV, Ogg and GLB. Animation clips inside GLB use the same byte identity
and local model resource handling. Eligible paths are below a `public/` or `src/`
directory, or `assets/imported/`, `assets/generated/` and `assets/files/` (including
imported folders). A filename alone is not media identity: size, exact signature,
digest, mode, safe path and unchanged-host checks still apply. The existing
32 MiB/file, 64 MiB/media set and ordinary-source limits remain in place; the
versioned host recovery envelope above does not enlarge these media contracts.

| Operation | Behavior |
| --- | --- |
| Generation or import | Retain originals; admit verified runtime files or prepared resources within the existing limits. Large animated models use the same retained model resource path as static models. |
| Copy, alias, extension case, approved replacement | Reuse matching verified bytes; recheck the destination format and preserve replaced originals. A changed path never supplies its own authority. |
| Incremental preparation | Transfer missing verified content; keep dependencies and excluded cache/output trees. Incomplete uploads never publish partial assets. |
| Cross-project reuse | Resolve the destination project's explicit Library/Canvas binding and verify its bytes; a foreign path, asset ID or digest alone grants no access. |
| Guest move/rename deleting a baseline path | Retain both locations for explicit review; the source-return channel does not silently propagate deletion. |
| Valid static PNG/JPEG/WebP derivative on a new version-1 generation | Validate the complete image and original binding, keep independent originals, and publish through the guarded durable transaction. |
| Legacy generations, new large guest media or unsupported media edits | Retain the guest version and report the blocked path; normal recovery cannot turn it into an approved copy. Do not loop or regenerate. |
| Conflicting edits, partial host publication, unknown result | Preserve guest data and host `isolated-changes/` originals for review; no automatic discard or acknowledgement. |

SVG is editable source. Raw FBX and other editor-only formats require explicit
local preparation/adoption and do not become runtime media by renaming them.
Signature checks identify the transfer format; they are not a full decoder test
for every container. A complete but corrupt media file can still need local
preview/decoder validation. These checks cover the specified cases and do not
guarantee recovery from arbitrary disk corruption, power loss or concurrent
external filesystem mutations.

An offline helper experiment on 2026-11-10 used Apple M5 Pro / arm64 Node 22.23.4,
three fresh workers per synthetic case (12 samples). Each measured the existing
metadata inventory, `projectFiles`, complete manifest construction/validation,
whole-file delta planning and exact prepare-header serialization, followed by
`readRuntimeMedia` and independent temporary-file copies for a synthetic wanted
path list. The median below covers both initial seed and update pipelines,
including their media copies; RSS is each worker's process maximum.

| Synthetic case | Accumulated media after update | Update changed before / after | Initial / update media copied | Full prepare header UTF-8 bytes, seed / update | Pipeline median | Peak RSS range |
| --- | --- | --- | --- | --- | --- | --- |
| 1,800 source files, 2 KiB each; change one byte in one file | 0 | 2 KiB / 2 KiB | 0 / 0 | 5,449,007 / 5,449,007 | 538.26 ms | 259.48–260.98 MiB |
| 16 equal-SHA 1 MiB media paths; add a seventeenth path | 17 MiB | 0 / 1 MiB | 16 MiB / 1 MiB | 10,625 / 10,905 | 56.19 ms | 177.91–181.75 MiB |
| 64 MiB media set; change only a 4 KiB source file | 64 MiB | 4 KiB / 4 KiB | 64 MiB / 0 | 6,709 / 6,709 | 133.00 ms | 232.69–232.98 MiB |
| 64 MiB media set; change one byte in a 32 MiB media file | 64 MiB | 32 MiB / 32 MiB | 64 MiB / 32 MiB | 6,709 / 6,709 | 160.12 ms | 262.83–265.14 MiB |

The many-small-file case still sends 3,686,400 decoded source bytes as 4,917,600
base64 text bytes on both prepares. Its Unicode paths make UTF-8 header bytes
different from JavaScript string length. Every other case includes a 4 KiB
source file sent in full on both prepares. Equal-SHA paths were independent files,
not hard links or a quota deduction. The media fixtures contained only synthetic
format signatures; no video decoder or game consumed them.

The copies above are actual host reads and writes to temporary ordinary files,
not metadata estimates, but the wanted requests were simulated, not received
from a guest. Files were newly created and filesystem-cache warm; copies were
not fsynced. Baseline RSS after module imports was about 151–154 MiB, and peaks
include Node/TypeScript runtime, buffers, JSON and both pipeline stages. These
are neither isolated decoder allocations nor production latency targets. No VM,
network transfer, target-device GPU, FPS or volume migration was measured.
A metadata-only 96 MiB candidate was rejected by the current profile; no larger
payload or capacity profile was enabled.

The project card's **Execution storage & recovery** action reads status without
starting the VM. Recovery requires the just-inspected generation, no active
project work, no unfinished checkpoint restore, and no pending editor changes.
It uses the guarded publisher and does not call a model. Composer drafts remain
preserved. Any uncertain POST result, including 409 after publication or ACK
failure, permits inspection but does not automatically resend the same dirty
generation. If no trustworthy state change can be established, separate
inspection is required.

## More than eight useful projects

Eight is the shared manual/test **resident** volume limit. An idle volume can be
unmounted and its complete directory durably renamed to private cold storage.
Source, dependencies, outputs and retained changes stay together. Access restores
the same volume and identity, sleeping another idle project if necessary. Active,
pinned, unknown or inconsistent volumes cannot be selected. Useful projects are
never automatically deleted.

| Boundary | Limit |
| --- | --- |
| Resident volumes | 8 |
| Each ext4 image | 256 MiB, 8,192 inodes |
| All resident and cold images, logical bytes | 4 GiB (at most 16 full images) |
| Guest filesystem reserve | 1 GiB, plus prospective image growth and staging |
| Concurrent guest operations | 2 globally |
| Stable identity range | UID 5000–5095 (96 numbers, never silently reused) |
| Durable operation history | 8,192 entries; full history needs maintenance |

Per-job CPU, memory, process, file, timeout and network limits still apply. Sparse
images' possible growth and pending transactions count toward admission. Without
an idle slot or capacity, execution refuses and preserves projects. This supports
a ninth useful project within the total budget, not unlimited storage or automatic
VM expansion. Expired leases are recoverable only after actual inactivity is
verified; a live process cannot be evicted by a timer alone.

## Execution volumes in Settings

**Settings → Execution volumes** is a read-only overview of the shared manual/test
budget. It lists project ownership, volume residency, task phase and retained
source changes separately. A resident volume can have no running task; a sleeping
volume can still retain unreturned changes. There are no permanent numbered
slots. Incomplete creation, recovery or residency transitions remain reserved
according to the same admission rule as execution. Unresolved state does not
produce a usable-slot claim.

The overview reads one validated guest snapshot under the existing storage lock.
It does not prepare, mount, sleep, restore, delete or reconcile volumes, release
leases, allocate identities, or start the VM. Missing projects and test-namespace
records remain visible rather than disappearing from the shared count. Only a
complete current snapshot can classify a local project as having no volume.

Opening, focusing or refreshing the page never starts the VM. When it is stopped
or a query fails, the page marks the last successful snapshot with its observation
time. Without a snapshot, usage is unknown, not zero. The cache belongs to the
current daemon process; after a full application restart there may be no cached
snapshot until a successful query while the VM is already running. A known quota
remainder is not a guarantee of execution admission: total image capacity, free
space, identities and concurrent operations are checked separately.

The existing `recover_isolated_changes` tool also offers `action: "capacity"`
with no generation, review ID, paths or image-size arguments. This is a read-only
host capacity diagnostic. The current report does not establish guest free space;
stopped, incomplete or unavailable guest observations remain unknown. It does not
start the VM or call `inspect`/`review`, release promises, update the selected
recovery generation, clear an uncertain outcome or authorize recovery. An absent
capacity callback reports unavailable instead of falling back to execution.
Use this diagnostic before the existing inspect/review workflow; metadata is not
evidence that image pixels were read or a retained batch was approved. Runtime
media counts cover the eligible project path set, not each transfer batch or transport chunk; duplicate
files at different paths still count. Explicitly registered Canvas candidates
retain their separate exclusion rules. Do not exclude all generated files or
delete assets merely because static reference scanning misses a dynamic URL.
Future capacity profiles remain design/simulation only: this action does not
enable a profile, change limits or quality defaults, or grant new permissions.

The candidate versioned profiles are `capacity-64-v1` (64 MiB cumulative media /
256 MiB volume), `capacity-128-v1` (128 / 512 MiB) and `capacity-256-v1`
(256 MiB / 1 GiB). They remain `runtimeEnabled: false`: design and isolated core
validation do not make the larger profiles usable by the current guest. Ordinary
source stays 2 MiB/file and 8 MiB total, media stays 32 MiB/file, a single media
transfer stays 64 MiB, and host recovery stays 512 MiB. Neither GPU/FPS support
nor free space follows from a nominal volume ceiling. The Agent must choose the
smallest profile supported by complete content, dependency, staging and capacity
evidence, and identify missing measurements as unknown.

The main Agent can compare a selected candidate through
`recover_isolated_changes` with `action: "plan_capacity"` and one of these
`profileId` values. It returns an observation-based proposal with
`authorization: "none"` and `readyForMigration: false`, never a configuration
change, pending approval or migration. Metadata from excluded Canvas content,
stopped guests, unknown volume geometry and unmeasured build peaks cannot certify
a fit. Known dirty, active or unfinished storage states block the proposal;
absence of those warnings is not a complete clean-volume proof. Planning remains
read-only during repair/verification and cannot settle the original operation.

For a new project's first allocation, `recover_isolated_changes` also offers
`action: "plan_first_allocation"` with no other arguments. It compares the
observed eligible-workspace metadata against the real legacy `current-64`
contract (64 MiB cumulative media and a 256 MiB volume), `capacity-128-v2`
and `capacity-128-media64-v3` (128 MiB cumulative media and a 512 MiB volume).
The latter two have different per-file limits: v3 permits supported video,
audio and GLB files up to 64 MiB while raster media remains at 32 MiB. Extension
classification and file sizes are metadata, not content validation. Missing or
incomplete observations remain unknown; an observed-envelope fit is not an
admission decision, a verified seed, or a promise that future assets will fit.
Unallocated storage is not proof that the project is new. Installed guest
capability, full disk and inode headroom, concurrent reservations, source
integrity and any native approval must be checked separately. Future workload,
decode memory, GPU limits and frame rate remain unmeasured. This action does not
start the VM, select or allocate a profile, issue approval, change an existing
volume or settle a pending operation. The three `capacity-*-v1` simulation
profiles above are not current runtime contracts.

The same read-only comparison remains available during repair-only and
verification-only continuation. Each new call ID observes current metadata;
repeating an identical in-flight call reuses its result. It cannot settle or
replay an uncertain recovery, submit a command, or grant allocation authority.

Candidate experiments use private temporary ordinary files, not ext images,
mounts or real projects. They measure logical bytes, allocated `st_blocks * 512`,
unique inodes, file/directory counts, dependency/cache/build trees, changed-file
staging, independent-copy migration peaks and one/two-worker RSS. Each scenario
cleans its payload before the next scenario; the combined experiment is bounded to
512 MiB allocated blocks, 12,000 files and a 2 GiB free-space floor. A 256 MiB
candidate's copy sample uses a smaller populated set so both copies and staging
fit that bound; it cannot prove a full-volume migration fits. The new shared
planner/seed/migration helpers supply budget assessments and simulation
validations, while the backend remains a file-tree simulation. These are not
admission decisions or a global seed reservation. Host allocation and inode results
do not measure ext4 metadata, its requested 8,192-inode layout, Linux cgroups,
crash-safe migration or a real device's rendering performance. The current guest
requests 8,192 inodes; the candidate contracts describe 8,192 / 16,384 / 32,768,
which were not measured by that candidate experiment. The separate controlled medium implementation below measures the 16,384-inode target on ext4. Larger cumulative
manifests also require an explicit seed transaction within the unchanged transfer
cap; splitting requests must not evade review, preservation or pending-operation
guards. Existing generations and their promises are not reclassified.

The candidate `CapacityManifestV2` binds the complete profile and limits into its
digest; it cannot be substituted for the installed `current-64` manifest. Actual
offline probes use `planExecutionCapacityProposal` and
`beginSeedTransaction` / `writeSeedWindow` / `commitSeedTransaction` /
`inspectSeedTransaction`. A complete synthetic observation can fit the proposal
model while `readyForMigration` and `runtimeEnabled` remain false. Other registered
volumes' unallocated growth is a separate requirement: it is explicitly zero
only in the single-volume fixture; missing real data remains unknown. Weighted
logical accounting includes both a source and its target or retained backup,
independently of their sparse physical allocation.

One bounded ordinary-file experiment on Apple M5 Pro / arm64 Node 22.23.4 produced
the following observations. Each copy had a fresh worker, a 1 MiB read/write
buffer, independent target inodes and complete content hashes. The populated
trees included source, media, dependencies, npm-cache-shaped files, package files
and build outputs; a separate 32 MiB changed-file stage stayed present during
copy. They are copy samples rather than formatted-volume migrations.

| Candidate / sample | Live populated tree | Independently copied bytes | Live + target + stage allocated peak | Copy time | Worker peak RSS |
| --- | --- | --- | --- | --- | --- |
| `capacity-64-v1` | 104 MiB, including 64 MiB media | 104 MiB | 240 MiB | 101.33 ms | 65.95 MiB |
| `capacity-128-v1` | 168 MiB, including 128 MiB media | 168 MiB | 368 MiB | 130.88 ms | 62.36 MiB |
| `capacity-256-v1` partial population | 220 MiB, including 192 MiB media | 220 MiB | 472 MiB | 136.40 ms | 63.86 MiB |
| Two simultaneous 64-profile samples | 2 × 104 MiB | 2 × 104 MiB | 480 MiB total | 141.65 ms end-to-end; 115.99 / 114.35 ms workers | 65.27 / 66.08 MiB |

The small-file sample had only 9,000 logical bytes but occupied 35.16 MiB in
allocated blocks, with 9,000 files and 9,005 unique file/directory inodes. It
exceeded the current guest's requested inode count without approaching the byte
limit; no real ext4 inode exhaustion was attempted. The actual proposal helper
separately rejected its inode-pressure observation and global-weight overages,
and returned unknown when other-volume growth was omitted.

Actual seed helpers staged 64 / 128 / 256 MiB in 1 / 2 / 4 windows of 64 MiB,
then independently verified and committed their exact staging receipts. The
final-source samples (one per profile, with earlier probes retained separately)
took 155.13 / 232.55 / 404.28 ms. One synthetic 32 MiB input
file supplied equal bytes to 2 / 4 / 8 distinct paths; every path still counted
toward cumulative capacity. Ordinary source was 23 bytes, fully inline. Maximum
staged physical usage was 288.01 MiB. The helper worker's process RSS high-water
marks were 261.94 / 266.31 / 266.56 MiB, cumulative across this serial run rather
than isolated per-profile allocations. A seed commit is a private staging receipt,
not permission to publish, execute or use the candidate in the guest.

Separately, the frozen `IsolatedVolumeMigrationStore` ran one final-source
`local-fixture` sample from `capacity-64-v1` to `capacity-128-v1`, with the earlier
report retained separately. Its ordinary sparse source
file was 256 MiB logically with 4 MiB of written fixture data; the core copied and
verified the full 256 MiB prefix before extending the target's logical length to
512 MiB. The retained source and target counted as 768 MiB of logical volume
capacity, while their physical peak including control records was 260.02 MiB.
Preparation, private fixture authorization, copy, complete verification and an
explicit same-ID reconciliation took 2,055.13 ms (1,980.47 ms CPU), with 89.34 MiB
process peak RSS. Reconciliation left the target inode and modification time
unchanged. JSON authorization, a cloned plan and a `controlled-backend` store
were each refused. These are separate file-copy, seed, proposal and migration-core
experiments; they do not assemble into one admitted runtime execution.

The confirmed fixture reported `sourceState: "original-retained-verified"`,
`targetCopy: "verified"` and `mutationLease: "absent"`. Its core explicitly marks
interrupted-copy continuation and automatic rollback as unsupported. A fresh
process may only verify an existing stale-lease outcome read-only against its
exact durable authorization; it retains the lease and reservation rather than
expiring, removing or reusing them. No 512 MiB
prefix migration to a 1 GiB logical target was attempted under this experiment's
physical bound. An ordinary sparse file has no ext4 geometry to resize: this
sample does not validate real volume migration, stale-lease recovery after a
process restart, or user-project publication. All candidate profiles remain
disabled in the installed runtime.

All payload trees were removed and the observed free-space floor stayed above
2 GiB. These are single warm-cache samples with other host load unisolated, not
latency guarantees. Optional
sampling of the known worker PIDs was denied by the sandbox (`spawn EPERM`) and
was removed without retry; each worker's own `resourceUsage()` supplied its peak
RSS. Adding those peaks is not a measured simultaneous peak. No network, npm,
model, real project, VM, decoder, GPU or FPS measurement ran.

Authenticated clients can read the same no-store report at
`GET /projects/:projectId/execution-storage/capacity`. External workspaces are
refused before inspecting parent recovery directories. Host inventory is a
bounded metadata observation; incomplete totals are lower bounds, and excluded
Canvas candidates have not been validated as transferable content. Incremental
transfer bytes and the actual changed-before/after set remain unknown until their
existing controlled operations establish them. The conservative new-operation
estimate uses current enforced maxima (470 MiB logical, before the intent
allowance), not a captured change set. Existing history and outstanding promises
are reported separately; 512 MiB remains their shared current quota. Missing local
image storage coverage makes combined totals unknown. Disk figures are advisory,
not an OS reservation or an approval. A clean finished task is not treated as a
retained failure; active, dirty and unfinished states keep their original rules.

## Identity and activation

Project identity stays stable across sleep/restore. Retirement neither deletes an
account nor reissues its number. Allocation burns the number durably before
account creation, including failure. Old ownership, ACLs or IPC therefore cannot
be inherited by the next project. Jobs also use private IPC and keyring state.

Production readiness requires the private root-owned ledger
`/var/lib/ohmygame/identity-range-v2.json`. A trusted maintenance process must audit
owned files, numeric ACLs, IPC and accounts, then record audited free numbers,
claimed numbers and an evidence digest. Missing or unsafe ledgers make health
`ready: false`. An absent passwd entry alone is insufficient. The controller,
storage adapter and lifecycle module must be updated together, with no active
jobs, and current volumes inventoried before migration. Startup does not create
an approval ledger or retire legacy accounts.

On this machine, separately approved maintenance on 2026-11-04 removed five
legacy test accounts and seven named-UID journal read ACLs after the old allocator
was replaced. Log contents, original groups and their numeric IDs were retained.
The five old user numbers remain permanently claimed in the identity ledger;
account removal does not make them available for allocation.

## Validation boundary

Python tests use real registry files, reopened crash phases, production source
transactions in temporary directories, and controller dispatch with mocked system
services. TypeScript tests use fake execution/model providers and local preview
servers. Renderer checks use an independent in-memory fixture at four widths.
These do not establish a live VM upgrade, real identity provisioning, filesystem
exhaustion attack or paid generation result.

Run Python with `-B` and a supported Python version. For isolated checkouts with
symlinked dependencies, use Vite/Vitest `--configLoader runner --no-cache` and a
task-local cache directory, keeping the original checkout untouched.


### Controlled medium profile (version 2)

`capacity-128-v2` is a separate runtime contract, not an activation or rename of
any disabled `capacity-*-v1` candidate. It supports 128 MiB of cumulative eligible
media on a 512 MiB project image, with a 1 GiB source recovery contract. The host
requires the exact installed guest capability and complete versioned profile;
old volumes, pending generations, manifests, approvals and journals retain their
original contracts. No user volume is migrated automatically.

The main Agent can explicitly request `recover_isolated_changes` with only
`action: "upgrade_capacity"`. This may start the fixed VM and flush/unmount a
known idle volume to obtain a stable source identity. A running preview, dirty
source, unfinished restore/publication, unknown lease or migration prevents the
operation. The native card shows the exact original image, target, old-volume
retention, host/guest disk and inode requirements, global coexistence and recovery
history. Both capacity and old-volume confirmations are mandatory, specific to
one plan and generation; model arguments, chat text and session-wide approval
cannot authorize it. A person may explicitly request another attempt after a
confirmed decline or a fully known pre-approval capacity refusal; the original
plan and receipt are preserved, the guest must freshly prove no authorization or
execution began, and the new plan needs its own native confirmation. Interrupted
approval or unknown submission is not eligible for this path. A source-less project uses an explicit create plan rather
than an implicit legacy allocation.

The host durably records the plan ID before submission and authorization ID
before registration. The guest retains immutable plans, authorizations, operation
phases and the original image. The new ext4 image is independently copied and
resized; file contents, ownership, permissions, extended attributes, links,
geometry and original image digest are verified before an atomic registry
pointer switch. Old and new images and retained backups count separately under
the existing 4 GiB global ceiling. A copy is never retried after an unknown
outcome. `inspect_capacity_migration` checks only the original durable plan;
physical promises are released only after fresh exact committed verification.
Interrupted copying, stale ownership, an expired registered authorization,
unknown journal writes and copy rollback/resume require review: automatic
reclamation, copy resume and automatic rollback are not implemented. No temporary
or retained target is silently discarded.

First-allocation control claims the host project's execution slot before its
first asynchronous check. Preparation, recovery and a second capacity request
cannot enter that slot concurrently; quiescence waits for the current control
request. The guest serializes each control step under its storage lock. A
`planned` create has no execution authority and may lose to ordinary preparation;
registration or execution then refuses the changed source before unmounting,
snapshotting or modifying that project's existing volume. It never turns that
create plan into an enlargement.

A valid registered create authorization blocks ordinary preparation and another
authorization for the same project. It is not yet counted as an allocated image;
execution still rechecks actual disk, inode and global capacity before claiming
an identity or creating an image. Cancellation before execution does not extend
the approval: an unstarted create authorization stops blocking guest preparation
when its original approval expires (at most ten minutes). The original host
receipt and any physical promise still require inspection; expiry does not
release them or cause automatic replanning. An expired enlargement, or a create
that reached `started`/`unknown`, remains inspect-only and cannot fall back to
ordinary preparation or replay the copy. No automatic initial profile selection
or new-project eligibility marker is enabled by these guards.

Source manifest 2 includes the fixed profile and complete source/media inventory.
Capture 4, source publication 5 and source intent 3 bind that same profile and
base/raw/prepared manifests. Initial media seed uses `prepare-begin`, bounded
`prepare-append` windows and `prepare-commit`; an operation cannot run until the
whole staged inventory has been verified and committed. The cumulative limit
is 128 MiB, each upload window remains 64 MiB, each media file remains 32 MiB,
and actual changed/returned media remains 64 MiB. Same-SHA files at different
paths still count separately. Verified build copies may total 128 MiB, while
newly generated output independently remains at most 64 MiB. Larger results
stop as a complete retained batch rather than being partially published or ACKed.

The worst unknown-command source envelope is 598 MiB logically: complete old
eligible contents (up to 136 MiB), bounded raw/working/returned contents,
metadata, journal and rollback overhead. Space plan 2 separately includes
512 MiB of possible guest image growth in the physical promise; at a 4 KiB
allocation unit that physical plan is about 1020.25 MiB. Native migration also
accounts for other registered images' still-unallocated growth. Actual history,
concurrent promises, disk safety floors and inodes are rechecked before dangerous
submission and publication; they remain advisory reservations, not an OS promise
that later writes cannot exhaust space. Only a verified shared device for the
fixed VM backing disk and host control storage is supported in this batch;
cross-device capacity admission refuses safely.

Host image inventory checks can use the medium limit only from a current,
versioned trusted guest record. Stopped/stale/unknown state does not widen the
bound. Image preparation keeps original bytes, dimensions, frame layout and
transparency unless an explicit derivative is chosen. Existing local-image
publication version 3 and its 512 MiB local preparation contract remain unchanged;
this is separate from the new source recovery contract and may still refuse an
image operation with substantial retained history.

Capacity and encoded bytes do not certify runtime performance. Check decoded
pixels, peak memory, target-device `MAX_TEXTURE_SIZE`, actual atlas dimensions,
loading, GPU allocations, frame mapping, alpha edges, draw calls and frame time
before choosing larger runtime assets or splitting an atlas. Local ext4 and
protocol tests do not measure a target game's GPU memory, FPS, video decode,
long-audio streaming or complex 3D loading.


The following historical acceptance record belongs to version 2, before the
separate AV/GLB profile below. Local acceptance of version 2 used independent private Linux ext4
images and the real Store/Backend: creation, 256→512 MiB enlargement retaining
768 MiB of old-plus-new logical allocation, full 128 MiB seed in two 64 MiB
windows, capture/review/ACK, a real scripted source edit with zero changed media,
128 MiB verified build references, archive/reactivation, incomplete input,
original-lease replacement and the no-record identity-allocation failure. Four
controller subprocesses separately exercised actual JSON/binary framing against
the private store. Native-card behavior and host recovery publication were checked in separate
offline fixtures. The identity allocator used an existing sandbox UID; real
account provisioning was not tested. No actual npm/systemd job, user-project
migration or power-loss copy test was performed.

That version-2 six-scenario sample took about 6.72 seconds. Its Python self peak RSS
was 59,944 KiB; maximum observed outer allocated bytes were 344,621,056 at discrete
checkpoints. These are process/checkpoint measurements, not a simultaneous
process aggregate, cgroup peak or continuous disk peak. The media were four
byte-identical one-pixel RGBA PNGs padded to 32 MiB each, on distinct paths. This
checks encoded transfer and full-inventory semantics; it does not measure real
texture decoding, game memory or rendering performance.

Real testing exposed asynchronous Linux loop autoclear after successful
`umount`. Both ordinary and profile cleanup now allow at most three seconds of
read-only observation after their own verified successful unmount. Initial
unknown attachments, changed image identity, remounting, read failures and timeout
still refuse; no forced detach, repeated unmount or registry repair is attempted.
At that version-2 installation, the six components were matched to the successful test's source hashes,
with the prior three components backed up and prior absence of the new modules
recorded. Installed import/capability validation used a metadata fixture and did
not inspect actual user registry health. That maintenance did not launch the application or migrate user projects;
existing volumes retained their previous contracts.

### Controlled AV/GLB profile (version 3)

`capacity-128-media64-v3` is an explicit alternative for a new project volume or
an authorized legacy 256 MiB-to-512 MiB migration. The old `capacity-128-v2`
descriptor and all prior generation contracts are unchanged. An existing 512 MiB
volume is refused before a new durable plan is written; same-size profile
migration is not implemented. Stopped, stale or untrusted observations cannot
establish absence of a volume or enable the new policy.

The v3 descriptor keeps `mediaFileBytes: 33554432` and adds
`largeMediaFileBytes: 67108864` with
`largeMediaFilePolicy: "video-audio-glb-v1"`. Only MP4, MOV, WebM, M4A, MP3, WAV,
OGG and GLB use that larger file bound; raster images retain their existing byte,
pixel, decoded-memory and transparency checks. Large ISO-BMFF inputs need a
complete bounded `ftyp` header and reject image brands. This is format admission,
not full codec/model validation. Cumulative media remains 128 MiB, transfer windows
and actual changed-media returns remain 64 MiB, source bytes remain 2/8 MiB,
the project volume remains 512 MiB and source recovery remains 1 GiB. A pair of
new 64 MiB copies exceeds the changed-media budget even if both fit cumulatively.

The Agent must request `action: "upgrade_capacity"` with
`targetProfileId: "capacity-128-media64-v3"`. Omitting the target preserves v2.
The native approval shows the separate raster, AV/GLB, cumulative, transfer,
volume and recovery limits. The same six exact confirmation fields bind the
original plan, generation, source digest, target and two human confirmations.
No model or session approval can choose or authorize this change. A new host
accepts exact v2-only guest capabilities for old operations, but v3 needs the
exact version-3 capability list and descriptor. Unknown IDs or mismatches refuse.
No old project, pending generation, retained original or backup is upgraded.

Inspected host seeds, unchanged media and exact verified copies can carry larger
AV/GLB files through complete manifests, bounded upload windows, build-copy
descriptors, publication, cold inspection and rollback. Unknown or rewritten
large outputs stay retained and blocked; a raster preparation receipt cannot
authorize them. Source manifest 2, capture 4, publication 5, intent 3 and space
plan 2 already bind the complete profile identity and are retained. The
conservative 598 MiB logical / approximately 1020.25 MiB physical envelope at
4 KiB allocation units is unchanged. It is not a memory allocation allowance.

Media is inspected and streamed in bounded chunks, with separate immutable-copy
and destination disk promises, complete hash/protected-data checks, cancellation
and confirmed descriptor cleanup. Allocation races can still cause host-full or
guest-full errors: partial writes and lost acknowledgements preserve their
original operation and remain inspect-only when the outcome is unknown. No
automatic replay, cleanup or paid regeneration is added. Source transfer does not
make video, long audio or GLB streamable in an engine: actual decoder seek,
model animation/texture loading, peak CPU/GPU memory and frame time still need
separate target-device acceptance.
Daemon GLB inspection is a separate local parser contract, not permission to
return an unknown large model or treat parsed metadata as adoption approval.
Its budgets do not protect browser/model-viewer or FBX loading; see
[local model inspection and retained results](canvas-agent.md#local-model-inspection-and-retained-results).


Version-3 acceptance is separate: eight private Linux Store/Backend scenarios
covered two real 64 MiB PCM WAV seeds, a geometry/skin/animation/embedded-texture
GLB, source deltas, verified build references and unknown-operation protection.
A separate ninth scenario used a real VP9 MP4 of 56,633,476 bytes, with controlled
seed, verified output copy, capture/review/ACK and build-reference checks.
Existing v2 512 MiB-to-v3 requests were verified to refuse without changing the
old image or creating another plan. This did not test a same-size migration.
The core run took about 9.23 seconds, with Python self and child peak RSS each
28,096 KiB; the separate video run took about 0.91 seconds, each 28,092 KiB.
These are per-process high-water marks, not combined memory, a VM/cgroup peak,
codec-decoder memory or GPU/frame-time evidence. Guest checks established full
byte identities and bounded format admission; the sample's separate media
validation does not establish a target game's playback or visual acceptance.
The six-component installation checked exact source hashes and a metadata-only
capability fixture with both v2 and v3 descriptors, not actual user-registry
health. Both private fixture roots were removed and their maintenance VMs were
stopped; no user volume or project was migrated.

#### Future same-size contract migration (design only)

A future v2 512 MiB-to-v3 512 MiB change would need an explicitly negotiated
profile-change plan, an independent new image and exact native approval. It
would bind both profile identities, the original image and manifest, a new
target image and manifest, and a new generation. Keeping the old image would
still add 512 MiB to the logical volume total, alongside all existing backups;
it would not be a zero-space metadata relabel. Existing raw-plan parsing,
retained-image records, partial-target inspection and exact deletion checks
would need to support that transition without reinterpreting old history.
Completed prior plans would need exact archival before another native request.
Unknown copies would remain original-plan inspection only, without replay,
copy continuation, automatic rollback or deletion. This is a design boundary,
not an implemented or enabled migration path.
