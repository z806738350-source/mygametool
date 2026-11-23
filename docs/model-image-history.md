# Model image history

OhMyGame retains images in the Pi conversation transcript. Model requests use a
separate projection; neither the transcript nor the conversation UI is rewritten.
The stored session can therefore remain large. This feature bounds transmission;
it does not migrate historical image bytes out of the session file.
This addresses [#187](https://github.com/WhiteTowerAI/ohmygame/issues/187), where
repeated screenshots made requests tens of megabytes larger on every turn.

Images pasted or attached to chat stay with the conversation. A screenshot sent
for feedback reaches the vision model even when the game exceeds its source-size
budget. Saving an image in the Library or importing it into the game is a
separate, explicit action. Duplicate attachment IDs in a message resolve once.
The local server streams file uploads to disk separately from the conversation.
One chat request can carry up to 128 MiB of original encoded images before the
outbound model budget is applied. If the combined images exceed that limit,
send fewer per message. Already uploaded originals can be reused.
Local project responses are served with `Cache-Control: no-store`. Conversation
previews are kept in the project-scoped daemon cache and removed with the project.

The built-in agent can answer a standalone triangle-count question about the
original Tripo model or the delivered GLB from an unambiguous verified Blender
report in the current conversation. It checks the retained report and any
selected Canvas model and records the answer in the conversation without a
provider request. Questions with attachments, ambiguous targets or unverified
changes use the regular agent path, as do repair and visual review requests.

Text attachments up to 1 MiB provide a read-only `attachment:<batch>/<id>`
reference for the agent's `read` tool. Other file types and larger text
attachments provide metadata. Images sent as files can accompany the prompt
when the selected model supports them (up to 20 MiB per image).

In this local secure checkout, the [current Kunpo adapter scope](kunpo-local.md)
supersedes the upstream transport table below. Application-managed user turns
may add an `ohmygame-image-origins-v1` custom entry immediately before their
canonical message. It holds only a message digest and ordered asset IDs, never
URLs, image data or prompts. Exact message and byte checks recover those hints
for follow-up, queued, revised and recalled images; the private asset source
receipt must still match before a reviewed Chat or Opus request can use a CDN
URL. Missing, altered or legacy provenance stays inline. Canonical images are
unchanged, and GPT-6.1's unverified visual input remains unavailable.

## Local project file tools

In the local secure edition, `read` accepts PNG, JPEG and WebP project paths
only for image-capable models. It returns the original image bytes, not a UTF-8
interpretation, after the bounded 64 MiB secure file snapshot has checked paths,
links, concurrent changes and registered credential values. The optional `offset`
and `limit` arguments paginate text only. When a model includes them on a project
or attachment image read, the tool returns the whole image. Text reads retain
their 1 MiB limit. The existing request-image preview and transmission budgets
below still apply; reading an image does not rewrite its workspace original.

`write` and `edit` remain text-only. They refuse binary-media filename extensions,
and `write` checks the opened original before truncating it: files above 1 MiB,
NUL-containing data and invalid UTF-8 cannot be replaced. Keep generated originals
and use a separate file for notes or replacement assets, never a text placeholder
at an image path. `grep` accepts either one safe project file or a directory.

A generated-image download failure is distinct from generation failure. A ready
image-request journal retains the artifact URL for recovery without another paid
submission. A retained library original can also recover an accidentally changed
workspace asset; verify its provenance and hash and save a separate copy rather
than silently replacing the current workspace file.

## Request policies

| Route | Transport and images |
| --- | --- |
| Official OpenAI Responses, ChatGPT subscription | WebSocket with connection-local incremental input; budgeted full replay on reconnect or HTTP/SSE fallback. No Files API probe. |
| Official OpenAI Responses, Platform API key | The same WebSocket transport plus cached vision file uploads. Bounded inline fallback when uploads are unavailable. |
| Custom Responses endpoints | HTTP/SSE by default, with optional WebSocket and connection-local input reuse. Inline image budgets apply; official Files APIs are never probed. |
| Official DeepSeek | The existing original-image Files adapter and its limits are preserved. No preview conversion or generic image omission. |
| Other providers and custom compatible APIs | Budgeted inline images through Pi's existing adapter. OpenAI-specific capabilities are not assumed. |
| Legacy OpenAI Codex | Pi's existing transport, with conservative full-input budgeting before it chooses a WebSocket delta. |

The official OpenAI route is exactly `https://api.openai.com/v1/responses`.
Network proxies remain supported through the application's Undici dispatcher;
changing the endpoint, dispatcher or credentials invalidates the connection and continuation.
Pi's `sse` transport setting is honored; plain `websocket` and `cacheRetention: none`
disable incremental context reuse. WebSocket failures before any response
event allow HTTP fallback, with a five-minute backoff before probing WebSocket
again. Midstream connection failures preserve their retryable errors and select
HTTP/SSE for the next attempt. Pi owns bounded retry, the Reconnecting events,
failed-attempt omission and tool execution. A retry regenerates the current model
response with required history; it cannot resume the interrupted generation.
See [Responses transport](responses-transport.md) for settings and recovery policy.

## Inline budgets and recovery

For managed visual Agent requests in the local edition, the current user’s
attachments and the latest two batches of visual tool results from that turn
form the working set. Parallel reads of a set of views count as one batch.
Text-only tool results normally keep the same working set. After comparing the
required images, the Agent can mark a successful `edit` or `write` with
`releaseReviewedImages: true` when moving on to nonvisual work. A combined
Blender save and run or a standalone `recall_image` also accepts this flag.
The next request carries recallable IDs. A failed or incomplete tool batch, or one that returns fresh
images, keeps the visual comparison available. For a combined Blender call,
the release depends on a verified save, even if the run then fails.
A new user message starts a
fresh one. Older pictures stay in the conversation as recallable IDs on the
model side. When the user refers back to a picture, the Agent can call
`recall_image` to bring that original into the current comparison.

These are application defaults, not advertised provider limits:

- Trigger image omission above 20 MiB of Base64 or 64 inline images.
- Remove a batch toward 10 MiB and 32 images, prioritizing old `game_use` images.
- The lower limits are cleanup targets. Protected images may keep a reduced request
  above them, as long as the 20 MiB / 64-image hard limits still hold.
- If the protected images alone exceed a hard limit, fail locally.
- Limit the complete serialized request to 32 MiB, including text and JSON.

Kunpo’s `gpt-6.2-astra` Responses route starts omitting older images when
their combined inline count exceeds 32 or their Base64 exceeds 8 MiB. It aims
for 16 images and 4 MiB while keeping the latest parallel tool results
together, so a batch of animation keyframes can still be compared. Protected
images can exceed these cleanup targets within the shared hard limits above.
The original images remain available through `recall_image`. This route uses
its own omission records. A generic HTTP 400 does not trigger a retry.

During an active visual turn, the same Astra route may also keep pictures from
the last accepted request in their original tool results. Their source, tool
call ID, other pictures and accompanying text must still match on the current
Pi branch. Astra can keep a retiring render in a tool result that still
contains the user's feedback image. The combined visual input must fit within
12 MiB of Base64, 32 pictures and the complete request budget. This can
preserve a reusable prefix when new Blender evidence arrives. Fresh renders
remain available for inspection and revision. A complete `inspect_3d_views`
comparison starts with its original working set. A new user turn, explicit
visual release or compaction clears
this optional history. A 413 on an expanded request gets one retry with the
original visual working set.

When a released visual review resumes in the same Astra turn, the original
user attachment is included with the new comparison evidence and its earlier
message retains the recall placeholder. This preserves that earlier part of
the request and still lets the model compare the original pixels with the new
renders.

For OpenAI, the image budget is evaluated after Files conversion or WebSocket
delta extraction. Historical file references do not consume the inline budget.
Model vision tokens still count toward context usage; Pi's existing context
compaction remains responsible for that separate limit.

An omission is a branch-local custom session entry (`ohmygame-image-offload-v1`),
scoped to the inline policy and identified by source entry ID and image occurrence.
Identical bytes appearing again are a new occurrence. Original bytes are never
duplicated in omission entries. Compaction and restart preserve the decisions for
images that remain in the active context. Branch navigation applies that branch's
decisions. Files routes can retain images omitted under an inline policy.

Placeholders include an image ID usable with the read-only `recall_image` tool.
The tool reads the original from the current conversation branch, independently
of the disposable UI media cache. Its result becomes a new image occurrence.

Occurrence mapping follows Pi's wire layouts: merged Responses tool text,
Completions/Gemini tool images promoted to user turns, and Gemini 3 images inside
`functionResponse.parts`. Gemini 3 omissions are added to the function response's
text output; its image-only parts are removed instead of receiving invalid text parts.

PNG screenshots and opaque `read` images above 256 KiB Base64 receive a cached
JPEG quality-80 request preview when it is smaller. This also applies to old
conversation images. Pixel dimensions are preserved, including the coordinate
relationship in existing screenshot metadata. Read images with alpha channels
or palette transparency remain PNG, and disabling Pi's image auto-resize disables
read previews. User attachments and recalled originals keep their encoding.
Preview identity includes the original content and codec policy version, so
repeated requests have a stable prefix. A single Photon codec handles screenshot
and read previews; Sharp remains a development-only fixture dependency.
[#201](https://github.com/WhiteTowerAI/ohmygame/pull/201) supplies shared format
detection and correct generated filenames without re-encoding canonical reads.

## OpenAI continuation and Files lifecycle

Pi continues to build payloads, resolve credentials and parse Responses events.
The transport converts native WebSocket events to the SSE stream expected by the
existing adapter. After successful Pi parsing, its own assistant serializer
establishes the next continuation prefix, preserving reasoning signatures and
tool IDs. Continuation stores the prefix length and SHA-256 digest, rather than
retaining another full historical image payload. Edited history, changed tools/model, compaction and image omission
cannot reuse a mismatched prefix. A missing response ID gets one fresh replay.
Connections rotate after 55 minutes and close after two idle minutes or disposal.
Background cache warming is disabled when WebSocket is selected to avoid independently advancing the
connection-local conversation or replaying large historical inputs.

Only Platform API keys (`sk-`) can use the official Files route. Vision files are
requested with a seven-day expiration, cached by credentials, organization,
project and image content/type, and verified after five minutes. Uploads have a
120-second timeout, at most four concurrent workers, and shared pending work with
per-caller cancellation. Explicit missing/expired file errors invalidate the
matching cache generation and get one recovery attempt. Unrelated provider errors
are returned unchanged. Failed uploads back off for five minutes; fallback still
has to fit the inline budget.

File references are committed to the request only after every upload succeeds,
so partial failure needs no additional full-payload clone for inline fallback.

HTTP 413 and WebSocket 1009 trigger at most one additional image reduction, which
must remove an image before another inference request is sent. They never retry
an unchanged oversized payload or blindly switch that payload to HTTP. Budget
checks run outside Pi's error-swallowing extension hooks. HTTP adapters check at
the final request boundary; Google and other SDKs without custom-fetch support
check after the payload callback instead. Legacy Codex also checks before its
native WebSocket path. Extensions that add untracked oversized images cannot
bypass the guard. Normal HTTP requests do not repeat the same budget in both hooks.

## Validation

`test/session-images.test.ts` covers byte/count thresholds, canonical preservation,
branch and occurrence identity, recall, custom and Bedrock binary images, stable previews and DeepSeek
exemption. `test/openai-session-files.test.ts` covers persistent credential/project
isolation, verification, stale IDs, concurrent upload cancellation and fallback.
`test/openai-session-transport.test.ts` covers delta input, reconnection, missing IDs,
pre/post-stream failures, 1009, explicit SSE, custom endpoints and cancellation.
`test/session-image-requests.test.ts` exercises actual Pi session serialization and
stream parsing against a fake WebSocket, plus final extension-payload enforcement.
It verifies midstream disconnect/timeout recovery over SSE, bounded retry,
cancellation, provider rejection handling and preservation of completed tool results
without executing tool calls from failed partial responses.
It also checks Google's payload guards and that normal HTTP budgeting runs once
per send or deliberate size-recovery attempt.

Tests use synthetic providers and local fixtures. They do not spend model credits
or establish successful live subscription/API inference. Release verification
should also exercise the user's real proxy and account with continuous captures,
then disconnect/reconnect and resume the conversation.

Official contracts:

- [ChatGPT plan usage limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)

### Offline long-repair regression

Run the recorded Kunpo/Blender session from the repository root. Use the local
Pi session JSONL, the daemon log and the matching usage CSV. Keep the session
with its retained project files and Blender job receipts so the replay can check
the approved snapshots and the exact versions of the scripts or configurations.

```sh
node --import tsx scripts/replay-long-repair.mjs \
  --session "$session_file" --requests "$daemon_log" --billing "$usage_csv" \
  --direct-model-report --output "$new_report"
```

The regression reconstructs the wire input, checks each newly observed image byte
and order against the prior projection, and validates both complete approval
sets. It checks that a later review leaves the original feedback message alone,
that retiring renders preserve the previous request prefix in the recorded cases,
the delivery handoff retains the inspected source triangle count, and folded
Blender calls use the same recipes. A stub replaces the Blender worker. The
replay does not contact Kunpo or Tripo.

The report separates actual CSV charges from estimates for both application
versions. The direct report scenario checks the retained Blender measurement
and the selected Canvas asset and replaces the two recorded face-count requests
with the same local answer the application records. Estimates keep recorded
output tokens for requests that still go to the provider and compare recorded
cache reuse with the case where Kunpo reuses a newly matching complete request prefix. It also reports
chronological calibration errors and the largest remaining write estimates.
The CSV covers the billed comparison interval. Earlier requests in the same
session still take part in the image regression and prefix comparison.
