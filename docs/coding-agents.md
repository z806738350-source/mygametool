# Coding agents

The local controlled-agent sections below take precedence over the upstream
framework reference. Codex and the first-stage Qoder connection have separate
controlled startup paths. Claude Code, OpenCode, external MCP, plugin execution
and the arbitrary host-execution switch remain disabled.

## Local secure edition: controlled Qoder (first stage)

**Settings → Agents → Qoder** adds an optional main conversation agent. It starts
disabled and is offered only in Settings and the existing conversation model
picker, not first-run setup. Enabling Qoder does not switch existing
conversations, rewrite project defaults, change Kunpo credentials or media
selections, or reroute Asset Canvas text generation. Project-level Agent defaults
still use their existing contract; this stage does not add Qoder to that field.

This source connection accepts only the statically reviewed macOS arm64
artifacts: **Qoder Agent SDK 1.0.59** and its paired native **CLI 1.1.83**. The
isolated installations are under `.runtime/qoder-sdk/1.0.59/` and
`.runtime/qoder-cli/1.1.83/`; the repository's root dependencies are unchanged.
The executable and SDK entry are checked before startup. Detection does not run
candidate executables or login shells. Another version, platform or artifact
needs a new compatibility review; a matching version string is insufficient.
The SDK's default installer, shared-daemon selection and automatic runtime
downloads are not used by this connection.

An owned helper process loads the SDK with a minimal environment and starts an
explicit private process daemon. Separate `HOME` and `QODER_CONFIG_DIR`
directories keep this connection's sign-in and history apart from `~/.qoder`,
shell startup files and other applications. User/project/local settings,
discovered Skills, plugins and external MCP are not inherited. The helper gets
no Kunpo key, OhMyGame daemon token or ambient model credentials. The runtime
still handles its own authentication and model network connection; these tool
restrictions do not establish a complete OS sandbox for that runtime.
Startup settings disable the reviewed update/statistics paths and the helper
sets `OTEL_SDK_DISABLED`. Qoder's authenticated data policy can affect native
statistics behavior; these controls do not certify that every telemetry path is
disabled. The offline verification used an OS network denial as its hard boundary.

Only the existing OhMyGame project tools are registered through the SDK's
in-process MCP control channel, including guarded project read, write, edit and
search tools. Writes recheck pending source review inside the project write lock;
image reads follow the selected model's image-input capability. Rejected controlled
tools keep their original result and trusted preflight reason before the native
loop is stopped. A known protected-boundary rejection is reported as such rather
than as an unknown provider outcome; it still blocks automatic continuation.
The read-only `ls`, `find` and `grep` tools accept an omitted or empty directory
path as the project root, equivalent to `"."`. File reads and writes still
require a file path. Absolute, parent, private and linked paths remain blocked.
Native file, shell, network, subagent and plugin
tools are excluded; Full access and the global execution switch stay off. Before
sending a prompt, the helper checks the actual runtime version, working
directory, tool inventory and MCP status against that session's controlled
surface, and fails closed on a mismatch. CLI 1.1.83 also reports its registered
`general-purpose`, `Explore` and `Plan` names when the native `Agent` tool is
unavailable. These known directory entries are metadata; the exact active tool
inventory and both permission callbacks still deny native Agent execution.
Unknown directory entries are refused. Planning restrictions, project/path
validation, file-review approvals, recovery, cancellation and Kunpo media
handlers remain daemon-owned. Duplicate calls must reuse the original result;
an uncertain media outcome must be recovered by its original ID rather than
submitted again. Qoder's file rewind does not replace OhMyGame checkpoints or
retained-file review.

The session Skill allowlist does not disable native discovery: CLI 1.1.83 can
still register its built-in `imagegen` Skill. The helper therefore also sends
`settings.skills.enabled: false` and continues to require an empty discovered
Skill inventory. Native media Skills stay unavailable. MCP status is checked
against the CLI's fully qualified `mcp__ohmygame__<tool>` names. Older native
contexts rebuild from the shared transcript when this startup policy changes.
The CLI injects `mcp_list`, `mcp_get` and `mcp_call` outside its built-in
`--tools` filter, even with MCP lazy loading off. The helper explicitly denies
these three generic entry points; the exact active inventory must still consist
only of the session's qualified project tools. Native permission rules filter
the denied names out of both active tools and model declarations.
The daemon also emits a complete `system.init` snapshot before each user turn.
Every snapshot must retain the same session ID and pass the full inventory,
working-directory and permission checks. A matching refresh is consumed without
rebinding the conversation, forwarding another UI initialization, releasing more
input or clearing tool-call IDs and cached results. A changed boundary after
input stops the turn and retains existing results; its error does not claim that
no prompt was sent. Fixed helper-authored protocol reasons can be shown in CLI
details while arbitrary SDK diagnostics remain opaque.
Qoder's completed `assistant` frames can contain one original content block:
their local `content[0]` index can differ from the preceding stream index.
The adapter reconciles text using the native message ID and tracked stream-block
identity, including completion before `content_block_stop`. Unstreamed frames
use their envelope UUID, and independent blocks or messages with identical text
stay independent. Final text also updates the retained stream buffer so later
stop/turn completion cannot truncate it. This does not rewrite historical
conversation entries or deduplicate text by content.

**Prepare sign-in command** returns a command for this independent configuration.
OhMyGame only displays and copies it: it does not execute it, open a sign-in URL
or import an existing login. When ready, run the displayed command yourself and
complete Qoder's authentication, then return to **Check again**. After the
compatibility and account checks succeed, enable Qoder and choose an available
Qoder model for the intended conversation. Account or billing information that
cannot be established stays unknown. Native model and effort availability must
come from the runtime, not an old hard-coded tier list.

The fixed SDK and native runtime completed an unauthenticated daemon handshake
and cache-only model lookup in a fresh temporary configuration under a macOS
sandbox that denied all network connections. No user prompt or fabricated
credential was supplied. Session initialization correctly required authentication.
Later, existing logs from the user's authenticated attempt showed a successful
session and MCP setup followed by a local inventory rejection before any prompt.
The registered Agent metadata was mistaken for executable tool permissions, and
the app factory had omitted guarded file tools. Both paths now have regression
fixtures using the native initialization shape and the real app session factory;
they make no Qoder or Kunpo requests. Runtime compatibility failures retain a
safe diagnostic category instead of always suggesting another sign-in. Older
Qoder context registries rebuild from the shared transcript on the next session.
Further checks use the installed, pinned SDK through the real helper's stdio
path and a local protocol daemon, rather than replacing `sdk.query`. They cover
the implicit plan-mode control, qualified MCP status, model-policy callback,
permission and hook IDs, tool results, inventory rejection and malformed frames.
Their fresh configuration has no credentials or account data. Node network APIs,
workers and unrelated child processes are denied inside these fixture processes;
this is not a new OS-sandbox acceptance of the native CLI. A boundary failure is
retained before SDK iterator cleanup so cleanup cannot replace it with a generic
SDK error. Diagnostics expose only finite failure categories, local startup
phases and mismatched boundary names, never raw SDK messages or auth payloads.
Real inference, media, billing and the updated desktop application have not been
accepted. This stage keeps the checked Qoder account and model catalog in process
memory. Restarting the app does not delete the separate CLI authentication
store. When Qoder is enabled, the first account or model-list read after restart
automatically verifies that existing sign-in and refreshes its model catalog.
Concurrent reads share one check; it does not construct a model query, submit a
prompt or sign in again. Loading settings alone and reading a disabled agent's
status remain passive. A failed automatic check is retained for this app session,
without background retries; **Check again** explicitly retries it. No cached
signed-in assertion is restored from disk. A failed account check stays unknown, rather than
claiming sign-out. If the account check succeeds but the catalog check fails,
the account remains signed in and models stay unavailable until rechecked; a
conversation cannot start with a model absent from the verified current catalog.
The helper does not inherit proxy environment variables or change system/TUN
settings. It currently supplies no SDK proxy override; Qoder's direct connection
and the application's provider proxy configuration are separate paths.

The SDK and runtime are not assumed to share an MIT or Apache redistribution
license. Commercial redistribution, a shared billing identity and service
resale remain outside this local stage and need a separate review of the
[Qoder service terms](https://qoder.com/product-service) and
[application integration requirements](https://docs.qoder.com/cli/sdk/integration-scenarios).
The SDK supports several authentication identities; this connection uses the
independent [CLI sign-in](https://docs.qoder.com/cli/sdk/authentication), without
distributing organization credentials in the app.

## Reference images, retained originals and visual verification

Kunpo, Codex and Qoder share the application's attachment store. Supported small
images accompany the initial message as image blocks; attachment descriptions
and file names are metadata, not evidence that a model understood the pixels.
The timeline therefore says **Image attached**, including for historical turns.
It does not report that a model viewed or understood an image.

The host supplies canonical `attachment:batch/id` references for readable UTF-8
text and PNG/JPEG/WebP image attachments. Use `read_attachment` with the exact
reference; the controlled `read` tool also accepts it where registered. These
receipts are authorized by host-written prompt details bound to a real user
message on the current conversation branch. User-authored attachment markup,
another conversation's receipt, and receipts excluded by branching grant no
access. Images are returned whole, with a 20 MiB limit and format, decode,
stable-file and secret checks. Neither path grants arbitrary host paths, URLs,
hidden-directory access or writes. The Codex VM still cannot read host `.data`.

`generate_image` and `generate_reference_image` also accept these exact current-
branch receipts in `imagePaths`, alongside project PNG/JPEG paths in the requested
order. Attachment references keep the 20 MiB limit, complete decoding, secret,
stable-file, cancellation and branch-authorization checks. Canvas retains the
uploaded original as a reference source before dispatching the existing generation
job; repeated calls retain the existing billing and recovery protections. Reading
or listing an attachment alone never submits it for generation. `maskPath` still
requires a project PNG. WebP attachments, URLs, host paths, filenames and session
image IDs are not accepted as attachment generation references. Older images
without canonical receipts can still be inspected with `recall_image`; do not
invent a receipt or silently regenerate them.

Transparent-image quality is judged by intended use, including for Sunburst and
Flare. Requesting a transparent background does not guarantee perfect matting;
an alpha flag or a small number of low-alpha pixels alone is neither approval
nor grounds for another paid generation. Inspect the affected location and
area, alpha distribution and edges over light, dark, checkerboard and game
backgrounds at display scale. Preserve antialiasing, hair, shadows and intended
translucent effects; RGB values under zero alpha are not a visible background.
There is no universal alpha cutoff. Prefer reversible local cleanup in a
separate derivative for a verified visible defect, retain the original and
frame geometry, and require actual quality evidence and a reason suitable local
repair cannot meet the requirement before proposing regeneration. These are
agent instructions, not an automatic cutout filter or a guarantee of model
compliance.

`recall_image` reads an original image block retained on the current branch,
including older screenshots and images whose large request copies were
explicitly omitted. Native continuation and context rebuilding receive a bounded
list of branch-local image IDs, with an explicit omitted count; the list contains
no pixels. Agents must call `recall_image` before relying on earlier visual
details. Old image attachments without canonical file receipts can still use
their retained session image IDs. Restoring or switching an agent does not
automatically resubmit image generation or resend all historical images.

Saved isolated-review images use the separate controlled `read_image` action
on `recover_isolated_changes`, with the exact review, listed path, raw/working
variant and source hash. It returns actual image content only for a model with
verified image input. A bounded display proxy carries separate source/display
identities and an explicit proxy flag; it does not alter the original or working
asset. The response explicitly reports that no fresh guest state or adoption
approval is established. This does not turn metadata into a visual receipt or
prove that a remote provider understood the pixels. See
[retained image inspection before adoption](isolated-storage-lifecycle.md#controlled-review-and-adoption-of-a-legacy-batch)
for the size, queue, cancellation and saved-artifact boundaries.

The controlled tool registries use `controlled-codex-v14` and
`controlled-qoder-v13`. Older native contexts rebuild from shared history only
on the next user turn. Updating the application does not start another model
request, replay a prior turn or tool call, or upgrade old receipts, approvals
and generation contracts.

The main Agent can call `recover_isolated_changes` with only
`action: "plan_first_allocation"` to compare current workspace metadata with
the real legacy and versioned runtime capacity envelopes. It should distinguish
observations and incomplete scans from the person's unmeasured future workload,
and never infer memory, GPU capacity or frame rate from encoded file size. This
read-only comparison does not select or allocate a volume, establish guest
capability or approve migration. An unallocated volume does not establish that a
project is new; a separate native plan and approval remain necessary for a
versioned profile. See [execution storage lifecycle](isolated-storage-lifecycle.md).

A connection without verified image input fails before a native model turn when
the branch contains images. Codex preserves `model/list.inputModalities` from its
live catalog; missing or malformed capability metadata stays unverified.
Qoder also checks the actual target model's visual
capability in each SDK model-policy callback, covering initial, recalled and tool
images and resumed contexts. Unsupported GIF input and invalid image envelopes
fail with an image-input diagnostic; originals remain unchanged. Model metadata,
image upload success and offline protocol tests do not prove that a remote model
actually fetched or understood an image.

Agents must report image access from actual returned content. Text ID receipts
are separate from image blocks and do not establish that only text was returned.
OhMyGame does not supply generated image captions in these read results. The
provider's internal preprocessing is not observable here; do not invent a
captioning service, a disabled image context or pixel-level measurements to
explain uncertainty. State what visual content could be verified and what remains
unknown. Existing readable attachments do not need another upload for inspection.

For a private-data-free visual acceptance check, prepare two small raster images
with independently randomized colored shapes and a short random marker. Keep the
answer key outside the project and all agent-accessible context. Remove EXIF,
use unrelated file names, and include no answers in the prompt, alt text or file
metadata. Ask each chosen Agent to report grid positions, shapes, colors and the
marker, and to say explicitly if pixels are unavailable. Compare direct
attachment, restart followed by recall, and a second-image substitution; add a
text-only negative control. Record transfer evidence separately from answer
accuracy. Run local mock transports first. Any real-provider checks require a
separate authorization and request budget, with no automatic retries or media
generation. No live visual acceptance was performed for this change.
A separate local integration exercised saved pixels through the actual backend,
tool, native-session/shared-history reload, recall and request serializers, while
CLI/SDK transports and private-lease bookkeeping were mocked. It made no provider
request and did not establish live-model vision, full-resolution quality or
native approval; GLB parsing was separate from that image fixture.

3D metadata and saved provider results are likewise not visual or playback
acceptance. Native agents use the same controlled media/recovery tools; a local
GLB inspection or merge failure does not authorize another paid generation. See
[local model inspection and recovery](canvas-agent.md#local-model-inspection-and-retained-results)
for the bounded daemon reader and retained local-result boundaries. Meshy calls,
including remote recovery, are disabled across Agent tools and recognizable
custom Meshy connections. Existing assets and receipts remain; a local read is
not a provider retry. Already local output can be delivered through a persisted
ToolRun/runId only with the original tool/context and existing permission and
integrity checks. A raw task ID/receipt cannot poll or download Meshy, and missing
local output is not promised recoverable. Choose Kunpo Tripo explicitly for a
supported new workflow; old Meshy selections are not silently remapped. Use actual saved clip names
rather than requested action labels; structural compatibility is not proof of
motion semantics.
That reader does not cover browser/model-viewer texture decoding, FBX parsing
or GPU/FPS; a worker heap setting is not a whole-process memory limit.

## Local secure edition: controlled Codex

**Settings → Agents → Codex** provides an optional main conversation agent.
It starts disabled. Sign in only when ready, then check again, enable Codex and
choose a Codex model in the conversation's model picker. Enabling it does not
change existing conversations or their models, project media models, or the
Kunpo credential. Asset Canvas text generation still uses the configured text
model; generated images, video, audio and 3D keep using the existing project tools.
The independent Codex image provider remains disabled.

The built-in `openai` provider selects its endpoint for the active authentication
method. The controlled connection leaves `openai_base_url` unset and rejects
an inherited override; ambient API keys and endpoint environment variables are
not forwarded. ChatGPT CLI sign-in must not be forced onto the Platform API
endpoint. This does not create new API permissions or change account billing.
See [OpenAI's authentication routing guidance](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway).
The first turn after this routing correction rebuilds older native contexts from
the shared conversation history, so saved endpoint overrides cannot survive a
resume. Existing messages, project files and media are retained.

The daemon uses its own `agent-runtimes/codex-home` for Codex authentication and
history, and an empty `codex-host-home` for HOME. It never imports `~/.codex`,
ambient API keys, shell startup files, user MCP servers, hooks or plugin Skills.
A browser sign-in is started only by the explicit **Sign in** button. The desktop
opens its OpenAI HTTPS link through a dedicated Codex IPC channel; retired cloud
account authentication stays disabled. While preparing the link, the page shows
progress. Browser-open failures appear near the top of the page and the prepared
link remains available to open again or copy into a browser. An updated desktop
preload requires saving work and fully restarting the app before this channel
can be used. These messages report link preparation, not successful login. Closing
OhMyGame stops its owned CLI processes. Recheck after completing the browser flow;
no automated login or paid model request is needed to inspect this page.

This initial connection is pinned to the audited macOS native executable
`0.167.0-alpha.3.2`, SHA-256
`a636331ed87605efc4cf84028ac2884a75363f9d10ead63cffb57ea0016d486e`, bundled
inside the installed ChatGPT app. Discovery never executes a login shell. An
unrecognized binary is rejected before version or authentication probes run.
An app update or a different CLI build needs another isolation check before
changing this pin; it is not automatically accepted. Do not select `bin/codex`,
which is a shell launcher; use `CodexCLI.app/Contents/MacOS/codex`.

This CLI uses Code Mode's separate V8 runner to dispatch project tools through
`functions.exec`. The controlled connection enables that runner with in-process
fallback disabled and verifies its SHA-256
`c0285b76616ed906bfcbb353fe46f64dcbc577113fc8836f9ab6da530438dbdc`.
Only the `ohmygame` namespace is registered for project tools; native `functions`,
`collaboration`, `web` and `clock` namespaces are excluded from nested dispatch.
This JavaScript runtime has no Node, filesystem, subprocess or network APIs.
Its project operations still pass through the same validated host bridge,
planning permissions, cancellation and Kunpo generation handlers. Native shell,
patching, external MCP, plugins and the global execution switch remain disabled
or denied by the existing permission profile. Native tool notifications do not
duplicate the host's structured tool result or replace its artifact metadata.
Older tool registries are rebuilt from shared conversation history on the next
turn. This protocol is experimental and remains pinned to the audited CLI and
runner; a successful local mock does not establish real-provider media success.

Codex's project tools use the existing stdio dynamic-tool bridge, now including
OhMyGame's guarded file tools. No arbitrary HTTP tool endpoint is opened.
Native shell, network tools, image generation, MCP, plugins, browser, computer
use and child agents are disabled in startup configuration. The remaining native
`apply_patch` is confined to a read-only private session directory; project,
credential, application-data and shared temporary paths are denied. Permission
and sandbox escape requests are always declined. Full access is unavailable.
These settings do not sandbox the app-server process itself; the audited CLI
still handles its own OpenAI authentication and model network connection.

A conversation retains its Codex thread ID in the common transcript. Restart,
model change and native-session expiry use the existing resume/handoff path;
legacy native contexts without the controlled-policy version rebuild from the
common transcript so their old tool inventory is never reused.
Finished tool artifacts remain available on the canvas. Tool requests must
belong to the active thread/turn. Duplicate call IDs reuse the original pending
or completed result, while mismatched arguments are rejected. Planning uses the
existing read-only tool set, and cancellation refuses later calls. Media journals
and recovery tools retain their existing safeguards for uncertain outcomes;
changing an agent does not authorize repeating a paid generation.

Game inspection and capture are read-only observations. A playtest batch stopped
at click-target lookup reports exactly how many earlier actions completed and
that the failed click sent no player input. This confirmed stopped outcome can
continue in the Agent loop, but the owned session requires a successful
`game_use inspect` before another `act`; capture alone does not clear it. Inspect
fresh state and issue only the remaining intended actions. Dispatch failures,
timeouts and missing or inconsistent action progress remain unknown and must not
authorize a replay. Progress crosses the private desktop IPC only when bound to
the original request, session, action type and index. Error text or untrusted
JSON properties are not progress evidence.

Opening a fifth retained playtest window is rejected before window creation.
The host carries this bounded capacity rejection through private IPC as trusted
preflight evidence. It is correctable and does not leave an unknown open that
blocks later automatic continuation. Existing windows and the four-session limit
remain intact. The error lists only references owned by the current conversation;
they may have expired. Inspect and reuse a suitable session, or close only a
finished owned session before a new open with a new call ID. The tool never
automatically closes windows or repeats the rejected open. Other open failures,
untrusted error fields and isolated effects from preview preparation retain their
existing safeguards. Old unknown records are not upgraded from matching error text.

Every `open` allocates an independent player window. Reuse an owned session for
inspection and input; `inspect` and `resize` do not reload changed game code.
When a fresh version requires a new open, close finished owned sessions rather
than accumulating revision windows. The native window close button hides agent
players; `game_use close` actually destroys its window. Hidden or minimized
players are frozen and muted between tool requests; this can leave allocated
WebGL resources in memory and is not proof of released GPU memory. Idle hidden
sessions are destroyed after ten minutes; this idle timer preserves watched
windows and active tool requests, and hiding starts a new idle interval. Run
completion, failure or cancellation separately cleans up that conversation's
owned sessions. Stopping a preview server alone is not a player-window close.
The tool never
evicts another conversation's windows or a window the user is watching to make
room for a new open.

DOM snapshots and semantic target matching normalize whitespace consistently,
including line breaks and non-breaking spaces. Multiple visible matches are
ambiguous: use a unique selector or test ID. Hidden targets are not a fallback,
and disabled click targets do not receive input. A snapshot is an observation at
one point in time; inspect after a stopped batch rather than assuming the page
is unchanged.

Canvas recovery attempts retain the exact observed job ID even when no result is
available. A host-verified recovery rejection before job execution is correctable
and allows other work to continue; it does not settle the original generation or
its possible charge. The Agent can read compact `canvas/jobs.json` metadata
without transferring embedded retry images into its source budget. See the
[Canvas file contract and media recovery](canvas-agent.md) for the private input
store, cancellation limits and preservation of failed nodes.

The [app-server dynamic-tools protocol](https://learn.chatgpt.com/docs/app-server)
is experimental. Startup checks configuration and the active filesystem profile
before a turn, failing closed on incompatibility. Tests use an in-memory CLI,
mock Kunpo artifacts and temporary projects. The installed native CLI and V8
runner were also exercised through the compiled driver against a loopback fake
model. Code Mode called guarded file tools, returned a mock Kunpo artifact once,
and completed a mock playtest; its nested registry contained only project tools.
The fixture kept production file permissions and skipped only empty temporary
project-instruction discovery to avoid nested macOS Seatbelt helpers. These
checks do not verify real-provider media, billing or commercial distribution
rights. An earlier native patch check also confirmed that a denied file could
not be read or altered.

To connect, open **Settings → Agents → Codex**, inspect its executable/status,
click **Sign in**, complete the browser flow yourself, return and **Check again**,
then enable Codex and choose its model for the desired conversation. Native CLI authentication is described in
[OpenAI's account flow](https://learn.chatgpt.com/docs/app-server). OpenAI documents
separate [ChatGPT plan usage for locally hosted/open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
and asks paid or hosted products to register interest. The open-source harness
license does not establish subscription reuse or redistribution rights. A
commercial release needs a separate review of the chosen authentication and
billing arrangement; this work does not implement a commercial OAuth client.

## Upstream framework reference


A conversation can run on a coding agent CLI that is already installed on the
computer: Claude Code, Codex, or OpenCode 2.1.0 or newer in the 2.x series.
OpenCode v1 is no longer supported. The CLI runs the agent loop with its
own sign-in and model. OhMyGame keeps the conversation, checkpoints and Undo,
its canvas, media, game and plugin tools, and the approval decisions.

The [integration specification](agent-runtimes.md) records the architecture,
accepted tradeoffs, and validation limits.

## Using one

First-run setup also offers Claude Code, Codex, and OpenCode in one
horizontally scrolling row. Select an agent after installation and sign-in, choose its model
on the same connection screen, then save with **Next** and continue to optional
creative tools. Switching agents retains each selection until it is saved. OhMyGame
(Pi) is always enabled and uses connected model providers. Discovery alone never
enables a CLI.

**Settings → Agents** lists who can work in a conversation. OhMyGame's own
agent comes first: it uses the models set up in Providers & Models, and its row
links there. The coding agent CLIs follow, under **Coding agent CLIs on this
computer**; **Rescan** checks for them again. Each row shows whether the CLI
was found and its version; the detail page shows its account, billing, and a
verified version for reference. The verified version records a real acceptance
run and is not a minimum version. The agent whose model new conversations start with is
marked **Default**.
Agents are off by default. Enabling the switch offers their models in the conversation model picker; the
detail page signs in, checks again, chooses the executable and permissions, and
explains that the CLI loads the person's existing configuration.

On macOS, discovery includes the CLIs bundled with Codex and ChatGPT in
`/Applications` and `~/Applications`, as well as PATH, the login shell's PATH
and usual CLI install folders. The detail page shows the resolved executable
and where it was found. With several installations, the newest version wins;
equal versions keep discovery order. A manually selected executable takes
precedence even when another installation is newer.

On Windows, discovery also checks Codex's versioned desktop installations under
`%LOCALAPPDATA%/OpenAI/Codex/bin` and the native executable inside npm installations
on PATH or in the usual npm folder. Selecting an npm `codex.cmd` or `codex.ps1`
path resolves its adjacent package's native executable; the shell shim is never
executed. Both current platform packages and older `vendor/` layouts are supported.
Other `.cmd`, `.bat`, and `.ps1` scripts are rejected before settings are saved.
A Codex shim whose native package is missing is reported as an unavailable
manual installation and is never executed or replaced with another installation.

An undetected CLI is not necessarily uninstalled. Choose its absolute executable
path for a custom installation, or leave the path field empty and save to restore
automatic discovery. An unavailable manual path is reported explicitly rather
than silently switching installations. **Rescan** and **Check again** refresh the
login shell's PATH and probe caches, so installing a CLI or changing shell setup
does not normally require restarting OhMyGame. Discovery, CLI startup, protocol
compatibility and sign-in are separate checks; finding a bundled CLI does not
guarantee that its version supports OhMyGame's integration.

If Codex is found and signed in but offers no models, check the diagnostics on
its detail page. Model discovery first verifies the permission profile by
starting an ephemeral thread without a prompt. On Windows, the probe,
conversations, and image generation use `:root` read access because the elevated
sandbox rejects `:minimal` access. Protected paths remain explicitly denied.
If thread creation still reports `elevated Windows sandbox requires effective
:root read access`, OhMyGame identifies a compatibility failure before requesting
the model catalog; update Codex and check its sandbox configuration.
Windows' legacy `unelevated` sandbox can also reject filesystem read restrictions.
OhMyGame reports this as a Windows sandbox compatibility issue and links to the
[Codex Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).
For the legacy sandbox error, configure the `elevated` sandbox in Codex
(including its administrator-approved setup), or use MXC with a supported device
and CLI, then choose **Check again**.
OhMyGame does not change the saved sandbox configuration. The Windows profile
permits general filesystem reads while preserving explicit protected-path denies
and workspace write restrictions. A successful model probe still
requires a real conversation test on the target Windows installation.

![Codex settings showing the desktop-bundled executable and automatic detection](assets/codex-cli-discovery.png)

The model picker lists each agent's models in a group named after the agent.
Each CLI group shows its brand icon; the conversation's model button keeps the
same icon beside the selected model name.
Choosing one runs the conversation on that agent. A model reference names both:
its provider is the agent's ID (`claude-code-cli`, `codex-cli`, `opencode-cli`),
its ID is the agent's own model name, such as `sonnet` or
`anthropic/claude-sonnet-5`. The `-cli` suffix keeps these apart from Pi
providers of the same name; Pi has its own `opencode` provider.

![Agent brand icons in the model picker and composer (sample data)](assets/model-selector-agent-icons.png)

`GET /models` lists Pi's models only, for canvas text and other one-off
generation. Conversation pickers ask for `GET /models?runtimes=1`, which adds
the enabled agents' models. An agent that is slow to list them is named in
`loadingRuntimes`, and the picker asks again shortly. A new conversation in a
project keeps the coding agent the person was using; with no model provider
connected, the first conversation starts with the first agent that is set up.

Native effort/variant strings are exposed as `nativeReasoningLevels` and stored
separately from Pi's reasoning enum. Saving a native default keeps both model
and effort as `defaultModel` in `agent-runtimes.json`; it applies while that
agent is enabled and offers the model. Choosing a Pi default clears it. Plain
`GET /models` continues to report Pi's default for one-off generation.
An explicitly chosen different model does not inherit an incompatible effort.
Context usage uses the native context window when reported. Stored assistant
messages record the latest model request's usage, as Pi's own messages do,
rather than a turn's or thread's running total, so a conversation that moves
back to Pi does not look larger than it is. Missing measurements remain unknown
rather than being inferred from token totals.

An account's quota windows show in **Settings → Agents**: a bar per window in
each agent's row (5-hour, weekly), labeled as used. The detail page adds reset
times. In a conversation they stay out of the composer and appear only
under the commands when `/` is typed, with compact percentages and a tooltip
on each window stating the share used. A conversation shows the account's latest
report, so it has them before its own first turn. Codex reports them whenever its
models are checked and while it works; Claude Code reports them during a
conversation (its `rate_limit_event`), so they appear after its first one.
The latest report is kept in `agent-runtimes/limits.json`, and a window whose
reset time has passed shows as empty. OpenCode bills each model provider and
has no quota of its own.

![Claude Code and Codex quotas labeled as used (sample data)](assets/agent-usage-used-label.png)

![Compact quota percentages in the slash menu (sample data)](assets/agent-usage-compact.png)

![Codex conversation with a denied read, a cancelled turn, and Medium effort selected](assets/coding-agent-native-effort.png)

## Codex as an image provider

**Providers & Models → Codex CLI** exposes one image entry, **Codex Image**,
using the installed CLI and its saved sign-in. Its image switch is independent
of the Codex conversation-agent switch in Agents. Any chat agent can use it
through `generate_image`; canvas image nodes and global/project image defaults
use the same provider. Choose the global image default in the Providers & Models
overview. The Codex CLI detail page shows its image status and model without a
default-model selector. Closing a terminal does not disconnect the provider.

![Codex image provider connected through the saved CLI sign-in (sample data)](assets/codex-image-provider-settings.png)

![Codex Image selected in the asset canvas](assets/codex-image-canvas.png)

The image connection follows the installed CLI's saved sign-in. A signed-in
account exposes **Codex Image** without a separate image-capability probe or
inference request. Missing CLI or sign-in keeps the entry visible with a
diagnostic. The detail page offers **Sign in** only when the CLI reports a
signed-out account. **Check again** refreshes the saved sign-in, including when
image generation is disabled. Image access, compatibility and usage-limit errors
are reported by the generation request, without switching providers or
retrying inference automatically.

The provider list and first-run setup return the last known sign-in status
without waiting for the CLI. Enabled image providers refresh that status in the
background; disabled ones do not start a check.

Each generation starts its own ephemeral app-server thread, with no OhMyGame
dynamic tools, external MCP servers, shell tools or subagents. The process is
started on demand and stopped on completion, failure or cancellation. Multiple
reference images are passed in order as inline image inputs, without staging
reference files; the app's shared 16-image limit applies. Codex manages the
actual image model and dimensions, so the canvas hides resolution and
aspect-ratio controls for this provider. Built-in Codex chat generation remains
a separate native path; the image provider does not force a Codex chat to stop
using its own tools.

Validation includes simulated canvas-to-Library generation, image-toggle
persistence, failure/cancellation fixtures, and a real image generation with
Codex 0.163.0-alpha.10.2 on macOS while its conversation agent was disabled.

## Branch in new chat

A completed agent response has **Branch in new chat** immediately to the right
of Copy. After confirmation, OhMyGame opens a new chat containing the source
chat's current history through that response, inclusive. Later messages are not
copied. The source chat is unchanged, and either chat can continue independently.
This applies to Pi and all supported coding agent CLIs.

![Branch in new chat next to Copy on a completed response](assets/chat-branch-response.png)

Both chats use the same project's current files. Branching a chat does not
restore older files or create a separate workspace. The new chat receives the
model and settings recorded at the branch point, clears active
plan state, and creates its own native CLI context from a history handoff.

## What OhMyGame keeps

A coding agent session (`NativeCodingSession`) implements the same
`CodingSession` interface as Pi, so `AgentManager` runs it unchanged: queues,
plan mode, cancellation, errors and events are the same code.

- **Conversation record.** Every user message, answer, reasoning block and tool
  result is stored as a Pi message in the conversation's session file, so the
  conversation list, history, message edits and restarts work as for Pi. These
  messages are a record; the CLI keeps its own context.
- **Checkpoints.** The workspace snapshot is taken before each user message is
  stored, exactly where Pi's checkpoint extension takes it, through the shared
  `recordCheckpoint`. Turn changes and Undo therefore cover whatever the CLI
  changed.
- **Native session.** The CLI's own session or thread ID is stored as an
  version-2 `ohmygame-native-session` custom entry on the branch. Only a
  `ready` marker resumes; `active` marks an unfinished turn and `invalid`
  requires a rebuild. The next message
  continues it (`--resume`, `thread/resume`, the OpenCode session). Every edit
  or restore invalidates context, even when the native ID is unchanged. Later
  Pi messages/model changes, cancellation, failure, legacy metadata and
  interrupted writes also invalidate it. An expired native session triggers
  one fresh-context retry with handoff rather than silently losing history.
  Classified safe interruptions also use the shared [bounded continuation](agent-errors.md#automatic-continuation-after-an-interruption)
  protocol after original tool outcomes and task ownership are verified. Failed
  contexts rebuild; continuation does not resend the user message or checkpoint.
- **Handoff.** When an agent joins a conversation it has not seen, its first
  message carries a summary built from the stored record: recent turns and the
  files the earlier agent worked on, bounded tool results with original call/job
  IDs and unresolved-outcome warnings, the structured plan, and restore notices.
  It asks no model, and private context such
  as file references is left out. Moving back to Pi needs no summary; Pi reads
  the stored messages. A native turn reaches Pi as text: what the agent said,
  the tools it used with their arguments, and bounded results. Its tool calls
  are the CLI's own (Skill, subagents, Codex's path-only `edit`), so replayed
  as calls they would read as examples of Pi's tools; its reasoning is left
  out because no other model can verify it.

Terminal approval decisions and native compaction results are custom entries
in the same session file. Reload restores their history without restoring
permission grants. No second conversation manager or event database is needed.

## How each agent is driven

| Agent       | Transport                                                        | OhMyGame tools                                          | Approvals                                            |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Claude Code | `claude -p` with stream-json in and out; one process per session | In-process MCP server answered over the same pipe       | PreToolUse hook plus `can_use_tool` control requests |
| Codex       | `codex app-server` JSON-RPC; one thread per conversation         | The thread's dynamic tools, answered over the same pipe | App server approval requests                         |
| OpenCode    | `opencode serve` on loopback with its own password               | Remote MCP on the daemon with a turn token              | `permission.asked` events, answered on the server    |

Each stdin stays open for the session. A CLI that no message has used for ten minutes is stopped; the next message starts a new process that resumes the same native session. Codex conversations with the same executable, environment and staged Skills share one app server, routed by thread; it stops with its last conversation. OpenCode keeps a server per conversation because its MCP servers, and so OhMyGame's tools, are registered for the whole instance. Native queue prioritization means
**Next**: after the current turn, before ordinary follow-ups. Mid-turn native
injection is excluded because concurrent file writes cannot provide an
independent checkpoint before delivery. Processes run in their
own process group, are registered with the desktop app for crash cleanup, and
are stopped when the daemon closes.

Cancellation checks before/after startup prevent late input delivery. Interrupt
waits are bounded, then the CLI is stopped. HTTP calls time out and loss of
OpenCode's SSE stream fails the pending turn. Standalone startup also reclaims
verified orphan process groups from `agent-runtimes/processes`, checking both
the daemon and child's executable/birth identity before killing anything.
Private folders carry the daemon's ownership identity as well: startup reclaims
verified orphans while preserving another live daemon's folders. Configuration
and Skills are removed only after the CLI stops. Unverifiable identities and
subprocesses that escape their group cannot be reclaimed this way.

OhMyGame's tools are the handlers Pi uses (`createAgentTools`), offered through
`ToolBridge`. Plugin MCP servers reach the agent through the same `mcp` tool
Pi uses, run in a model-less session in the daemon, so plugin settings,
switches and credentials stay in the daemon. Codex registers bridged tools with
an `ohmygame_` prefix to avoid reserved names such as `mcp`; dispatch and the
conversation timeline retain the original tool names. Skills (plugin Skills and
OhMyGame's own) are copied into a private folder for the session and handed to
the CLI: a session plugin for Claude Code, `skills/extraRoots/set` for Codex,
the `skills` array for OpenCode v2. Staging copies regular files and omits symbolic
links, so it cannot copy an external credential through a Skill's link. The
policy permits reading only this session's staged Skill roots, while their
writes and adjacent app data remain protected. Running a staged script still
requires command approval. Nothing is written to the workspace.

The OpenCode tool endpoint, `POST /agent-runtime-bridge/mcp`, takes the
turn's token instead of the app's. It is revoked permanently on completion,
cancellation, failure or disposal; each later turn gets a new token. Bridged
tools receive the turn's abort signal and late results do not enter its timeline.

New plugin capabilities must be expressible as Skills or MCP servers; Pi
extensions do not reach coding agents.

## Approvals and limits

Each agent's detail page has a **Permissions** setting:

- **Standard** (default): the rules below. Commands run in the CLI's OS
  sandbox where it has one.
- **Full access**: no sandbox and no questions, as with OhMyGame's own agent.
  Claude Code runs without its sandbox settings, Codex uses its own
  `:danger-full-access` profile, and OpenCode's requests are all allowed.
  Requests that name a protected root, such as a CLI sign-in folder, are
  still refused, and planning stays read-only.

Changing permissions or the executable path lets go
of the agent's idle open conversations. A running turn keeps its setting and
is released when its run closes. The next run restarts the CLI with the new
settings and resumes its session, including when settings change during startup.

In the project folder an agent works without asking, as OhMyGame's own agent
does. `judgeApproval` decides each request first:

- **Deny** anything that reaches a CLI sign-in folder (`~/.claude`,
  `~/.codex`, OpenCode's folders, `~/.pi`), `~/.ssh` and similar, OhMyGame's
  data folder, OhMyGame's own agent folder (`pi-agent`, which holds provider
  keys and sign-ins and sits beside the data folder in the desktop app), or
  another project. Paths resolve symlinks, including missing descendants,
  and include custom CLI credential homes. A command reaches a folder when it names it or a folder
  that holds it, including quoted paths containing spaces and paths with
  backslash-escaped spaces.
- **Allow** workspace file requests and a small set of simple read commands.
  Claude Code's own tools that touch no file and run no command (`TodoWrite`,
  `Skill`, `Task`, `WebSearch`, `WebFetch` and its background-shell and MCP
  resource readers) also run without asking; a subagent's tool calls are
  checked like any other.
- **Ask** the person for paths outside the workspace and other commands,
  including build scripts, interpreters, Git, compound commands, globs and
  recursive link-following (`grep -R`, `rg -L`). Where Claude Code runs its
  commands in its OS sandbox, which keeps their writes in the workspace and
  protected folders unreadable, only commands that publish or escalate
  (`git push`, `npm publish`, `sudo`, `curl … | sh`) and commands naming paths
  outside the workspace are asked about; installs, builds, Git, pipes and
  compound commands run. Planning still allows only the simple read commands. A request
  Codex makes to leave its sandbox always asks, because Codex only makes one
  when its sandbox would stop the command.

OpenCode's subagents, todo list, Skill loading and web research are allowed in
the same way. Planning turns are read-only on every path: they accept file reads
and the simple read commands the policy allows, and refuse everything else with
feedback naming what is allowed, so the agent adjusts instead of stopping; a
bare OpenCode rejection would end its loop. Native agents are told that
OhMyGame's tools, including `update_plan`, come from its `ohmygame` tool server
under their CLI's MCP names. `questionnaire` is exposed only in planning mode;
recording steps with `update_plan` during a normal turn does not change that mode.
Normal and executing turns omit this tool to match the host's planning-only
guard. Daemon-issued paid-media confirmations still use their separate guarded
request path. Claude's `ExitPlanMode` is
declined with a pointer to `update_plan`, because OhMyGame reviews plans itself.
Codex registers every OhMyGame tool when its thread starts, since a thread that
begins in planning continues after the plan is approved; tools the current mode
does not allow are refused when called.

Claude Code runs with background tasks and scheduled prompts disabled
(`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_CRON`): a
background subagent or shell would report after the turn's result, with no turn
to receive it. OhMyGame's tools are marked always loaded so Claude's tool search
does not hide them. Planning uses Claude's default permission mode instead of
its plan mode, which would write a plan file and call `ExitPlanMode`.

A request the policy leaves to the person appears as an approval card above the
composer: Allow, Allow for this conversation, or Deny. Answered requests stay
in the timeline. Stopping the turn denies every request still waiting.

Explicit permission grants show all read/write roots and network access.
Codex grants only understood concrete paths that were reviewed, for one turn.
Allowing for the conversation covers the exact request, with two exceptions
the card names: a sandboxed `git push` or package publish covers that command
whatever its remote or package, and a read outside the workspace covers its
folder (never the home folder or the disk root). A sandboxed command naming an
outside path covers reads in that folder, since its sandbox keeps writes in the
workspace. Escalations such as `sudo` and `curl … | sh` are asked each time. OpenCode read/edit/search/shell requests are mediated,
with file patterns resolved from its reported Git root rather than assuming
that it equals the application workspace. Search metadata identifies the actual
search directory. Child-session permission requests are admitted only after
verifying their ancestry through the native API; they cannot be dropped merely
because their session ID differs from the parent.

Shell syntax checks cannot resolve globs, brace expansion or links, so a
command a person allows could still name a protected file indirectly. Codex and
Claude Code therefore also run commands in their own OS sandbox (Seatbelt on
macOS, bubblewrap on Linux); the settings page says which agents have one.
When the approval policy relies on that sandbox, Claude Code must stop at
startup if it cannot enable it; it cannot silently fall back to unconfined
commands. This requires Claude Code 2.1.83 or newer. Where the required
dependencies are absent, the strict command approval policy applies instead.
OpenCode has none, so its approvals are its only boundary. Each CLI's parent
process runs as the signed-in OS user and is not confined. Strong
confidentiality isolation requires a separate process/container sandbox and
isolated credentials.

Codex requires named permission profiles and checks that its app server actually
activated the requested profile before delivering a prompt. The legacy
`workspaceWrite` policy is not a fallback: it permits reads outside the project.
The profiles allow runtime files, this workspace and private temporary/Skill
folders, plus the person's toolchains: each folder on the commands' PATH and
the installation it belongs to (an fnm or nvm Node, Homebrew, Bun) and, on
macOS, the command-line developer tools, whose own programs come before the
`/usr/bin` shims. The home folder itself and `~/.local` as a whole are never
granted. Package caches (npm, Bun, Yarn, XDG) live in the session's temporary
folder, Git reads a private configuration holding only the person's name and
email (`~/.gitconfig` may name credential helpers), commands run without a
login shell, and the workspace's `.git` stays read-only. Credential roots, app
data, other projects and the shared `/tmp` and `/var/tmp` folders (which
Codex's minimal access would otherwise read) are denied. Unlisted
paths require a scoped permission request. Unrestricted command/patch sandbox
escapes are refused. Planning uses a read-only profile and cannot accept write
grants. The native `request_permissions` tool is enabled explicitly, with grants
limited to the current turn. Shell snapshots are off and the shell environment
is rebuilt from the same allowlist, without CLI authentication tokens.

Claude Code's sandbox is turned on through flag settings, which apply whether
or not the person's own configuration loads. Protected roots are unreadable,
the workspace and the session's staged Skills stay readable, commands cannot
opt out of the sandbox, approvals still go through OhMyGame, and the network
stays available for installs. Package caches live in the session's temporary
folder, which commands may write. Where the sandbox cannot start (Windows, or
Linux without bubblewrap and socat), Claude Code runs commands without it and
the settings page says approvals are the boundary.

## Environment and isolation

A CLI gets an environment built from an allowlist: PATH, HOME, locale,
temporary folders, proxies, certificates, and that CLI's own configuration
folder variable. API keys are left out, so an ambient key never moves a
subscription to metered billing; Claude Code keeps `CLAUDE_CODE_OAUTH_TOKEN`,
which is a subscription sign-in. The daemon's token and `OHMYGAME_*` variables
never reach a CLI. The executable is resolved to an absolute path from the
person's choice, PATH, the login shell's PATH, usual install folders, and known
bundled copies such as ChatGPT's Codex. On Windows only native `.exe` programs
are started; supported Codex npm shims resolve to the packaged executable because
Node cannot start `.cmd`/`.bat` shims without a shell. An
explicit path wins; automatic
discovery chooses the newest SemVer, including prerelease ordering, and retries
failed version probes. Recheck also invalidates successful probes. Catalog
refreshes honor their TTL and discard results from a superseded configuration.

All three runtimes load the person's existing CLI configuration, including
settings, hooks, MCP servers, Skills and instructions supported by that CLI.
There is no configuration-isolation switch. Stored `isolateUserConfig` values
from earlier versions are ignored and dropped when settings are next saved.
OhMyGame adds its tools, project instructions and staged Skills, and the selected
permission mode still applies. A configured external `ohmygame-studio` MCP
connection is disabled inside Claude Code and Codex to avoid reconnecting to the
same app recursively. Other user MCP servers and notification hooks remain enabled.

Codex keeps the workspace as its project root (`project_root_markers = []`):
parent-folder instructions may live in app data denied by the permission profile
and otherwise prevent thread startup. Its own configuration-folder instructions,
Skills and plugins still load. Configuration inheritance does not remove the
permission profile, shell environment controls or read-only planning.

OpenCode v2 adds callback permission rules, staged Skills and an instruction file
in its private session directory. Its MCP bridge disables code mode so native
calls retain their tool names and structured app results. It waits for the MCP
connection and catalog before sending a prompt. No configuration file is written
to the workspace. Custom `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG` paths are
retained and protected from native file/shell access, alongside XDG roots.

Discovery probes may suppress external MCP servers and hooks while inspecting
protocol compatibility and model catalogs; they do not send inference prompts.

## Settings and API

`agent-runtimes.json` in the data directory stores, per agent, `enabled`
(default off), `permissionMode` (`standard`
or `full`, default `standard`), an optional absolute
`binaryPath`, and an optional native model/effort `defaultModel`. A damaged file falls
back to the defaults. Credentials remain in the CLI's own store.

| Route                                                     | Purpose                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /agent-runtimes`                                     | Status of every agent; `?recheck=1` probes again                       |
| `PATCH /agent-runtimes/:id`                               | `enabled`, `permissionMode`, `binaryPath`         |
| `POST /agent-runtimes/:id/recheck`                        | Probe one agent again                                                  |
| `POST /agent-runtimes/:id/login`                          | Start the CLI's sign-in; returns a browser URL or a command            |
| `PUT /projects/:p/conversations/:c/reasoning`             | Select a native effort/variant string                                  |
| `PUT /models/default`, `POST /projects/:p/conversations`  | Take `nativeReasoningLevel` for a native model, never `reasoningLevel` |
| `POST /projects/:p/conversations/:c/approvals/:requestId` | Answer an approval request: `allow`, `allow-session` or `deny`         |

Status and models are probed only when asked for and cached by executable
signature. Conversation model discovery does not start disabled CLIs; the
image catalog independently probes Codex when checking image providers.

## Adding an agent

1. Add its ID to `AGENT_RUNTIME_IDS` and a definition to
   `AGENT_RUNTIME_DEFINITIONS` (binaries, version arguments, tested version,
   sign-in command).
2. Teach `probeAuth` and `probeModels` how to ask it who it is and what models
   it has.
3. Write a `NativeDriver` that runs a turn and reports through the
   `NativeTurnSink`, and create it in `AgentRuntimeService.createSession`.
4. Add an icon to `PROVIDER_ICONS` and test the driver against a fake process
   (`setAgentProcessSpawner`), as `test/agent-runtime-drivers.test.ts` does.

The Provider, media, canvas, checkpoint and plugin code does not change.

## Compatibility and real acceptance

Compatibility follows the capabilities the adapter needs, rather than a CLI
being older than the version used for acceptance. Settings records Claude Code
2.1.302 and Codex 0.163.0 as reference acceptance versions. OpenCode uses the
v2 server contract, records 2.1.0 as its real acceptance version, and requires
2.1.0 or newer in the 2.x series; the version
check selects that supported API generation, and runtime checks still apply.
Enabling or rechecking an agent uses the same discovery checks as its model
catalog; incompatible agents do not offer models. Results are cached by the
executable signature and invalidated when settings change or **Check again** is
used. Temporary failures remain probe/catalog errors and retry after the short
failure cache expires; they are not classified as unsupported capabilities.

- Codex discovery starts an ephemeral thread with a dynamic tool, OhMyGame's
  approval policy and a named permission profile, and checks the returned
  `activePermissionProfile`. It sends no model turn. The real driver checks the
  profile again on start/resume. Codex 0.162.0-alpha.17.2 has passed this protocol
  probe; that alone is not a full inference or sandbox acceptance run.
- Claude discovery registers the SDK tool server and PreToolUse callback during
  its control handshake, and accepts catalogs from `initialize` or `list_models`.
  Standard permissions on a platform where approvals rely on its OS sandbox
  require `sandbox.failIfUnavailable`, introduced in
  [Claude Code 2.1.83](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2183).
  This documented feature requirement does not apply to Full access or platforms
  using the strict command approval policy without an OS sandbox. An unknown
  version cannot establish that sandbox requirement and remains a probe failure.
- OpenCode discovery starts `serve --stdio --hostname 127.0.0.1 --port 0` with
  a private password and reads its JSON address announcement. It establishes
  `/api/event`, checks `/api/info` and `/api/location`, waits for the agents'
  permission transformations, and lists `/api/model`. This creates no session
  and sends no inference. Real sessions create or reapply a wildcard `ask`
  permission rule and read it back before sending a prompt. Child-session
  requests must have verified ancestry and the same workspace location; file resources resolve relative to
  that session's location rather than the Git root. Saved CLI grants for the
  project can override callback rules, so discovery/startup and each prompt
  refuse them with a diagnostic; OhMyGame never deletes those grants. Remove
  them in OpenCode before retrying. User plugins remain trusted CLI code.

OpenCode v2 native session IDs carry an `opencode-v2:` marker in OhMyGame's
session record. A v1 marker or missing v2 session triggers the existing fresh
session and conversation-history handoff; v1 context is never resumed as v2.

Missing optional quota or reasoning metadata stays unavailable. Local CLI
compatibility failures have their own chat error presentation and CLI details.
Being signed in and seeing a model does not guarantee account entitlement.

![CLI capability diagnostic and reference acceptance version](assets/coding-agent-compatibility.png)

This screenshot uses a simulated CLI reporting `99.0.0` that ignores the
requested permission profile. A higher version cannot bypass the capability
check, and the verified version remains a reference.

The direct adapters preserve the installed executable and shared host services.
The Claude Agent SDK was evaluated and not adopted: it bundles its own Claude
Code binary (about 268 MB per platform) and each release targets one CLI
release, while OhMyGame drives the CLI the person installed. See
[agent-runtimes.md](agent-runtimes.md#runtime-transports-and-compatibility).
Claude's direct control protocol and Codex's experimental dynamic tools need
compatibility tests when their CLIs change. A generic Basic CLI adapter is not
implemented; each new CLI needs discovery, a driver, and acceptance tests.

Run public checks from [CONTRIBUTING](../CONTRIBUTING.md). Focused fixtures cover
branch invalidation, expired resume, queue checkpoint ordering, startup/interrupt
cancellation, bridge token revocation and abort, SSE loss, quotas, model
dialects/defaults, stale discovery results, catalog pagination, planning write
grants, child-session approvals, persisted approvals/compaction and verified
orphan recovery.

Real inference is opt-in and consumes the provider's quota:

On macOS, Codex's command profile includes read-only access to the system
`/System/Library/OpenSSL/openssl.cnf` file so Node/npm can initialize TLS.
This does not grant access to the rest of the system Library.

```bash
bun run test:agent-runtimes:live opencode-cli opencode/mimo-v2.6-flash-free
bun run test:agent-runtimes:live codex-cli YOUR_AVAILABLE_MODEL
bun run test:agent-runtimes:live claude-code-cli YOUR_AVAILABLE_MODEL
```

Choose a currently listed model with a working account. The script uses isolated
app data and a disposable workspace, grants only scoped test requests, and saves
evidence under ignored `.runtime/`. It checks writes, an OhMyGame tool call,
continuation, daemon restart, compaction, editing a later message, checkpoint
restore, denial of external dummy files, approval persistence, cancellation
during an executing shell tool, running the toolchain (Node, `npm install` over
the network and Git), loading a staged Skill without approval, and a
planning turn that records its plan with `update_plan` and changes no file.
Claude Code refuses a standalone `sleep`, so its cancellation step runs an
equivalent `node` command.

Earlier acceptance passed on macOS with Claude Code 2.1.302 / `sonnet` and
Codex 0.163.0 / `gpt-6-luna`. OpenCode 2.1.0 with
`opencode/deepseek-v4.1-flash-free` passed the full live
acceptance on macOS: file edits, direct app tools, native continuation and daemon
restart, compaction, message revision, Undo, denied external reads, an approved
Node/npm/Git toolchain command, cancellation, staged Skills without an approval,
and structured read-only planning. Image request parameters and native effort
selection are covered by protocol fixtures; this run did not send an image.

Historical v1 acceptance used OpenCode 1.18.33 with
`opencode/mimo-v2.6-flash-free` on macOS; that run does not establish v2 acceptance. In Claude's `-p` mode
it has no `TodoWrite`, `Glob`, `Grep` or `LS` and searches with `Bash`, so
planning turns accept the read commands the policy allows without asking. Keep a runtime opt-in until real acceptance
passes on the target platform; fixture success alone is insufficient.

An optional final argument selects an absolute executable path, for example
`bun run test:agent-runtimes:live codex-cli MODEL /absolute/path/to/codex`.
The test continues other checks after a protected-read failure, saves each
boundary failure and exits unsuccessfully. A missing denial record is not a
persistence regression when the runtime never requested approval at all.
