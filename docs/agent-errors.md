# Agent request errors

Model request failures appear as a single collapsed row in the chat timeline.
Expand the row to see actionable guidance, full diagnostics and a footer copy
icon. Copy success briefly shows a checkmark before the icon resets.
Unclassified failures include an ellipsized provider response in the summary.
Only the current reconnect attempt uses the activity shimmer; later model or
tool activity stops it, and successful retries disappear.

Authentication, account limits, request compatibility, provider server errors,
DNS, TLS, timeouts and interrupted responses have distinct presentations.
Unknown failures remain explicitly unclassified. Local CLI compatibility failures
use `runtime_incompatible`; temporary startup or unverified checks use
`runtime_probe_failed`. Both show CLI details instead of a provider response and
omit the network configuration row. The `Local CLI compatibility:` and
`Local CLI check failed:` prefixes remain in native turn records so replay
preserves these classifications.

The details can be copied and include the provider, model, endpoint, transport, HTTP status,
provider request ID, available underlying error codes and causes, and the number
of agent retries in the turn. Missing fields are omitted. The network field is
the active startup configuration from the network settings service, including
whether it uses an environment, system or manual proxy, or direct connections.
Saved changes that require a restart do not replace that active snapshot. The
field does not prove whether a particular request bypassed the proxy or how a
VPN routed it.

WebSocket errors omit the synthetic HTTP 200 created by the SSE adapter. Real
handshake or provider rejection statuses appear as Provider status, with close
code/reason and timeout causes retained when available. Persisted errors from
beta.4.6 also have their misleading WebSocket 200 removed on normalization.
These WebSocket records can still appear in history. The local Agent uses the
guarded HTTP/SSE transport. Pi SDK retries remain disabled; application-owned
continuation uses the classified interruption protocol below.

The application converts Pi messages and thrown errors into the same
`ThreadItemError` directly. Only the daemon classifies failures; the renderer
maps its code to a title and guidance. Structured HTTP status takes precedence
over generic wording, with explicit quota codes distinguished from rate limits.
Transport classification uses the saved cause codes, names and messages, so SDKs
without native error codes still give useful diagnostics.

For credentialed SSE responses, the local Agent distinguishes 180 seconds
without response bytes, a local validation failure, and an interrupted or
incomplete stream. Each nonempty chunk, including an SSE heartbeat, restarts
the idle timer. The Agent can receive a response for longer than 180 seconds
and releases it after the complete response passes inspection. HTTP 200 records
receipt of the headers. It does not establish delivery of a usable answer or
the billing outcome. Interrupted or rejected streams are not automatically replayed.

## Local HTTP error diagnostics

The guarded transport keeps the HTTP status, a bounded request ID and recognized structured error codes. It reads at most 8 KiB for one second, then cancels the error body. Free-form error messages, unknown codes, response bodies, cookies, URLs and other response headers are discarded. Request IDs must be short ASCII identifiers and must not contain registered credentials. Missing metadata remains missing; a 500 alone does not identify whether a gateway or its upstream rejected the request.

A `Provider HTTP request failed` line in `daemon.log` records the filtered status, code and request ID, checked request bytes when available, and milliseconds from opening the transport to receiving response headers. These durations are per HTTP request, not the whole agent turn, and exclude response-body inspection. No prompt or image data is logged. The normal Agent failure record also retains the filtered code and request ID through the SDK.

## Automatic continuation after an interruption

Pi, controlled Codex and controlled Qoder share application-owned continuation.
A fresh failed model response is required. Pi recognizes structured HTTP
408/429/500/502/503/504 responses and specific transport failures; authentication,
quota, permission and response-validation errors remain terminal. Native drivers
must supply an explicit safe interruption category. An error string alone never
authorizes continuation. Qoder retains finite result subtypes and terminal reasons,
including the distinction between its 64-round segment limit, a hook stop and an
unknown execution error. Codex distinguishes native interruption from a cancelled
application signal and refuses completion while a controlled tool is unsettled.

The existing 5/15/45-second delays allow at most three continuations of one logical
user task, including across native context rebuilding. This is an execution-safety
limit, not a money, credit or generation-quota limit. This edition does not add a
model-spending cap. Pi SDK/provider retries remain disabled. Normal completion,
user cancellation, shutdown, security/policy failures and unknown reasons do not
trigger continuation. No original user prompt is resent and no new user checkpoint
is created. An invalid native context rebuilds with bounded tool-result history,
original call IDs, image references and the current task; it never reuses an old
ready marker from before the failure.

Pi and native bridges use the same per-task tool guard. It records an attempt
before execution, keeps the real result and original call ID, and refuses an
unconfirmed effect during continuation. Exact completed operations reuse a saved
receipt, explicitly described as historical rather than a current file snapshot.
Reads, attachment authorization and runtime snapshots remain fresh. Existing media
is recovered only by the original call ID or receipt-bound Canvas job. A new media
submission with different arguments cannot be proved to be the original operation
and pauses automatic continuation; this certainty check is not a fee ceiling.
Normal user-directed work retains the existing media approvals and recovery rules.

A failed tool is not necessarily an uncertain effect. Trusted daemon branches may
explicitly report a correctable rejection before any modification, such as an
`edit` whose old text does not match exactly once, oversized text, or invalid
Canvas input. These attempts keep their error receipts as `not_executed`, rather
than becoming successful operations. Continuation may read current state and use
a new call ID to correct the input. Reusing the original ID only returns its
original failure; it never executes that edit again.

The evidence is a private in-process brand, not error wording, duration, a model
argument or a JSON property. Restoring this classification requires a new
host-written stage record paired with the original call and canonical failure.
Old `unknown` records are not reclassified, and conflicting call arguments or
missing evidence remain uncertain. Permission, approval and protected-data
rejections still block continuation even when no modification occurred. Once
`mkdir`, file creation or later write operations can have started, generic errors
remain uncertain: a failed truncate, partial write or close cannot prove no effect.

Isolated project commands also keep host-owned operation phases in the original
tool attempt. The task and call ID are bound to the project, namespace, operation
ID and, once established, generation and captured snapshot. No lease token,
command arguments or file payload enters this receipt. The host persists a phase
before submitting preparation or a command. Only a privately identified input
budget rejection before submission permits a new corrected call; the failed call
ID still returns its original failure. This says the project command was not
submitted, not that a preview could not have paused or the VM could not have woken.
An executed command with retained output, an interrupted publication, missing
confirmation or failed cleanup remains blocked. A later successful operation does
not erase an earlier uncertain one, and a restart does not replay it.

Retained-file inspection is metadata eligibility for a controlled recovery
attempt, not proof that recovery will succeed. The raster inspection rule version
must be compatible with the generation's return rules. Missing or incompatible
inspection rules fail closed with an update explanation. New and modified static
PNG/JPEG/WebP candidates on version-1 raster returns retain their 512 KiB bound.
New generations may explicitly negotiate `captureVersion: 2` with raster policy 2;
their static-image candidates are bounded to 32 MiB and 32 Mi pixels per image and
still require the complete review and approval flow. Old version-0/1 generations
are never upgraded in place. Verified copies of existing runtime media retain
their separate limits. Raster-return generations still require
complete host decoding and transparency checks; baseline and original-retention
checks run before publication. Unavailable
inspection and known blockers never produce `recoverable: true`.

For images already in the host workspace, the existing local
`optimize_image_asset` prepares a bounded working copy and retains the original.
Its default is identity preparation: keep the original bytes, dimensions and
pixels after validation, within the 32 MiB / 32 Mi-pixel decoding bounds. Resizing
requires an explicit `maxEdge`; it does not automatically choose a smaller size,
raise quality, or guarantee atlas layout, frame mappings or transparent edges.
It does not request another generation and is
not a universal solution for a specification that needs the full original.
For retained guest results, the main Agent uses `recover_isolated_changes`:

1. `inspect` reads current passive status. A stopped volume is not a missing result.
2. `review` explicitly opens a bounded read-only snapshot and checks the complete
   batch. It may start the existing VM, but never runs project code. Raw raster
   candidates are separate from verified media copies; they do not grant file or
   execution authority.
3. `optimize` uses the current review ID and exact listed image paths. It keeps
   independent immutable originals and prepares private working bytes. Without an
   explicit `maxEdge`, preparation preserves dimensions. If that cannot fit, the
   Agent can choose a suitable explicit derivative size or keep the original and
   stop this return path. It must not drop alpha, frames or quality requirements,
   silently shrink, or generate a replacement.
4. `adopt` requests the existing trusted file and separate code confirmations for
   the exact complete prepared batch. The host rechecks the raw snapshot and live
   baseline, publishes only validated working bytes through its journal, and
   acknowledges the raw result only after all originals and target files are safe.
5. If acknowledgement or completion is uncertain, `verify` checks the original
   review ID, publication, target fingerprint and exact recovery operation. It
   cannot reserve, publish or acknowledge another recovery. Confirmation loss
   permits only controlled reads and this verification; an unconfirmed result
   still stops. Unknown publication never authorizes a substitute review.
6. After confirmation, the Agent rereads current project files through controlled
   `read_project_file` or `read` and verifies references, frame dimensions and
   unfinished behavior. Attachments and native read claims do not satisfy this
   step. Returning preserved effects is not proof the old command succeeded.

The v2 acknowledgement records independently retained raw runtime images as the
guest's known baseline; it does not write normalized guest source or make those raw
images trusted host copy inputs. The next ordinary prepare verifies that baseline
and uses the existing source-sync transaction for the host's working files. Raw
and working snapshot IDs, recipes, originals and approval identities stay distinct.
Interrupted publication retains both versions and the original transaction.

Only a host-proven captured, retained and released operation with an exact original
task/call/operation/generation/raw snapshot mapping may enter bounded repair-only
continuation. It uses the existing continuation attempts, permits controlled reads
and the retained-result workflow, and blocks ordinary edits, execution and media
generation until the matching effects are settled. Settlement records
`effects_recovered`, preserving the original failure; it never converts that
command into a successful execution or allows the same command to be replayed.
Missing snapshots, unmapped old history and other uncertain effects remain blocked.

The review's `imageCost` separates encoded bytes and pixels from RGBA8 decode,
base-texture and full mip-chain estimates (including the base level). These are
not measured GPU memory, target-device compatibility or a passing FPS result.
When the actual target WebGL environment is available through controlled
`game_use` and existing project instrumentation, read `MAX_TEXTURE_SIZE` and check
both atlas dimensions; that capability ceiling is not a performance budget.
Splitting an atlas requires checking frame/anchor mapping, transparent edges and
padding, plus batching, draw calls and frame time. Missing target-device/runtime
measurements remain untested, even if another preview or build succeeds.

These bounds are transport and retention limits, not art specifications. The raw
review shares the existing 64 MiB media total with verified media and retains the
32 MiB per-media and 8 MiB ordinary-source bounds. New version-3 publication
journals use a complete, durably reserved 512 MiB recovery envelope; existing
version-2 journals keep their original 32 MiB policy. Capacity refusal retains
the original transaction and does not authorize smaller artwork or a replacement.
See [host recovery reservations](isolated-storage-lifecycle.md#versioned-host-recovery-reservations)
for accounting, startup reconciliation and filesystem limitations.
PNG/JPEG/WebP image preparation does not implement video, long-audio or 3D
recovery. A limit refusal must name the failing stage and preserve its inputs.
Broader asset limits need a separate end-to-end assessment of generation, Library,
preview, transfer and recovery, including sprite sheets, mesh complexity, video
and music duration. Streaming and reference-based delivery, project-appropriate
runtime derivatives and capacity accounting should be evaluated before changing
numbers; increasing every limit is not a recovery strategy.

After results are reconciled, the current task, branch, model and project admission
are checked again before dispatch. Where configured, the existing checkpoint store
also compares workspace commits before and after backoff; user edits are preserved
and stop the old continuation. A newer user message during recovery/backoff stops
the old continuation, lets its failed turn settle, then starts the new instruction.
Ordinary in-flight follow-up queues keep their existing behavior.

Tool outcomes that arrive after cancellation retain their original task ownership.
If the originating branch is no longer current, a private
`.late-tool-result-<id>.json` beside the original session retains the result for
review instead of appending it to a different branch. This path does not recreate
a deleted project. Failure to retain an outcome blocks automatic continuation.

The existing reconnect row shows the attempt and limit, and Stop cancels both
backoff and recovery. Each attempt and terminal outcome is stored in the session;
diagnostics contain safe categories, IDs, counts and timing, not tool inputs or
provider bodies. A process restart never starts a model request: a saved pending
continuation appears interrupted and requires review. Graceful shutdown records
cancellation. There is no background
replay of old failed, completed or cancelled turns, and no new fee/credit limit.
Continuation itself is a new conversation-model request and may be billed during
normal use; offline validation uses simulated responses only. It mitigates a
transient failure and cannot repair or diagnose a gateway's internal HTTP 500.

The same transport now has [passive request monitoring](diagnostics.md#passive-request-monitoring)
for both successful and failed requests. Correlated stage records distinguish
headers, actual response bytes, local inspection and the SDK's protocol outcome.
A completed HTTP body is separate from a completed model answer. Missing finish
reasons or native terminal events remain interrupted streams even when the
transport returned HTTP 200. The records cannot identify a gateway's internal
connection failure without its operator's logs.

## Pi compatibility patch

The pinned `@earendil-works/pi-ai@1.2.0` loses nested connection causes when it
converts SDK errors into `AssistantMessage.errorMessage`. For example, the OpenAI
SDK wraps DNS and TLS failures alike as `Connection error.`. The Bun patch in
`patches/@earendil-works%2Fpi-ai@1.2.0.patch` captures public error metadata in Pi's
existing `AssistantMessage.diagnostics` before conversion.

The patch covers the OpenAI completions and Responses adapters (including Codex
and Azure), Anthropic, Google Generative AI and Vertex, and System One. Existing
Bedrock failure metadata is also understood by the application. It does not
replace provider implementations or alter `errorMessage`. Pi retains its bounded
retry and context recovery policies. The retry classifier additionally respects
authoritative WebSocket authentication, quota and request rejection diagnostics;
words such as a parameter named `timeout` cannot make these errors retryable.
Context-compaction errors and third-party adapters
can still return only a message; those failures use the available message as a
fallback.

Cause traversal is bounded and handles aggregate errors and cycles. Only selected
error fields are saved; stack traces, request bodies and full headers are omitted.
Diagnostic text and URLs redact common credential forms, URL credentials, queries
and fragments through shared helpers. Codex HTTP retry diagnostics retain only
the current attempt's response metadata. Application-side normalization applies
the same public field allowlist when restoring a session.

Pi saves assistant diagnostics in its session JSONL. The application also records
the terminal error in an `ohmygame-agent-error` custom entry to preserve its
network configuration and retry count on reload. Live retries retain the latest
attempt's cause. Successful retries and user cancellation produce no terminal
error record. Failures before Pi records the user message get a separate history
item, so they cannot overwrite a previous turn's error. Terminal failures are
logged once by the daemon with chat and turn IDs, duration and diagnostics from
the `agent.error` event. Its existing error string is retained; code and
diagnostics are optional event fields.

The terminal entry deliberately keeps a complete normalized error instead of
depending on mutable Pi messages or SDK persistence order. Normalization on
reload validates stored or imported session data as well as current messages.

## Maintenance and validation

`bun install --frozen-lockfile` applies the versioned dependency patch. When
upgrading Pi, check whether the new version preserves these fields before
removing or adapting the patch. Prefer an upstream implementation of the shared
failure diagnostic helper and adapter hooks over a permanent fork.
Every Pi upgrade must also recheck the WebSocket retry classifier: authoritative
authentication, quota and invalid-request failures remain non-retryable, ordinary
429 rate limits and transient provider failures remain retryable, and context
overflow still enters compaction. Keep these checks after a clean dependency install.

Run `test/provider-error-diagnostics.test.ts` to exercise real Pi adapters with
offline fetch fixtures, and the agent error, agent manager and timeline tests to
verify classification, redaction, retry completion and history restoration. The
same provider tests should pass after a clean dependency install. Desktop release
verification must confirm the patched helper and adapter hooks are present in
the packaged application's dependencies.
