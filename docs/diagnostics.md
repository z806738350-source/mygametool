# Logs and diagnostics

The desktop app keeps logs on disk so a failure can be traced after the app
closes, and exports them with system information for bug reports.

## Log files

The Electron main process writes two files to the platform logs folder
(`app.getPath("logs")`; on macOS `~/Library/Logs/<app name>`, on Windows
`%APPDATA%\<app name>\logs`):

| File         | Contents                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `main.log`   | The main process's console output, the app version and platform at startup, and the main window's console warnings and errors. |
| `daemon.log` | The daemon's stdout and stderr, and a line when the service starts or exits.                                                   |

## What is recorded

The logs record what happened and how it ended. Prompts, messages, tool input
and successful tool output stay out. Error text is kept as reported, so it can
quote what failed, such as a file name or a line of code in a failed preview's
output.

In `daemon.log` (`src/daemon/activity-log.ts`, `src/daemon/request-log.ts`,
`src/daemon/tools.ts`):

- Agent turns: start (with image, attachment and plugin counts), completion,
  cancellation and failure, with the duration and the error. Model request
  failures add the provider, model, endpoint and status code from the
  [agent error diagnostics](agent-errors.md) to that same outcome line.
- Provider HTTP requests and supported model streams: passive stage, timing, byte counts and terminal outcome records, including successful requests. See [passive request monitoring](#passive-request-monitoring) below. Failed HTTP requests also keep the bounded, filtered [error diagnostics](agent-errors.md#local-http-error-diagnostics).
- Conversation model changes and model request retries.
- Failed agent tools, with the tool, MCP server and the last 500 characters
  of their output, where the error usually is.
- Preview status changes, with the error and the last 2,000 characters of a
  failed preview's output.
- Publishing start, completion and failure.
- Each finished image, video, 3D or audio generation, with the tool, model,
  project, duration and the error of a failed one.
  Agent tools, Canvas nodes and background jobs share this recording boundary;
  each execution produces one outcome line.
- Requests that end with an error status, by route pattern (such as
  `/projects/:id`), and the stack of unexpected server errors. Successful
  requests are not logged; the renderer polls the daemon and they would bury
  everything else.
- Startup and load failures the daemon already reported.

In `main.log` (`src/desktop/console-log.ts`):

- Background service status changes, such as a crash and its recovery.
- Update failures, with the details the About page shows.
- Uncaught errors with their stack.

## Passive request monitoring

`src/daemon/provider-request-monitor.ts` emits JSON lines with `msg: "Provider request"`.
Each request has a random `localRequestId`. Agent requests also carry UUID-only
`projectId`, `conversationId` and the active `turnId`; queued or steered turns
resolve their current ID when each request starts. Manual context compaction uses
the same scope. Requests outside a turn omit missing scope fields. An existing
image-size fallback has a new HTTP ID and a `modelRequestId` pointing to the
original request; monitoring adds no retries or probe requests.

Events are `started`, `response` (headers), `first_body_byte`, and `finished`.
An unfinished request emits at most one `progress` per minute. Fields include:

- `protocol`, `phase`, `statusCode`, and filtered `providerRequestId`/`errorCode`.
- `prepareMs` before submission, `responseHeadersMs`, `firstBodyByteMs` and
  `wireMs` from opening fetch, plus `totalMs` from local preparation to the
  terminal result. Durations use the monotonic clock; `time` is wall-clock time.
- `requestBytes` when the checked body has a known encoded size, and raw
  `receivedBytes` read through the existing response boundary. Multipart encoded
  size is omitted. These are application body bytes, not TCP/TLS traffic or
  billing tokens; bounded error-body reads may count only a prefix.
- `maxIdleMs` and progress-only `lastDataAgeMs`, measuring gaps between observed
  response bytes (including the initial wait). `firstBodyByteMs` is observed
  before SSE buffering/validation releases data to the SDK. A heartbeat is a body
  byte, so this is not the model's first visible word.
- `wireComplete` and `responseValidated`, separating EOF from completion of the
  existing local response inspection.

`completed` requires a supported model SDK's normal stop or tool-call result,
validated transport and a protocol stop reason; credentialed Anthropic SSE also
requires `message_stop` in the existing security parser. HTTP 200 and EOF alone
never produce model completion. Output-limit stops are `incomplete`. Other outcomes
are `http_error`, `transport_error`, `stream_interrupted`, `validation_error`,
`cancelled`, `timeout`, and `protocol_error`. An SDK result without an observed
guarded transport is `unobserved_transport`. Original caller cancellation is
separate from the SDK's internal reader cleanup. Standard timeout signals are
recorded as deadline timeouts. Monitoring observes results without changing the
SDK response, agent execution, SSE release policy or cancellation behavior.

Generic media/control requests end as `transport_complete` after the observed
body and inspection finish. Their job outcome remains in the existing generation
log: network completion does not prove successful generation or valid JSON.
Artifact downloads, preview traffic, native processes and gateway-internal
routes/retries are outside this boundary. A process crash can leave a start or
progress record without a finish; rotation can remove older related lines.

The monitor logs a fixed field allowlist, without provider/model names, URLs,
prompts, replies, images, credentials, complete headers, response IDs or content
fingerprints. It keeps counters and flags, reuses the existing readers and SSE
parser, and never copies a body for monitoring. Short nonempty requests normally
produce four stage lines; early failures produce fewer. There is one unreferenced
progress timer per active request, cleared at its terminal outcome. The normal
log rotation and export rules below still apply.

## Redaction and rotation

Each line is timestamped and redacted before it is written
(`src/shared/log-redaction.ts`):

- The diagnostic sanitizer from the Pi patch replaces `sk-` and `pk-` keys,
  bearer and basic tokens, and values after `api_key`, `access_token`,
  `refresh_token`, `authorization`, `password`, `secret` and `cookie`.
- URL credentials, queries and fragments are removed.
- The home folder is written as `~`, in plain, forward-slash and JSON-escaped
  spellings.
- JSON strings inside errors and tool output are decoded before redaction,
  including nested JSON. Oversized input, incomplete JSON records and excessive
  string nesting are omitted instead of risking a credential being cut away from
  its field name. An oversized chunked line is discarded through its newline.
- Quoted console object values and complete Cookie headers are redacted too.
  Console messages and fatal stacks retain their original line breaks until
  redaction, including credentials whose value starts on the next line.
  Error snippets are selected only after redaction, so taking the end of a tool
  or preview error cannot separate a credential from its field name.

The daemon's log lines carry the process ID but not the computer name
(`src/daemon/request-log.ts`).

Lines are written in the background, so logging never blocks the Electron main
thread; an uncaught error writes its lines synchronously, as the process may
end first. A multi-line entry, such as a service error with the daemon's
output, is written one timestamped line at a time. Each file rotates at 5 MB,
and the newest three are kept (`daemon.log`, `daemon.1.log`, `daemon.2.log`).
A log that cannot be written stops quietly; logging never fails the app
(`src/desktop/log-file.ts`).

A daemon started on its own (`bun run dev`, `bun run start`) writes no log
files; its output stays in the terminal.

## Diagnostics export

**Settings → About → Diagnostics → Export diagnostics** saves a ZIP from
`POST /diagnostics/export` (`src/daemon/diagnostics.ts`). The desktop app
passes the logs folder to the daemon in `OHMYGAME_LOG_DIR`. The ZIP contains:

- `logs/`: `main.log`, `daemon.log` and their rotated files. Nothing else in
  the folder is included.
- `system.json`: the app version; OS, architecture, locale, CPU count and
  memory; Node, Electron and Chrome versions; and the IDs of configured
  providers, coding agents (with version and sign-in status), installed
  plugins, and the number of projects of each type. `logs` is
  `"not recorded"` when the daemon has no logs folder. A part that cannot be
  read is recorded as `{ "error": … }` and the rest is still exported.
  Every string in `system.json`, including section, summary and filesystem errors,
  goes through the same redactor before serialization. Large summaries remain
  valid JSON.

When the background service is not running, the desktop app builds the same
ZIP itself (`src/desktop/diagnostics-export.ts`), with the service's status
in place of providers, agents and plugins. The service's address and access
token stay out, and its error is redacted like a log line.
The service request, including reading the ZIP response, has a 15-second timeout;
an unresponsive service also falls back to the desktop export.

Settings files, conversations and project files are not added to the archive.
Error text can still quote file names or short excerpts of failed tool or preview
output; the redactor removes common credentials and the home folder from them.

**Open logs folder**, shown only in the desktop app, opens the folder so people
can read the logs before sharing them.
