# Preview configuration and lifecycle

The optional VM backend requires storage lifecycle protocol 2. Project deletion
drains previews and pending source returns before retiring its volume. Idle
complete volumes sleep and restore within finite capacity limits. Protocol 1
guests need separate audited maintenance before activation. See
[isolated storage lifecycle](isolated-storage-lifecycle.md) for the boundaries.

Web Game and newly created General Game projects have browser preview enabled,
except projects that select a plugin external preview.
New General projects open on Design; prompt-based creation also keeps chat open.
Existing General projects keep their saved switch, and older projects without a
switch remain disabled. **Project settings**, available from Design, Code and
Preview, controls Web preview, Play and Web playtesting. Design's separate
**Default models** button controls generation models. Neither setting selects
or installs a game engine.

The local VM keeps separate budgets for ordinary source and game media. Code and
other ordinary files share 8 MiB, with at most 2 MiB per file. On a guest that
advertises runtime-media support, verified non-executable media under `public/`,
`src/`, `assets/files/` (including imported folders), and older
`assets/imported/` or `assets/generated/` paths can use up to
32 MiB per file and 64 MiB combined. The existing 2,000-file limit and shared
256 MiB project volume still apply. Increasing the amount of media also consumes
space needed by dependencies and build output.

These are the legacy limits. An explicitly created or migrated v2 volume allows
128 MiB cumulative media on a 512 MiB volume; the separate v3 policy allows
64 MiB per AV/GLB file while raster images remain at 32 MiB. Neither upgrades
existing volumes or generations, and a transfer or changed-media window remains
64 MiB. See the [versioned AV/GLB contract](isolated-storage-lifecycle.md#controlled-avglb-profile-version-3).

Registering a new candidate on the Canvas keeps it in the project for viewing
without sending it to the VM. To use an asset in a game, call
`use_canvas_asset` and reference the resulting runtime path in the game. Older
imported and generated paths remain available even when a script constructs the
URL dynamically. A media-looking extension alone does not qualify a file.
The host checks contents and the guest requests only new or changed runtime
media. An unchanged video keeps its original bytes on a script-only rebuild.
If the build copies those bytes to a differently named output, the host verifies
and restores them from the original project file. With a guest advertising
`buildMediaVersion: 1`, newly generated and re-encoded media in `dist/`,
`build/` or `out/` can also return at full quality. Copied and newly generated
media share the output budget of 64 MiB per build, at most 32 MiB per file.
Versioned profiles can return verified copies by reference against their separate
cumulative budget; v3 may reference an inspected 64 MiB AV/GLB source. New or
rewritten large outputs do not acquire that authority and remain retained for
inspection. No full 64 MiB media Buffer or base64 payload is needed for a verified
copy.
The host checks the complete response before replacing the previous build.
On a managed Web Game or General project with isolated execution, the Agent's
`build_game` tool uses the same local build service as the build API. Static
games return their runnable directory. An npm build returns the verified
workspace-relative `dist`, `build` or `out` directory. A missing playable
entry leaves the last local build in place. Building does not publish the game.
An older guest can still return copied media by reference. The ordinary source
limits continue to apply to script files and source edits returned by Shell.
See [media transfer and recovery scope](isolated-storage-lifecycle.md#media-transfer-scope)
for copy/replacement identity, supported formats and explicit review cases.

The isolated npm preparation requires a v3 `package-lock.json` even for a game
with no dependencies. Build output must contain ordinary transferable static
files; hidden hosting metadata such as `.nojekyll` is rejected on artifact return.

## Checked media reads

Library downloads, workspace media reads and host static previews inspect a
complete private snapshot before responding, including to HEAD or a small byte
range. Inspection copies and scans in 64 KiB chunks, checks source identity before
and after the copy, and hashes the bytes. The copy is unlinked before payload is
written; only its read-only descriptor remains after inspection. A source change,
unsafe link, registered secret or conflicting retained digest stops the response.
New Library records retain a content digest; older records without one are not
silently upgraded or described as having verified historical provenance.

Workspace and static display inspection allows MP4/WebM up to 256 MiB,
WAV/MP3/OGG up to 200 MiB and GLB up to 100 MiB. Other files retain the 64 MiB
inspection limit. Library content keeps its existing 200 MiB read allowance,
except video can use the existing 256 MiB generation allowance. These are encoded
read ceilings, not art specifications, decoding budgets or increases to generation,
upload, FBX conversion, source transfer or isolated execution allowances above.

Each request still authorizes and checks the current source. Responses use
`no-store`, a strong snapshot ETag and a single byte range. An exact strong
If-Range match permits a range; a different, weak or date validator returns the
whole inspected snapshot. Unsatisfiable ranges return 416; malformed or multiple
ranges retain the full-200 behavior. HEAD ignores Range but still inspects the
whole file. Client cancellation stops pending inspection or streaming. A newly
registered protected value invalidates cached inspections and stops subsequent
stream chunks; bytes already sent cannot be recalled.

One daemon shares at most 512 MiB of derived snapshot bytes and 32 entries, with
two concurrent scans and at most 64 pending acquisitions. Idle copies expire after
60 seconds. Snapshots reserve real disk capacity and inodes alongside outstanding
recovery and volume promises, with a 2 GiB free-space floor. Unknown reservation
state, insufficient space or a full active cache refuses a new inspection; it
does not delete originals, recovery records or Library assets. Completed anonymous
copies occupy actual disk blocks until released. Closing the service cancels and
releases its derived copies; it does not migrate a project or replay a task.

The desktop main editor can use native audio/video URLs and direct GLB fetches.
It first performs an authenticated HEAD inspection and binds the resulting strong
content digest to the URL. Every later range checks that digest; a changed source
returns 409 rather than combining different versions. The digest grants no access.
The main process adds authentication only for GET/HEAD on the two exact inspected
Library/workspace routes, from the current editor's exact main frame and daemon.
Other windows, embedded frames, missing frame identity, prefetch and redirects
receive no automatic authority. No bearer token is placed in a URL, cookie or
service worker. The editor media CSP permits loopback media; daemon authentication,
Origin checks and whole-file inspection still apply.

Browser development, older desktops, images, private model-resource paths and the
separate Canvas FBX preview endpoint retain the bounded Blob path. Native paths
avoid the application's full-Blob prerequisite, but GLB parsing still requires the
complete model and browser decoders retain their own buffers. Native byte-range
support alone does not prove reduced transfer or efficient time-based seeking.
Dynamic development proxy responses remain a separate transport and do not gain
this whole-file scanner. Codec support, GLB extensions/decoder availability,
GPU memory and target-device frame time require real browser/device validation.

The daemon's bounded GLB inspection/facing/split worker is a separate path from
renderer `model-viewer` loading. Raw Library/workspace snapshots establish their
container, identity and protected-byte checks, not this daemon parser's full
admission. Merely retaining a manually imported original does not establish
NodeIO or rendering acceptance. The renderer still loads a complete GLB from a
Blob or the native URL and uses its own glTF loader, texture decoding and GPU
allocations; those paths and the separate FBX parser are not covered by the
daemon reader-allocation budget. See [local model inspection](canvas-agent.md#local-model-inspection-and-retained-results)
for the supported daemon operations and their refusal/recovery boundaries.
Earlier local incremental-animation merge checks do not enable a provider:
Meshy calls and remote recovery are disabled. Retained GLB assets remain subject
to ordinary local preview checks. Use their actual saved clip names, including
any collision suffixes; compatible structure does not validate motion or playback.

Canvas media nodes retain their DOM and dimensions while their media requests
follow the viewport. Selected or playing media stay mounted when moved away;
otherwise offscreen previews release their sources. Visible Canvas model and
animation results rotate slowly (10 degrees per second), independently of camera
controls; saved animation clips play when present. Both stop outside the actual
viewport or while the document is hidden, including models kept mounted by
selection. Returning resumes the mounted preview's selected clip without
resetting its playback time. Unmounted previews retain the existing source
release behavior. Library thumbnails stay static, and interactive viewers retain
their camera controls and the viewer's normal delay after user interaction.
Video dialogs first show a normal
player. Filmstrip decoding and a full editing source are loaded only after the
user opens trimming, with cancellation and source-digest checks. An explicit
editing or download operation can still need the complete file.

Encoded bytes, decoded memory and runtime performance are separate measurements.
For long audio/video, check the actual container index, codec support, transferred
ranges and buffered duration. A low-bitrate synthetic tone is not a quality preset
for music. For GLB, inspect geometry, skins, animation, material/texture counts and
decoded texture dimensions; direct fetching does not make a large model streamable
to the GPU. On the actual WebGL device, read `MAX_TEXTURE_SIZE` and check each atlas
dimension. That maximum is a compatibility ceiling, not a memory or frame-time
budget. Measure loading peaks, draw calls and frame times in a representative
scene; changing encoding or splitting assets requires explicit quality/layout
decisions and another resource check.

Agent image generation and static PNG/JPEG/WebP Library or folder imports into
game projects retain the original outside the execution workspace. Default
working-copy preparation is identity: accepted source bytes, dimensions, pixels
and alpha remain unchanged. Complete validation still enforces the 32 MiB input
and 32 MP decode bounds. Resizing requires an explicit `maxEdge`; it does not
authorize a quality increase, atlas layout change, or automatic retries at smaller
edges. Unsupported orientation, animation or bit depth stays retained rather
than being silently rewritten. Asset Canvas imports retain their full originals.
`optimize_image_asset` is registered independently of generation availability
and also runs locally when VM admission fails. It accepts existing paths as a
batch or a retained original ID and a new destination, without a model request.
Its input, aggregate execution and recovery-space checks still apply; an explicit
resize does not bypass the input decode limit. A generated original above the
64 MiB secure retention limit stays in its generation tool run; that run is not
removed on retention failure. Do not regenerate to recover a size or local preview error.

The Agent's retained-review `read_image` display is a separate, read-only model
input. Its labelled proxy may be smaller or differently encoded than the source;
it never changes these working-image defaults, the original, or a game asset.
Its saved source/display hashes do not establish fresh guest state, recovery
approval, full-resolution visual acceptance or measured runtime performance. See
[controlled retained-image inspection](isolated-storage-lifecycle.md#controlled-review-and-adoption-of-a-legacy-batch).

Production sprites and cutouts needing transparency should request PNG with
`background=transparent` from a supporting model. Local optimization never
flattens alpha or switches PNG to JPEG for size recovery. Opaque JPEG sources
have no alpha to restore: converting them to PNG alone does not remove a
background, and local background removal is an approximation that needs visual
inspection over the game's actual background.
Working image results report `hasTransparency` from actual alpha samples, not
just a channel or filename. The generation tool warns when a requested
transparent output has no transparent pixels; it retains the result and never
automatically bills a replacement.

Originals, preparation receipts and transaction recovery live in private
`<dataDirectory>/image-recovery/<projectId>/`, independently of the project and
its VM volume. Normal cancellation, failure and recovery retain this store.
Explicitly deleting the project removes its recovery originals and preparation
receipts after active work and recovery transactions have settled, together with
its Blender jobs, conversation data and checkpoints. Independent Library assets
and account settings remain available.
Legacy project-scoped image recovery blocks project deletion until it is
preserved independently. Publication stages both versions and a manifest before
moving any source, and uses no-replace links. Interrupted transactions require
local recovery review: `before/<index>` preserves moved inodes,
`original-<index>` is the inspected original, and the manifest maps indexes to
project paths and hashes. `committed.json` marks completed publication. External
programs holding old file handles may still write; this is recoverable staging,
not a global filesystem transaction.

Isolated previews keep at most eight active transports. Bursts wait in a bounded
queue of 32 connections for up to ten seconds; cancellation closes pending
requests without launching more guest processes.

## Startup configuration

Run settings are saved per project and copied when duplicating it. Startup
configuration and Playtest defaults are visible immediately, with aligned pairs
of fields. Infrequent port/argument and background cleanup controls are collapsed;
only fields relevant to the selected startup mode are shown. Configuration
inspection runs while the dialog is open and Web preview is enabled. Inactive
mode drafts do not block inspection or saving. Disabling Web preview preserves
the saved configuration and ignores disabled drafts.
**Startup directory** stays inside the workspace, including after resolving
symlinks. Preview modes are:

| Mode | Behavior |
| --- | --- |
| Auto | Run the configured package script when available; otherwise serve `index.html`. |
| Package script | Run the configured script, `dev` by default. |
| Static files | Serve the selected folder's `index.html` without installing dependencies. |
| Custom command | Run a local server command in the selected directory, without a Node dependency install. |

Static directory index pages redirect to a trailing-slash URL while preserving
the query string, so relative scripts and other assets resolve from that directory.
Directories without an index return 404; missing extensionless application routes
can still fall back to the root `index.html` when the request accepts HTML.
Static files support byte ranges on GET for media seeking. HEAD ignores Range
and returns the complete file's headers without a response body.

Byte ranges can support seeking when the client and container use them; a whole-file 200 response alone does
not establish a playback fault. `game_use` media snapshots report the element ID,
network state, buffered ranges, video dimensions and dropped/total frames along
with current time and media error code. Network failures are session history.
Trigger actual playback, then compare fresh progress before replacing an asset;
a paused video at time zero is not a decoder failure. Reuse the same session for
resize/DPR checks. Per-snapshot deterministic capabilities reflect the current
page's `snapshot/reset/setSeed/step` bridge; custom methods are unavailable.

Custom commands can use `{host}` and `{port}`. The process also receives `HOST`,
`PORT` and `BROWSER=none`. Its server must listen on that port. Advanced settings
allow a fixed upstream port and a JSON array of package-script arguments, with
the same placeholders. Leaving arguments empty selects framework defaults;
`[]` explicitly disables them. Vite, Next, Astro, Nuxt and webpack receive their
own supported flags; unknown scripts receive the environment variables only. A
custom Node server must read `process.env.HOST` and `process.env.PORT` rather than
assuming Vite flags will be appended or listening on a fixed port. A startup log
can say ready while the assigned port is still unreachable.

Package-manager selection uses the explicit setting, `package.json.packageManager`,
lockfile, then npm. Settings display the detected manager and its source, and
check availability without running project code or installing dependencies.
Missing Bun/pnpm/Yarn remains an actionable configuration error rather than
silently changing managers. The packaged app includes Node/npm; other managers
must be available to the application. Before installation changes `node_modules`,
the selected executable is checked against the environment passed to the child.

The isolated npm backend prepares declared dependencies inside the guest at the
selected package root. It ignores host `node_modules` and host installation
stamps, including on an explicit reinstall. A package without dependencies can
start its script without an installation. Public packages reuse their verified
download cache. npm workspaces and other package managers are unsupported by
this backend.
Known native launchers such as Electron, Tauri and Godot are not treated as Web
servers; configure a separate browser script or command for their Web output.
**Reinstall dependencies and restart** reruns preparation. Installation has a
two-minute limit; the server has
30 seconds to respond after launch. The log panel shows phases, elapsed startup
time, directory, command, manager and the last 8 KiB of process output.

## Automatic policy and idle collection

An Agent command or local build borrows the project's single guest execution
slot. A playable host-served static page can open or stay open while the guest
slot is occupied. A running script preview must yield that slot. After a successful operation an
open editor with automatic preview enabled resumes the script preview; a manual
stop remains in effect. An uncertain failed operation does not start a new job.

**Automatic preview** defaults to on. Opening a project creates an editor lease
and starts a runnable preview. Files are observed while a project has users;
when output becomes runnable, automatic preview starts. Agent completion uses
the same policy and requires an observed file change. Checkpoint snapshots leave
running previews and unfinished launches alone, so a conversation without file
edits does not restart the game. Isolated script previews run a copy of the source
and runtime media. Opening Play or a new `game_use` session, reopening the editor,
or selecting **Reload preview** checks that copy against the current project.
Changed inputs start a fresh preview at the saved origin when available. Identical
inputs reuse the running game. Static previews read the workspace directly.
A failed startup does not repeatedly retry without a change. Before a
workspace has any project files (hidden entries and `node_modules`, `dist` or
`build` do not count), an automatic check that finds nothing runnable stays
waiting without an error, so a new project shows the empty preview. Once files
exist, the waiting state keeps the reason, such as a
missing dev script; Start and Play always report it. Generated dependencies, hidden/build folders and common
runtime log/PID/temp files do not trigger retries.

**Stop preview** cancels installation/startup or stops the running service.
That manual pause survives reopening the project during the current application
session; file changes and agent completion respect it. **Start preview** or Play
resumes it. Service recovery also pauses automatic startup until the user resumes.
Disabling automatic preview affects future starts, not an already running game.
Inspection and launch are one cancellable operation: stopping, disabling automatic
startup or losing the last lease cancels an unfinished automatic launch. An explicit
Start/Play request takes over that launch under manual policy. Reopening during idle
cleanup waits for the old server to close before starting again.
If the replacement fails configuration inspection, the closed preview remains
stopped and its old URL is cleared.
Saving viewport, default route, automatic policy or idle policy does not restart
the server. Changing effective launch settings restarts a currently active server.

The editor renews its lease every 20 seconds. Preview, Play, AI test and external
browser documents have separate leases, renewed by the browser bridge. Closing
a page or leaving a project releases its lease. Abandoned leases expire after
75 seconds, so a disappeared window cannot retain a server indefinitely.

**Stop unused preview after** defaults to five minutes with no users. It can be
set to 1–60 minutes or **Keep running**. A live Play or test window keeps its
server running even after leaving the editor. Idle collection runs every ten
seconds; manually starting an unused server is subject to the same timeout.
Deleting a project immediately closes its watcher, proxy, refresh streams and
child processes.

## Pages, diagnostics and saved games

The project owns one loopback proxy. Its port is saved in `preview-origin.json`
outside the workspace, preserving the browser origin across normal restarts and
application relaunches. If another process occupies that port, an available port
is used and saved; browser storage at the previous origin cannot migrate
automatically. Duplicated projects receive a separate origin.

Page reload and server restart are separate controls. Internal navigation updates
the toolbar without reloading the game. The desktop editor owns one human game
WebContentsView per project. Play moves that view into a separate native window;
closing Play returns it to Preview. Both directions preserve the same document,
current route, in-memory state, localStorage and IndexedDB. Refresh explicitly
recreates the game document at its current route. A minimal host page, with no
editor preload or daemon credentials, keeps the editor's top-level site.

In this local edition, each native view uses a private, in-memory partition.
Saves survive transfers, refresh and renderer recovery within that view's lifetime;
a fully replaced view starts with empty storage. Legacy/default iframe save
migration and persistence after disposing the view or restarting the app are
unsupported. Older standalone Play saves stay in their separate
storage context and are not merged. Browser builds continue to use an iframe and
separate popup, which reload the game on switching. Static file changes reload
active pages through a local event
stream, while development servers retain their own HMR protocol.

Editor tooltips render outside clipped panels and move into available editor
space around visible native Preview bounds, so showing a hint keeps the game
visible. Dialogs and menus that overlap the native Preview still temporarily
hide it and restore the same document and game state when they close.

Cancelling a browser navigation or reload closes its pending proxy transport without recording a preview load failure. Connection and response failures while the browser is still waiting remain diagnostics.

HTTP readiness and content diagnostics are separate: a responding server can
still have compilation or runtime errors. The proxy forwards HTTP and HMR;
failed module responses and browser exceptions or rejected promises update
daemon-owned diagnostics through project events without stopping the server.

Desktop Preview and human Play share a client/document identity; the diagnostic
source follows the view's current window without reloading it. AI tests and external
pages have their own identities and storage contexts. The editor shows the active
human game's diagnostic. Errors from other windows remain available in the log
panel. Reports must match the proxy origin and current document. Successful module
responses, navigation, HMR success and close clear only that client's errors,
including when a broken module was removed. Late reports and module responses
from superseded documents are ignored. Diagnostic and document maps are bounded,
and each active document has at most one refresh stream. Automatic project-cover
capture pauses while an error is visible.

The proxy removes internal tracking parameters before forwarding requests.
Same-origin Origin/Referer and upstream redirects follow the proxy address;
foreign origins and external redirects retain their original semantics.
Uncaught JavaScript exceptions, rejected promises and compilation failures can
be copied or inserted into the Agent composer using **Ask Agent to fix**. This
preserves the draft and does not send a message. Source links open the relevant
workspace file when its path can be identified.

Browser diagnostics, static refresh and external-page leases depend on an external
classic script injected before project scripts into uncompressed HTML up to 2 MiB.
It preserves CSP, including an existing nonce, and uses its own function scope to
avoid project-global collisions. Larger or compressed pages retain their original
representation; restrictive CSP can block the bridge. Editor leases, service logs
and recovery controls remain available. This proxy is intended for local HTTP
development, not a full production reverse proxy.

Preview state is delivered through one `preview.updated` event containing the
complete runtime state. Browser reports use a typed message envelope for activity,
navigation, lifecycle and diagnostics; obsolete standalone diagnostic messages
are not accepted.

## External plugin preview

A project's optional `integration` selects its plugin and `external` presentation.
These projects expose View with the plugin's native preview controls and do not
acquire Web leases or create a Web player. Browser runtime configuration and
leases retain their existing lifecycle. See [plugin integrations](plugins.md#optional-project-integrations)
for the adapter contract and Maker's current limits. External controls mount only
while View is visible; they do not capture or embed the native game window.
When the connection cannot be used, disconnecting the plugin there stops its
native preview and returns the project to ordinary General settings with Web
preview off.
