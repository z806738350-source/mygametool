# Contributing to OhMyGame

OhMyGame is in beta. Bug reports, documentation improvements, small fixes,
plugins, and feedback from making real games are welcome.

This guide covers the path from choosing work to getting a PR reviewed.
See the [documentation index](docs/README.md) for module guides and the
[中文快速指引](docs/contributing.zh-CN.md) for a short introduction in Chinese.

This checkout is a local secure source edition. Start with
[local security policy](docs/local-security.md): upstream feature guides retain
framework contracts that may be disabled here. Environment variables cannot
restore accounts, cloud publishing/quotas, telemetry, remote updates, or arbitrary
execution. Selected isolated local workflows have passed runtime verification;
see that policy for the current limits.

## Choose something to work on

- Search [existing issues](https://github.com/WhiteTowerAI/ohmygame/issues)
  before reporting a bug. Use the bug report form and include reproduction
  steps, version, platform, and logs with credentials removed.
- Discuss new features and large changes in an issue before implementation.
  Small fixes and documentation corrections can go straight to a PR; an issue
  is useful when the intended behavior needs discussion.
- Look for [`good first issue`](https://github.com/WhiteTowerAI/ohmygame/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/WhiteTowerAI/ohmygame/labels/help%20wanted).
  If none fit, describe the contribution you have in mind in an issue.
- Ask questions and discuss ideas on [Discord](https://discord.gg/TkrgvGQ2Zc).
  Keep decisions and reproduction details in the related issue or PR so others
  can follow them.

Maintainers manage type, area, and progress labels using
[the label workflow](.github/LABELS.md). Acceptance of a feature request does
not by itself mean implementation has been scheduled.

## Fork and create a branch

`dev` is the development integration branch. Start contribution branches from
`dev` and open ordinary PRs against `dev`. `main` is the release branch;
maintainers merge release PRs from `dev` into `main`.

Fork [the repository](https://github.com/WhiteTowerAI/ohmygame/fork), then
replace `YOUR_USERNAME` below with your GitHub username:

```bash
git clone https://github.com/YOUR_USERNAME/ohmygame.git
cd ohmygame
git remote add upstream https://github.com/WhiteTowerAI/ohmygame.git
git fetch upstream
git switch --no-track -c fix/short-description upstream/dev
```

Use `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`,
`chore/<short-name>`, or `refactor/<short-name>` for your branch. The long-lived
`dev` and `main` branches are maintained separately. Contributors with write
access can use the same branch conventions in the upstream repository.

Choose the PR's base branch explicitly; GitHub may still suggest `main` during
this transition. The [maintainer guide](docs/maintaining.md) covers migration
and releases.

## Start local development

Install Git, Bun 1.4.2 or newer, and Node.js 22.19 or newer, including npm.
CI pins Bun 1.4.2 and Node.js 22.19.0. Use those versions when investigating a
difference between local checks and CI.

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile --ignore-scripts
```

Use this modified checkout; a fresh clone of upstream does not include these
security changes. Installation downloads locked packages without lifecycle
scripts. Do not rerun install scripts to resolve an error without reviewing
their contents and separately approving that execution. Native binaries may
remain unavailable; Electron's executable is not installed by this step.

The local security work has also run separately approved checks and isolated
development acceptance. Review downloaded code before extending that scope.
After those gates, `bun run dev` is the browser development entry point at
<http://127.0.0.1:43120>, forwarding API requests to the authenticated loopback
daemon at `127.0.0.1:43110`. Desktop startup additionally needs a separately
reviewed Electron binary. No model credentials or account configuration are
required to inspect the interface.

### Local edition limits and preparation

- No account login, debug identity, Community, cloud publishing or hosted model
  quota is available. No environment variable enables these features.
- Application Sentry/PostHog initialization, uploads and author update feeds are
  removed or disabled. This is not a guarantee about every dependency or binary.
- Startup no longer downloads remote examples or preinstalled plugins. Explicit
  `prepare:examples` and `prepare:preinstalled-plugins` commands fail with a local
  edition explanation; retrying them does not enable downloads.
- External MCP servers, plugin code, host shell commands and other coding
  agents remain disabled. The optional pinned, controlled Codex and first-stage
  Qoder main-agent connections use separate sign-in; see [coding agents](docs/coding-agents.md). Controlled public npm dev/build is verified only in the explicitly
  registered VM test/manual stores, which also offer guarded isolated_shell; ordinary stores remain disabled.
- Model requests require an explicitly configured, reviewed endpoint and a
  guarded protocol. Upstream model/provider listings are metadata, not proof of
  support. Full KunpoAPI media compatibility remains unverified.
- Browser and game resource restrictions are application policies, not an OS
  network sandbox or verified WebRTC isolation.
- Bun supplies the build/test toolchain. The standalone daemon uses Node;
  desktop development uses Electron's Node. Browser development does not provide
  Electron's `game_use` tool. See [runtime.md](docs/runtime.md) for upstream
  architecture, with [local security policy](docs/local-security.md) taking
  precedence for this edition.

Browser development stores project data under `.data/`. Desktop development
uses the app's user-data directory. Set `OHMYGAME_DATA_DIR` and
`PI_CODING_AGENT_DIR` to separate temporary directories when a manual test needs
isolated projects and agent settings. Neither directory belongs in a PR.

## Make and check your change

Vitest gives each run a private temporary directory and removes it after all workers finish. Use the system temporary directory for generated project fixtures.


Keep each PR focused on one feature, bug fix, documentation change, chore, or
refactor. Use the [module map](docs/README.md#where-to-change-things) to find
related code, documents, and tests. Update public behavior documentation when
your change affects it.

Maintainers update [CHANGELOG.md](CHANGELOG.md) during release preparation.
Ordinary contribution PRs do not need a changelog entry; explain user-visible
changes in the PR description so they can be summarized for the next release.

| Change                                    | Local verification                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation only                        | Check local links, examples, and formatting; run `git diff --check`. Application builds and tests are optional locally.                                      |
| Application behavior, dependencies, or CI | Run the public checks below. Add or update tests for new behavior and bug fixes; use a focused test while developing.                                        |
| UI or desktop behavior                    | Run the public checks and exercise the affected flow in the browser or Electron as appropriate. Include screenshots or a short recording for visual changes. |
| Plugin instructions or examples           | Check the relevant package/file contract and try the affected workflow in a project. If host behavior changes, run the public checks too.                    |
| Disabled integration boundaries           | Test that the boundary fails closed without network requests or process execution; do not enable upstream services to make an old success test pass.        |

After dependency review and explicit authorization for this security work,
start with type checking, focused local boundary tests and the renderer build:

```bash
bun run typecheck
bun run test -- test/auth.test.ts test/cloud-models.test.ts test/desktop-updater.test.ts test/desktop-update-scheduler.test.ts test/model-network-policy.test.ts test/provider-network.test.ts
bun run build:renderer
```

These commands execute downloaded tooling and project configuration. Selected
checks have run for this edition. The focused tests use mocked transports, not paid
APIs. The renderer build writes `dist/renderer` and may require native tooling
left uninitialized by `--ignore-scripts`; stop and inspect failures rather than
enabling lifecycle scripts. No daemon, Electron app, game or model API startup
is part of this first check group.

Broader checks (`bun run changelog:check`, `bun run test`,
`bun run test:node-runtime`) need a separate review of process, filesystem,
network and native-tool behavior. `test:node-runtime` builds and starts the
daemon/player. Full tests include process fixtures and are not a read-only
operation. Some upstream success contracts no longer apply to disabled features;
record failures and skips instead of claiming the entire upstream suite passes.

The [CI workflow](.github/workflows/ci.yml) runs on PRs and pushes to `dev` and
`main`, including documentation PRs. Its template uses script-free dependency
installation and checks the changelog, types, tests, the renderer build, and the
Node daemon/player build and startup. It has not been triggered or validated as
part of this local work. Types, tests and the Node startup check also run on
macOS and Windows. CLI integration cases that execute POSIX script fixtures run
on Ubuntu and macOS; Windows still runs in-process adapter and protocol tests.

Remote publishing contracts in `test/publish.test.ts` document upstream private
services, which are unavailable in this edition. Do not provide cloud credentials
or an adjacent private checkout to enable them. Passing local boundary tests
does not verify those services. Record remaining checks in the PR.

### Keep tests and documentation focused

- Extend an existing test or guide before adding one. Merge tests only when
  they share setup and inputs at the same boundary, and keep every assertion.
- Before removing a test, name the remaining test that guards its behavior or
  state that the behavior is no longer supported. A passing suite or unchanged
  line coverage is not proof; `bun run test:ablation` injects known faults and
  reports which test groups catch them. Diagnose or quarantine slow and flaky
  tests rather than deleting them or adding retries.
- Keep each rule in one guide and link to it from indexes and summaries. Put
  run-specific counts and logs in the PR. Translations and shipped agent
  instructions have their own readers, even when the wording is similar.
- AI can propose duplicates and merges; the evidence above and review decide.

## Formatting

Match the surrounding style when editing an existing file and keep formatting
changes limited to the parts you touch. The repository has not been fully
formatted with Prettier; whole-file checks are not required for existing files.

Use the repository's Prettier configuration for new supported files:

```bash
bunx --bun --no-install prettier --check <new files>
```

Keep broad formatting cleanup in a separate PR. CI does not enforce
repository-wide formatting.

## Open a pull request

Commit your change and push your contribution branch to your fork:

```bash
git push --set-upstream origin fix/short-description
```

Open a PR against **`WhiteTowerAI/ohmygame:dev`**. Use a Conventional Commit
title, such as `fix(runtime): handle missing tween state` or
`docs(contributing): clarify local setup`.

Fill in the PR template with what changed, why it changed, and how it was
checked. Link related issues; use `Closes #123` only when the PR fully resolves
the issue. Record the commands, results, skipped checks, and any manual
verification still needed. Include screenshots or a short recording for UI
changes.

Draft PRs are welcome for early feedback. Mark the PR ready when its intended
scope is complete. Respond to review comments and push follow-up changes to
the same branch. If it needs to catch up with development:

```bash
git fetch upstream
git merge upstream/dev
```

Resolve conflicts and rerun the affected checks. If you get stuck, explain the
blocker in the PR; maintainers can help narrow the remaining work. Maintainers
review scope, behavior, and verification before merging. See
[review and merge](docs/maintaining.md#review-and-merge) for that process.

## Configuration

Local development works with the defaults above. Use [.env.example](.env.example)
for optional local data directories; do not commit their contents. There are no
login, telemetry, Cloud API or updater variables for this edition. Adding legacy
variables cannot re-enable these paths. Configure reviewed model endpoints and
API keys through the application; OAuth, ambient credentials and executable
credential resolvers are unavailable. See [local security
policy](docs/local-security.md) before configuring model access.

### Projects, proxies, and desktop packaging

- Removing a project that uses an existing workspace folder never deletes
  that folder.
- Network defaults to Direct. Select Automatic in **Settings → Network** to
  honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (either case), or select Manual
  to set a proxy URL. Local traffic bypasses the proxy. See
  [network proxy](docs/runtime.md#network-proxy).
- The desktop app manages its own authenticated daemon; the renderer has no
  Node.js access.
- Local packaging retains license notices and does not publish to author feeds.
  The retained upstream signing/update instructions do not apply to this edition;
  see [desktop releases](docs/desktop-releases.md).

## Security and license

Report security issues privately using [SECURITY.md](SECURITY.md).
By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
