import { mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentProcessOptions } from "./process.js";
import { AgentRuntimeCompatibilityError } from "./compatibility.js";

// The native tool inventory is version-specific. Re-audit against a mock model before widening this.
export const CONTROLLED_CODEX_VERSION = "0.167.0-alpha.3.2";
export const CODEX_TOOL_NAMESPACE = "ohmygame";
const CONTROLLED_CODEX_SHA256 =
  "a636331ed87605efc4cf84028ac2884a75363f9d10ead63cffb57ea0016d486e";
const CONTROLLED_CODEX_HOST_SHA256 =
  "c0285b76616ed906bfcbb353fe46f64dcbc577113fc8836f9ab6da530438dbdc";
export const CODEX_CONTROLLED_CONFIG: Record<string, unknown> = {
  model_provider: "openai",
  cli_auth_credentials_store: "file",
  chatgpt_base_url: "https://chatgpt.com/backend-api/",
  check_for_update_on_startup: false,
  web_search: "disabled",
  notify: [],
  mcp_servers: {},
  "analytics.enabled": false,
  "feedback.enabled": false,
  "otel.exporter": "none",
  "otel.trace_exporter": "none",
  "otel.metrics_exporter": "none",
  "skills.bundled.enabled": false,
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.shell_snapshot": false,
  "features.image_generation": false,
  "features.view_image": false,
  "features.apps": false,
  "features.plugins": false,
  "features.remote_plugin": false,
  "features.hooks": false,
  "features.computer_use": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.in_app_browser": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.memories": false,
  "features.request_permissions_tool": false,
  "features.skill_mcp_dependency_install": false,
  "features.skip_host_skill_discovery": true,
  "features.skill_search": false,
  "features.tool_suggest": false,
  // Code Mode runs pure JavaScript to dispatch tools; it does not enable host shell execution.
  "features.code_mode.enabled": true,
  "features.code_mode.excluded_tool_namespaces": [
    "functions",
    "collaboration",
    "web",
    "clock",
  ],
  "features.code_mode_host.enabled": true,
  "features.code_mode_host.disable_in_process_fallback": true,
  "features.workspace_dependencies": false,
  "features.goals": false,
  "features.sleep_tool": false,
};

/** Separate sign-in and config; never copy the user's existing Codex credentials or configuration. */
export async function controlledCodexEnvironment(
  root: string,
): Promise<Record<string, string>> {
  const home = path.resolve(root, "codex-host-home");
  const config = path.resolve(root, "codex-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(config, { recursive: true, mode: 0o700 });
  return {
    HOME: home,
    CODEX_HOME: config,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
  };
}

export function requireControlledCodexVersion(version?: string): void {
  if (process.platform !== "darwin" || version !== CONTROLLED_CODEX_VERSION)
    throw new AgentRuntimeCompatibilityError(
      `The controlled Codex connection currently requires macOS and CLI ${CONTROLLED_CODEX_VERSION}. This installation has not passed its tool-isolation check.`,
      "controlled Codex tool isolation",
    );
}

export async function verifyControlledCodexBinary(
  binary: string,
): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  if (
    process.platform !== "darwin" ||
    hash.digest("hex") !== CONTROLLED_CODEX_SHA256
  )
    throw new AgentRuntimeCompatibilityError(
      "This executable has not passed OhMyGame's controlled Codex audit. Select the audited native executable from the ChatGPT app; shell launchers and newer binaries require a new isolation check.",
      "controlled Codex executable",
    );
  // The bundled CLI resolves its separate V8 runner from this fixed package bin directory.
  const host = path.resolve(
    path.dirname(binary),
    "../../../bin/codex-code-mode-host",
  );
  const hostHash = createHash("sha256");
  let hostMatches = false;
  try {
    for await (const chunk of createReadStream(host)) hostHash.update(chunk);
    hostMatches = hostHash.digest("hex") === CONTROLLED_CODEX_HOST_SHA256;
  } catch {
    /* Missing or unreadable runners fail the same compatibility check. */
  }
  if (!hostMatches)
    throw new AgentRuntimeCompatibilityError(
      "This Codex Code Mode runner has not passed OhMyGame's controlled-tool audit. Restore the audited ChatGPT CLI installation before reconnecting.",
      "controlled Codex Code Mode runner",
    );
}

export function requireControlledCodexConfig(
  config: Record<string, unknown> | undefined,
): void {
  // The built-in provider chooses its endpoint from the login mode; an API override breaks ChatGPT sign-in.
  if (config?.openai_base_url != null)
    throw new AgentRuntimeCompatibilityError(
      "Codex must use its default endpoint for the active authentication method. Custom OpenAI routing is unavailable in this connection.",
      "controlled Codex authentication routing",
    );
  if ((config?.model_providers as Record<string, unknown> | undefined)?.openai)
    throw new AgentRuntimeCompatibilityError(
      "Custom OpenAI routing is unavailable in the controlled Codex connection.",
      "controlled Codex configuration",
    );
  for (const [key, expected] of Object.entries(CODEX_CONTROLLED_CONFIG)) {
    if (key === "mcp_servers") continue;
    const actual = key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        config,
      );
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new AgentRuntimeCompatibilityError(
        `Codex did not apply the controlled setting ${key}. No model request was sent.`,
        "controlled Codex configuration",
      );
  }
}

const launches = new WeakSet<AgentProcessOptions>();

/** Only this fixed app-server launch may cross the disabled arbitrary-process boundary. */
export function controlledCodexProcess(
  options: Omit<AgentProcessOptions, "args">,
): AgentProcessOptions {
  if (
    !options.env.CODEX_HOME ||
    !options.env.HOME ||
    !path.isAbsolute(options.env.CODEX_HOME)
  )
    throw new Error("Codex requires a private configuration directory");
  const launch: AgentProcessOptions = {
    ...options,
    args: [
      "app-server",
      ...Object.entries(CODEX_CONTROLLED_CONFIG).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
    ],
  };
  launches.add(launch);
  return launch;
}

export function isControlledCodexProcess(
  options: AgentProcessOptions,
): boolean {
  return launches.has(options);
}
