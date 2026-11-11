import { assertLocalExecutionAllowed, LOCAL_EXECUTION_ENABLED } from "../local-execution-policy.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentModel, AgentUsageLimit } from "../../shared/contracts.js";
import {
  AGENT_RUNTIME_IDS,
  isAgentRuntimeId,
  type AgentRuntimeDiagnostic,
  type AgentRuntimeId,
  type AgentRuntimeLoginResponse,
  type AgentRuntimeStatus,
  type ApprovalDecision,
  type ApprovalRequestDetails,
  type UpdateAgentRuntimeRequest,
} from "../../shared/agent-runtimes.js";
import type { SkillCatalogItem } from "../agent.js";
import { AutoContinueTools } from "../agent-auto-continue.js";
import type { EffectiveMcpConfig, PluginMcpHost } from "../plugin-mcp-host.js";
import { AGENT_RUNTIME_DEFINITIONS, commandSandbox } from "./definitions.js";
import {
  AgentRuntimeCompatibilityError,
  AgentRuntimeProbeError,
  checkRuntimeVersionRequirement,
  runtimeStartupError,
} from "./compatibility.js";
import {
  privateFolder,
  isCodexNpmShim,
  probeAuth,
  probeModels,
  probeVersion,
  resolveBinary,
  type AuthProbe,
} from "./discovery.js";
import { agentEnvironment, loginShellPath } from "./environment.js";
import { AgentProcess, stopAgentProcesses } from "./process.js";
import {
  recoverAgentProcesses,
  recoverAgentDirectories,
} from "./process-recovery.js";
import { NativeCodingSession, type NativeDriver } from "./native-session.js";
import { ToolBridge } from "./tool-bridge.js";
import type { DriverContext, HttpBridgeHandlers, SaveGeneratedImage } from "./driver-context.js";
import type { AgentPolicyContext } from "./policy.js";
import { AgentRuntimeSettingsStore } from "./settings.js";
import { stagedSkillsRoot } from "./skills.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { CodexAppServer } from "./codex-app-server.js";
import { CodexDriver } from "./codex.js";
import { controlledCodexEnvironment, requireControlledCodexVersion, verifyControlledCodexBinary, CONTROLLED_CODEX_VERSION } from "./controlled-codex.js";
import { OpenCodeDriver } from "./opencode.js";
import { QoderConnection, QoderDriver } from "./qoder.js";
import { controlledQoderEnvironment, resolveControlledQoder, CONTROLLED_QODER_VERSION } from "./controlled-qoder.js";

const STATUS_TTL_MS = 60_000;

/**
 * Coding agents see OhMyGame's tools under their CLI's MCP names and follow
 * their own planning habits, such as plan files; Pi needs neither line.
 */
const NATIVE_INSTRUCTIONS =
  "OhMyGame's own tools (canvas checks, image, video, 3D and audio generation, game playtesting, questionnaire, update_plan and plugin services) come from its ohmygame tool server; your CLI may name them with a prefix such as mcp__ohmygame__ or ohmygame_. In a planning turn, record the plan with update_plan before you finish, rather than writing a plan file or only describing it. The Skills your CLI lists are readable where it lists them, even outside the workspace: read a Skill's files directly when a request calls for it.";
const MODELS_TTL_MS = 10 * 60_000;
const MODELS_WAIT_MS = 6_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface ProbeCache {
  signature: string;
  version?: string;
  auth: AuthProbe;
  diagnostics: AgentRuntimeDiagnostic[];
  checkedAt: number;
  requirementError?: Error;
}

interface QoderAccountProbe {
  cancelled: boolean;
  signature: string;
  connection?: QoderConnection;
  stopping?: Promise<void>;
}

export interface NativeSessionRequest {
  runtime: AgentRuntimeId;
  model: string;
  reasoningLevel?: string;
  contextWindow?: number;
  workspacePath: string;
  sessionManager: SessionManager;
  /** OhMyGame's tools for the project, as Pi gets them. */
  tools: ToolDefinition[];
  saveGeneratedImage?: SaveGeneratedImage;
  pluginMcp?: {
    config: EffectiveMcpConfig;
    host: PluginMcpHost;
    agentDir: string;
  };
  skillDirectories: string[];
  instructions: string;
  policy: AgentPolicyContext;
  snapshotBeforeMessage?: () => Promise<string>;
  turnNotice?: () => Promise<string | undefined>;
  requestApproval(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  skills?: () => SkillCatalogItem[];
}

/**
 * The coding agents OhMyGame can run conversations with. Nothing here runs
 * until something asks. Conversation model discovery only probes enabled
 * agents; the image catalog can independently probe Codex for media use.
 * A slow or broken CLI only delays its own status and models.
 */
export class AgentRuntimeService {
  readonly settings: AgentRuntimeSettingsStore;
  #revisions = new Map<AgentRuntimeId, number>();
  #configurationRevisions = new Map<AgentRuntimeId, number>();
  #probes = new Map<AgentRuntimeId, ProbeCache>();
  #probing = new Map<AgentRuntimeId, Promise<ProbeCache | undefined>>();
  #qoderProbe?: QoderAccountProbe;
  #closed = false;
  #models = new Map<
    AgentRuntimeId,
    { signature: string; models: AgentModel[]; at: number }
  >();
  #modelLoads = new Map<AgentRuntimeId, Promise<AgentModel[]>>();
  #bridges = new Map<
    string,
    { bridge: ToolBridge; handlers: HttpBridgeHandlers }
  >();
  #modelErrors = new Map<
    AgentRuntimeId,
    {
      signature: string;
      at: number;
      diagnostic: AgentRuntimeDiagnostic;
      cause?: Error;
    }
  >();
  /** Each account's quota windows as last reported; they outlive the conversation that reported them. */
  #limits = new Map<AgentRuntimeId, AgentUsageLimit[]>();
  #limitWrites: Promise<void> = Promise.resolve();
  readonly #root: string;

  constructor(
    dataDirectory: string,
    private readonly bridgeUrl: () => string | undefined,
  ) {
    this.settings = new AgentRuntimeSettingsStore(dataDirectory);
    this.#root = path.join(dataDirectory, "agent-runtimes");
  }

  async load(): Promise<void> {
    await this.settings.load();
    await recoverAgentProcesses(path.join(this.#root, "processes"));
    await recoverAgentDirectories(path.join(this.#root, "sessions"));
    await recoverAgentDirectories(path.join(this.#root, "probes"));
    try {
      const stored = JSON.parse(
        await readFile(path.join(this.#root, "limits.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const [id, limits] of Object.entries(stored))
        if (isAgentRuntimeId(id) && Array.isArray(limits))
          this.#limits.set(id, limits.filter(isUsageLimit));
    } catch {
      // No limits reported yet, or a damaged file: they arrive with the next report.
    }
  }

  /** Keeps the latest quota windows across restarts, since Claude Code reports them only during a conversation. */
  #recordLimits(id: AgentRuntimeId, limits: AgentUsageLimit[]): void {
    this.#limits.set(id, limits);
    this.#limitWrites = this.#limitWrites
      .then(async () => {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(this.#root, "limits.json"),
          `${JSON.stringify(Object.fromEntries(this.#limits))}\n`,
        );
      })
      .catch(() => {});
  }

  async statuses(recheck = false): Promise<AgentRuntimeStatus[]> {
    return Promise.all(AGENT_RUNTIME_IDS.map((id) => this.status(id, recheck)));
  }

  async #qoderStatus(recheck: boolean): Promise<AgentRuntimeStatus> {
    const id = "qoder-cli";
    const revision = this.#revisions.get(id);
    const settings = this.settings.get(id);
    const current = () => this.#revisions.get(id) === revision && this.settings.get(id).enabled === settings.enabled
      && this.settings.get(id).binaryPath === settings.binaryPath;
    const base = { id: "qoder-cli" as const, name: "Qoder", enabled: settings.enabled,
      testedVersion: CONTROLLED_QODER_VERSION, commandSandbox: "none" as const, permissionMode: "standard" as const,
      ...(settings.binaryPath ? { configuredBinaryPath: settings.binaryPath } : {}) };
    let binary: Awaited<ReturnType<typeof resolveControlledQoder>>;
    try { binary = await resolveControlledQoder(settings.binaryPath); }
    catch {
      if (!current()) return this.#qoderStatus(false);
      if (this.#probes.has(id) || this.#models.has(id) || (this.#qoderProbe && !this.#qoderProbe.cancelled)) this.#invalidate(id);
      return { ...base, installed: false, auth: { status: "unknown", billing: "unknown" },
        diagnostics: [{ code: "runtime-incompatible", message: "The reviewed Qoder SDK/native installation is unavailable. No program was started." }] };
    }
    if (!current()) return this.#qoderStatus(false);
    if (!binary) {
      if (this.#probes.has(id) || this.#models.has(id) || (this.#qoderProbe && !this.#qoderProbe.cancelled)) this.#invalidate(id);
      return { ...base, installed: false, auth: { status: "unknown", billing: "unknown" },
        diagnostics: [{ code: "not-installed", message: "Install the reviewed Qoder SDK 1.0.59 and native runtime 1.1.83 separately." }] };
    }
    if (this.#qoderProbe && !this.#qoderProbe.cancelled && this.#qoderProbe.signature !== binary.signature) {
      this.#invalidate(id);
      return this.#qoderStatus(false);
    }
    let cached = this.#probes.get(id);
    if (cached?.signature !== binary.signature) {
      cached = undefined;
      this.#probes.delete(id);
      this.#models.delete(id);
    }
    if (!this.#closed && (recheck || (settings.enabled && !cached))) {
      cached = await this.#probeQoder(binary);
      if (!current() || (!this.#closed && settings.enabled && !cached)) return this.#qoderStatus(false);
    }
    return { ...base, installed: true, binaryPath: binary.path, binarySource: binary.source, version: binary.version,
      auth: cached?.auth ?? { status: "unknown", billing: "unknown" },
      diagnostics: cached?.diagnostics ?? [{ code: "check-required", message: "Qoder sign-in has not been checked in this app session. Check again to verify the existing sign-in before selecting a model." }],
      ...(cached ? { checkedAt: new Date(cached.checkedAt).toISOString() } : {}) };
  }

  /** Revalidate an enabled agent's existing sign-in once per daemon, without constructing a model query. */
  #probeQoder(binary: NonNullable<Awaited<ReturnType<typeof resolveControlledQoder>>>): Promise<ProbeCache | undefined> {
    const id = "qoder-cli";
    const running = this.#probing.get(id);
    if (running) return running;
    const revision = this.#revisions.get(id);
    const settings = this.settings.get(id);
    const state: QoderAccountProbe = { cancelled: false, signature: binary.signature };
    this.#qoderProbe = state;
    const active = () => !this.#closed && !state.cancelled && this.#revisions.get(id) === revision
      && this.settings.get(id).enabled === settings.enabled && this.settings.get(id).binaryPath === settings.binaryPath;
    const assertActive = () => { if (!active()) throw new Error("The Qoder account check was cancelled"); };
    const work = (async (): Promise<ProbeCache | undefined> => {
      let folder: Awaited<ReturnType<typeof privateFolder>> | undefined;
      let phase: "startup" | "account" | "models" = "startup";
      let verifiedAuth: AuthProbe = { status: "unknown", billing: "unknown" };
      let models: AgentModel[] | undefined;
      let diagnostics: AgentRuntimeDiagnostic[] = [];
      const failed = (): AgentRuntimeDiagnostic[] => [{
        code: phase === "models" ? "models-unavailable" : "probe-failed", message: phase === "models"
          ? "Qoder sign-in was verified, but its model catalog could not be checked. Check again; no model task was sent."
          : "Qoder sign-in could not be verified. Check again before preparing another sign-in; no model task was sent.",
      }];
      try {
        assertActive();
        await mkdir(path.join(this.#root, "probes"), { recursive: true, mode: 0o700 });
        assertActive();
        folder = await privateFolder(path.join(this.#root, "probes"), id);
        assertActive();
        const env = await controlledQoderEnvironment(this.#root);
        assertActive();
        state.connection = new QoderConnection({ binaryPath: binary.path, env, privateDirectory: folder.path,
          processDirectory: path.join(this.#root, "processes") }, () => {});
        await state.connection.start();
        assertActive();
        phase = "account";
        const rawAccount = await state.connection.request("account/read");
        assertActive();
        const account = rawAccount && typeof rawAccount === "object" ? rawAccount as Record<string, unknown> : {};
        if (typeof account.userId !== "string" || !account.userId.trim()) throw new Error("Qoder sign-in has not been verified");
        verifiedAuth = { status: "signed-in", billing: "unknown" };
        phase = "models";
        const catalog = await state.connection.request("models/list", { live: true });
        assertActive();
        models = qoderModels(catalog);
        if (!models.length) diagnostics = [{ code: "models-unavailable", message: "Qoder returned no available models" }];
      } catch {
        models = undefined;
        diagnostics = failed();
      } finally {
        // Cleanup failures must not turn every subsequent status read into another account request.
        try { await (state.stopping ?? state.connection?.stop()); } catch { models = undefined; diagnostics = failed(); }
        try { await folder?.remove(); } catch { models = undefined; diagnostics = failed(); }
      }
      if (!active()) return undefined;
      const cached = { signature: binary.signature, version: binary.version, auth: verifiedAuth, diagnostics, checkedAt: Date.now() };
      if (models) this.#models.set(id, { signature: binary.signature, models, at: Date.now() });
      else this.#models.delete(id);
      this.#probes.set(id, cached);
      return cached;
    })().finally(() => {
      if (this.#probing.get(id) === work) this.#probing.delete(id);
      if (this.#qoderProbe === state) this.#qoderProbe = undefined;
    });
    this.#probing.set(id, work);
    return work;
  }

  #cancelQoderProbe(): void {
    if (!this.#qoderProbe) return;
    this.#qoderProbe.cancelled = true;
    if (this.#qoderProbe.connection && !this.#qoderProbe.stopping) {
      this.#qoderProbe.stopping = this.#qoderProbe.connection.stop();
      void this.#qoderProbe.stopping.catch(() => {});
    }
  }

  /** Media can use Codex's sign-in without enabling it as a conversation agent. */
  async codexImageConnection(recheck = false) {
    if (!LOCAL_EXECUTION_ENABLED) return undefined;
    const binary = await resolveBinary("codex-cli", this.settings.get("codex-cli").binaryPath, recheck);
    if (!binary) return undefined;
    const probe = await this.#probe("codex-cli", binary, recheck);
    return {
      ...binary,
      env: await this.#environment("codex-cli", binary.path),
      auth: probe?.auth,
      error: probe?.requirementError?.message,
    };
  }

  async status(
    id: AgentRuntimeId,
    recheck = false,
  ): Promise<AgentRuntimeStatus> {
    if (id === "qoder-cli") return this.#qoderStatus(recheck);
    if (id !== "codex-cli" && !LOCAL_EXECUTION_ENABLED) return {
      id, name: AGENT_RUNTIME_DEFINITIONS[id].name, enabled: false, installed: false,
      commandSandbox: "none", permissionMode: "standard",
      auth: { status: "unknown", billing: "unknown" },
      diagnostics: [{ code: "runtime-incompatible", message: "Native CLI execution is temporarily unavailable pending isolated execution." }],
    };
    if (recheck) this.#invalidate(id);
    const revision = this.#revisions.get(id);
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const settings = this.settings.get(id);
    const binary = await resolveBinary(id, settings.binaryPath, recheck);
    if (this.#revisions.get(id) !== revision) return this.status(id);
    const limits = this.#limits.get(id);
    const base = {
      id,
      name: definition.name,
      testedVersion: id === "codex-cli" ? CONTROLLED_CODEX_VERSION : definition.testedVersion,
      enabled: settings.enabled,
      commandSandbox: commandSandbox(id),
      permissionMode: id === "codex-cli" ? "standard" as const : settings.permissionMode,
      ...(settings.binaryPath
        ? { configuredBinaryPath: settings.binaryPath }
        : {}),
      ...(limits?.length ? { limits } : {}),
    };
    if (!binary) {
      return {
        ...base,
        installed: false,
        auth: { status: "unknown", billing: "unknown" },
        diagnostics: [
          {
            code: settings.binaryPath ? "invalid-executable" : "not-installed",
            message: settings.binaryPath
              ? `The configured executable is missing or not executable: ${settings.binaryPath}`
              : `${definition.name} was not found on PATH or in the usual install folders`,
            ...(!settings.binaryPath ? { command: definition.installUrl } : {}),
          },
        ],
      };
    }
    const probe = await this.#probe(id, binary, recheck);
    if (this.#revisions.get(id) !== revision) return this.status(id);
    // Enabling or rechecking a CLI checks the same protocol used by model
    // discovery. A timeout remains a probe/catalog failure, not incompatibility.
    if (settings.enabled && probe?.auth.status === "signed-in") await this.#loadModels(id).catch(() => {});
    if (this.#revisions.get(id) !== revision) return this.status(id);
    return {
      ...base,
      installed: true,
      binaryPath: binary.path,
      binarySource: binary.source,
      ...(probe?.version ? { version: probe.version } : {}),
      auth: probe
        ? {
            status: probe.auth.status,
            billing: probe.auth.billing,
            ...(probe.auth.account ? { account: probe.auth.account } : {}),
          }
        : { status: "unknown", billing: "unknown" },
      diagnostics: [
        ...(probe?.diagnostics ?? [
          {
            code: "probe-failed",
            message: `${definition.name} did not answer`,
          },
        ]),
        ...(this.#modelErrors.has(id)
          ? [this.#modelErrors.get(id)!.diagnostic]
          : []),
      ],
      ...(probe ? { checkedAt: new Date(probe.checkedAt).toISOString() } : {}),
    };
  }

  async update(
    id: AgentRuntimeId,
    request: UpdateAgentRuntimeRequest,
  ): Promise<AgentRuntimeStatus> {
    const previous = this.settings.get(id);
    if (request.enabled && id !== "codex-cli" && id !== "qoder-cli") assertLocalExecutionAllowed("Native CLI execution");
    if ((id === "codex-cli" || id === "qoder-cli") && request.permissionMode === "full") throw new Error("This agent uses controlled project tools; Full access is unavailable.");
    if (
      request.binaryPath !== undefined &&
      request.binaryPath !== "" &&
      !path.isAbsolute(request.binaryPath)
    )
      throw new Error("The executable path must be absolute");
    // Codex shims (.cmd/.ps1) resolve to the packaged native executable; other
    // CLIs still require a direct .exe path.
    const isCodexShim =
      id === "codex-cli" &&
      request.binaryPath &&
      isCodexNpmShim(request.binaryPath);
    if (
      request.binaryPath &&
      /\.(?:cmd|bat|ps1)$/i.test(request.binaryPath) &&
      !isCodexShim
    )
      throw new Error(
        "Choose the program itself (.exe); Windows command scripts cannot be started directly",
      );
    await this.settings.update(id, {
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.permissionMode !== undefined
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.binaryPath !== undefined
        ? { binaryPath: request.binaryPath }
        : {}),
    });
    if ((request.enabled !== undefined && request.enabled !== previous.enabled) ||
      (request.binaryPath !== undefined && request.binaryPath !== previous.binaryPath) ||
      (request.permissionMode !== undefined && request.permissionMode !== previous.permissionMode))
      this.#configurationRevisions.set(id, (this.#configurationRevisions.get(id) ?? 0) + 1);
    if (id !== "qoder-cli" || request.binaryPath !== undefined || (this.#qoderProbe && request.enabled !== undefined && request.enabled !== previous.enabled)) this.#invalidate(id);
    return this.status(id, id !== "qoder-cli" && request.binaryPath !== undefined);
  }

  /** Models of the enabled agents that are installed. One that is slow to answer is left out this time, not waited for. */
  async models(): Promise<{ models: AgentModel[]; loading: AgentRuntimeId[] }> {
    const loading: AgentRuntimeId[] = [];
    const lists = await Promise.all(
      AGENT_RUNTIME_IDS.map(async (id) => {
        if ((id !== "codex-cli" && id !== "qoder-cli" && !LOCAL_EXECUTION_ENABLED) || !this.settings.get(id).enabled) return [];
        const load = this.#loadModels(id).catch(() => [] as AgentModel[]);
        const late = Symbol("late");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          load,
          new Promise<typeof late>((resolve) => {
            timer = setTimeout(() => resolve(late), MODELS_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (result !== late) return result;
        loading.push(id);
        return [];
      }),
    );
    return { models: lists.flat(), loading };
  }

  async model(
    id: AgentRuntimeId,
    modelId: string,
  ): Promise<AgentModel | undefined> {
    if (id !== "codex-cli" && id !== "qoder-cli" && !LOCAL_EXECUTION_ENABLED) return undefined;
    if (!this.settings.get(id).enabled) return undefined;
    const models = await this.#loadModels(id).catch(() => []);
    return models.find((model) => model.id === modelId);
  }

  /** Starts the CLI's own sign-in. A browser page comes back when the CLI hands one out; otherwise the command to run. */
  async login(id: AgentRuntimeId): Promise<AgentRuntimeLoginResponse> {
    if (id === "qoder-cli") {
      const binary = await resolveControlledQoder(this.settings.get(id).binaryPath);
      if (!binary) throw new Error("Install the reviewed Qoder SDK and runtime before preparing sign-in");
      const env = await controlledQoderEnvironment(this.#root);
      const loginDirectory = path.join(env.HOME!, "login");
      await mkdir(loginDirectory, { recursive: true, mode: 0o700 });
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      return { command: `/usr/bin/env -i ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(binary.path)} --cwd ${quote(loginDirectory)} login` };
    }
    if (id !== "codex-cli") assertLocalExecutionAllowed("Native CLI sign-in");
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath);
    if (!binary) throw new Error(`${definition.name} is not installed`);
    if (id === "codex-cli") {
      const probe = await this.#probe(id, binary, true);
      if (probe?.requirementError) throw probe.requirementError;
    }
    const env = await this.#environment(id, binary.path);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const forget = () => this.#invalidate(id);
    if (id === "codex-cli") {
      const server = new CodexAppServer(binary.path, this.#root, env, {
        notification: (method) => {
          if (method !== "account/login/completed") return;
          forget();
          void server.stop();
        },
      });
      setTimeout(() => {
        void server.stop();
      }, LOGIN_TIMEOUT_MS).unref();
      try {
        await server.initialize();
        const started = await server.request<{ authUrl?: unknown }>(
          "account/login/start",
          { type: "chatgpt" },
        );
        if (typeof started.authUrl !== "string") throw new Error("Codex did not provide a browser sign-in URL. Check the connection and try again.");
        return { url: started.authUrl };
      } catch (cause) {
        await server.stop();
        throw cause;
      }
    }
    if (id === "claude-code-cli") {
      return new Promise((resolve) => {
        let found = false;
        const child = new AgentProcess({
          binaryPath: binary.path,
          args: ["auth", "login", "--claudeai"],
          cwd: this.#root,
          env,
          onLine: (line) => {
            const url = line.match(/https:\/\/\S+/)?.[0];
            if (!url || found) return;
            found = true;
            resolve({ url });
          },
          onExit: () => {
            forget();
            if (!found) resolve({ command: definition.loginCommand });
          },
        });
        setTimeout(() => {
          if (!found) {
            found = true;
            resolve({ command: definition.loginCommand });
          }
        }, 15_000).unref();
        setTimeout(() => {
          void child.stop();
        }, LOGIN_TIMEOUT_MS).unref();
      });
    }
    return { command: definition.loginCommand };
  }

  async createSession(
    request: NativeSessionRequest,
  ): Promise<NativeCodingSession> {
    if (request.runtime !== "codex-cli" && request.runtime !== "qoder-cli") assertLocalExecutionAllowed("Native CLI execution");
    const settings = this.settings.get(request.runtime);
    const definition = AGENT_RUNTIME_DEFINITIONS[request.runtime];
    if (!settings.enabled)
      throw new Error(
        `${definition.name} is turned off. Turn it on in Providers & Models to continue.`,
      );
    if (request.runtime === "qoder-cli") await this.#qoderStatus(false);
    const binary = request.runtime === "qoder-cli" ? await resolveControlledQoder(settings.binaryPath) : await resolveBinary(request.runtime, settings.binaryPath);
    if (!binary)
      throw new Error(
        `${definition.name} is not installed. Install it, then check again in Providers & Models.`,
      );
    const probe = request.runtime === "qoder-cli" ? this.#probes.get("qoder-cli") : await this.#probe(request.runtime, binary, false);
    if (request.runtime === "qoder-cli" && (this.#closed || !this.settings.get(request.runtime).enabled || (probe && probe.signature !== binary.signature)))
      throw new AgentRuntimeProbeError("The Qoder setup changed during its account check. Check again before sending a prompt; no model task was sent.");
    if (probe?.requirementError) throw probe.requirementError;
    if (probe?.auth.status !== "signed-in") {
      if (request.runtime === "qoder-cli" && probe?.auth.status !== "signed-out")
        throw new AgentRuntimeProbeError("Qoder sign-in has not been verified in this app session. Check again in Settings → Agents before sending a prompt; no model task was sent.");
      throw new Error("Sign in to the separate OhMyGame agent connection, then check again in Settings → Agents before sending a prompt.");
    }
    // Do not offer a catalog during setup then reject the same CLI only after
    // its first message. This uses the discovery cache and sends no model turn.
    let supportsImages = false;
    try {
      const models = await this.#loadModels(request.runtime);
      supportsImages = models.find(model => model.id === request.model)?.supportsImages === true;
      if (request.runtime === "qoder-cli" && !models.some(model => model.id === request.model))
        throw new AgentRuntimeProbeError("Qoder's current model catalog has not verified the selected model. Check again in Settings → Agents; no model task was sent.");
    } catch (cause) {
      throw runtimeStartupError(cause);
    }
    await mkdir(path.join(this.#root, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const folder = await privateFolder(
      path.join(this.#root, "sessions"),
      request.runtime,
    );
    let pluginTool:
      { tool: ToolDefinition; close: () => Promise<void> } | undefined;
    try {
      if (
        request.runtime !== "codex-cli" && request.runtime !== "qoder-cli" && request.pluginMcp &&
        Object.keys(request.pluginMcp.config.mcpServers).length
      ) {
        pluginTool = await request.pluginMcp.host.tool(
          request.pluginMcp.config,
          request.pluginMcp.agentDir,
        );
      }
    } catch {
      // Plugin servers that cannot start leave the agent without them, as a failed MCP server does in Pi.
      pluginTool = undefined;
    }
    const admissionRevision = this.#configurationRevisions.get(request.runtime);
    const admissionPolicy = JSON.stringify(request.policy);
    const currentSettings = () => {
      const current = this.settings.get(request.runtime);
      return !this.#closed && current.enabled && current.binaryPath === settings.binaryPath &&
        current.permissionMode === settings.permissionMode && this.#configurationRevisions.get(request.runtime) === admissionRevision &&
        JSON.stringify(request.policy) === admissionPolicy;
    };
    const assertToolOwner = () => {
      if (!currentSettings()) throw new Error("The agent connection changed; controlled tool dispatch was stopped");
    };
    let taskAccount: ProbeCache | undefined;
    const beginTask = () => { assertToolOwner(); taskAccount = this.#probes.get(request.runtime); };
    const assertContinuation = async () => {
      const valid = () => {
        const account = this.#probes.get(request.runtime);
        const catalog = this.#models.get(request.runtime);
        return currentSettings() && account === taskAccount &&
          account?.signature === binary.signature && account.auth.status === "signed-in" && catalog?.signature === binary.signature &&
          catalog.models.some(model => model.id === request.model);
      };
      if (!valid()) throw new Error("The agent connection changed; automatic continuation was stopped");
      // Static detection only: never sign in, launch a probe, or refresh a remote catalog here.
      const currentBinary = request.runtime === "qoder-cli" ? await resolveControlledQoder(settings.binaryPath) : await resolveBinary(request.runtime, settings.binaryPath);
      if (!valid() || currentBinary?.signature !== binary.signature)
        throw new Error("The controlled agent runtime changed; automatic continuation was stopped");
    };
    const continuationTools = new AutoContinueTools([
      ...request.tools,
      ...(pluginTool ? [pluginTool.tool] : []),
    ], { sessionManager: request.sessionManager, assertCurrent: assertToolOwner });
    let nativeSession: NativeCodingSession | undefined;
    const guardedTools = continuationTools.wrap();
    const bridge = new ToolBridge(guardedTools, request.runtime === "qoder-cli", request.runtime === "codex-cli" || request.runtime === "qoder-cli", { getBranch: () => request.sessionManager.getBranch() }, () => {
      assertToolOwner();
      const catalog = this.#models.get(request.runtime);
      const verifiedImages = catalog?.signature === binary.signature && catalog.models.find(model => model.id === request.model)?.supportsImages === true;
      return { id: request.model, provider: request.runtime, input: verifiedImages ? ["text", "image"] : ["text"] };
    });
    const env = await this.#environment(request.runtime, binary.path);
    const revoke = new Set<() => void>();
    const context = (
      resume: string | undefined,
      model: string,
      reasoningLevel: string | undefined,
    ): DriverContext => ({
      binaryPath: binary.path,
      workspacePath: request.workspacePath,
      env,
      privateDirectory: folder.path,
      processDirectory: path.join(this.#root, "processes"),
      instructions: `${request.instructions}\n\n${NATIVE_INSTRUCTIONS}\n\nUse only OhMyGame dynamic tools for project files, execution and media. All images, video, audio, 3D and generated text assets use the configured Kunpo tools. Never substitute native generation, shell, external MCP, browser or API requests. Recover existing media jobs by ID; never resubmit a job with an unknown outcome.`,
      bridge,
      saveGeneratedImage: request.saveGeneratedImage,
      policy: {
        ...request.policy,
        fullAccess: false,
        // Claude Code runs every command in its sandbox. Codex asks only for
        // what would leave its sandbox, so its requests are judged strictly.
        sandboxedCommands:
          settings.permissionMode === "standard" &&
          request.runtime === "claude-code-cli" &&
          commandSandbox(request.runtime) === "os",
        readablePaths: [
          stagedSkillsRoot(
            request.runtime,
            folder.path,
          ),
        ],
      },
      skillDirectories: [],
      httpBridge: async (handlers) => {
        const registered = this.#registerBridge(bridge, handlers);
        const stop = () => {
          registered.revoke();
          revoke.delete(stop);
        };
        revoke.add(stop);
        handlers.signal.addEventListener("abort", () => revoke.delete(stop), {
          once: true,
        });
        return { ...registered, revoke: stop };
      },
      model,
      ...(request.contextWindow
        ? { contextWindow: request.contextWindow }
        : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      ...(resume ? { resume } : {}),
    });
    const createDriver = (
      resume: string | undefined,
      current: { model: string; reasoningLevel?: string },
    ): NativeDriver => {
      const driverContext = context(
        resume,
        current.model,
        current.reasoningLevel,
      );
      if (request.runtime === "claude-code-cli")
        return new ClaudeCodeDriver(driverContext);
      if (request.runtime === "codex-cli")
        return new CodexDriver(driverContext);
      if (request.runtime === "qoder-cli")
        return new QoderDriver(driverContext);
      return new OpenCodeDriver(driverContext);
    };
    nativeSession = new NativeCodingSession({
      runtime: request.runtime,
      // Native tool schemas and image-preparation instructions are fixed at session creation.
      ...(request.runtime === "codex-cli" ? { contextVersion: "controlled-codex-v15" } : {}),
      // Retain the existing Skill restrictions while rebuilding older image/tool contracts.
      ...(request.runtime === "qoder-cli" ? { contextVersion: "controlled-qoder-v14" } : {}),
      model: request.model,
      supportsImages,
      ...(request.reasoningLevel
        ? { nativeReasoningLevel: request.reasoningLevel }
        : {}),
      sessionManager: request.sessionManager,
      continuationTools,
      assertContinuation,
      beginTask,
      createDriver,
      ...(request.snapshotBeforeMessage
        ? { snapshotBeforeMessage: request.snapshotBeforeMessage }
        : {}),
      ...(request.turnNotice ? { turnNotice: request.turnNotice } : {}),
      requestApproval: request.requestApproval,
      toolNames: bridge.names,
      setActiveTools: (names) => bridge.setActive(names),
      onLimits: (limits) => this.#recordLimits(request.runtime, limits),
      accountLimits: () => this.#limits.get(request.runtime),
      ...(request.skills ? { skills: request.skills } : {}),
      dispose: async () => {
        for (const stop of revoke) stop();
        await pluginTool?.close().catch(() => {});
        await folder.remove();
      },
    });
    return nativeSession;
  }

  /**
   * Answers an MCP request that came in over HTTP with a session's token.
   * The token is compared in constant time and works only while a turn of
   * that conversation runs; outside one, every call is refused.
   */
  async handleBridgeRequest(
    authorization: string | undefined,
    body: unknown,
  ): Promise<{ status: number; body?: unknown }> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const entry = token ? this.#bridgeFor(token) : undefined;
    if (!entry)
      return {
        status: 401,
        body: { error: "Unknown or revoked bridge token" },
      };
    const messages = Array.isArray(body) ? body : [body];
    const answers: unknown[] = [];
    for (const message of messages) {
      const method =
        message && typeof message === "object"
          ? (message as { method?: unknown }).method
          : undefined;
      if (
        method === "tools/call" &&
        (!entry.handlers.active() || entry.handlers.signal.aborted)
      ) {
        const id = (message as { id?: unknown }).id;
        answers.push({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "No turn of this conversation is running",
          },
        });
        continue;
      }
      const answer = await entry.bridge.handle(
        message,
        (call, outcome) => {
          if (!entry.handlers.signal.aborted && entry.handlers.active())
            entry.handlers.observe(call, outcome);
        },
        entry.handlers.signal,
      );
      if (answer) answers.push(answer);
    }
    if (!answers.length) return { status: 202 };
    return { status: 200, body: Array.isArray(body) ? answers : answers[0] };
  }

  /** Stops every CLI still running: sessions let go of theirs without waiting, sign-ins may still be open. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelQoderProbe();
    this.#bridges.clear();
    await stopAgentProcesses();
    await this.#probing.get("qoder-cli");
  }

  #registerBridge(
    bridge: ToolBridge,
    handlers: HttpBridgeHandlers,
  ): { url: string; token: string; revoke: () => void } {
    const base = this.bridgeUrl();
    if (!base) throw new Error("The daemon address is not known yet");
    const token = randomBytes(32).toString("base64url");
    this.#bridges.set(token, { bridge, handlers });
    const revoke = () => {
      this.#bridges.delete(token);
      handlers.signal.removeEventListener("abort", revoke);
    };
    if (handlers.signal.aborted) revoke();
    else handlers.signal.addEventListener("abort", revoke, { once: true });
    return {
      url: `${base}/agent-runtime-bridge/mcp`,
      token,
      revoke,
    };
  }

  #bridgeFor(
    token: string,
  ): { bridge: ToolBridge; handlers: HttpBridgeHandlers } | undefined {
    const presented = Buffer.from(token);
    for (const [candidate, entry] of this.#bridges) {
      const expected = Buffer.from(candidate);
      if (
        expected.length === presented.length &&
        timingSafeEqual(expected, presented)
      )
        return entry;
    }
    return undefined;
  }

  #invalidate(id: AgentRuntimeId): void {
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    this.#probes.delete(id);
    this.#models.delete(id);
    this.#modelErrors.delete(id);
    if (id === "qoder-cli") this.#cancelQoderProbe();
    else this.#probing.delete(id);
    this.#modelLoads.delete(id);
  }

  /** The CLI's executable and the environment its commands run in, or undefined when it is not installed. */
  async cli(
    id: AgentRuntimeId,
  ): Promise<{ path: string; env: Record<string, string> } | undefined> {
    if (!LOCAL_EXECUTION_ENABLED) return undefined;
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath);
    return binary
      ? { path: binary.path, env: await this.#environment(id, binary.path) }
      : undefined;
  }

  async #environment(
    id: AgentRuntimeId,
    binaryPath: string,
  ): Promise<Record<string, string>> {
    if (id === "codex-cli") return controlledCodexEnvironment(this.#root);
    if (id === "qoder-cli") return controlledQoderEnvironment(this.#root);
    return agentEnvironment(
      id,
      binaryPath,
      {},
      process.env,
      await loginShellPath(),
    );
  }

  async #probe(
    id: AgentRuntimeId,
    binary: { path: string; signature: string },
    recheck: boolean,
  ): Promise<ProbeCache | undefined> {
    const cached = this.#probes.get(id);
    if (
      !recheck &&
      cached?.signature === binary.signature &&
      Date.now() - cached.checkedAt < STATUS_TTL_MS
    )
      return cached;
    const running = this.#probing.get(id);
    if (running) return running;
    const revision = this.#revisions.get(id);
    const work = (async () => {
      const definition = AGENT_RUNTIME_DEFINITIONS[id];
      const env = await this.#environment(id, binary.path);
      const diagnostics: AgentRuntimeDiagnostic[] = [];
      let version: string | undefined;
      let auth: AuthProbe = { status: "unknown", billing: "unknown" };
      try {
        if (id === "codex-cli") await verifyControlledCodexBinary(binary.path);
        [version, auth] = await Promise.all([
          probeVersion(binary.path, id, env),
          probeAuth(binary.path, id, env),
        ]);
      } catch (cause) {
        diagnostics.push({
          code: "probe-failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
      let requirementError: Error | undefined;
      try {
        if (id === "codex-cli") requireControlledCodexVersion(version);
        checkRuntimeVersionRequirement(
          id,
          version,
          this.settings.get(id).permissionMode,
        );
      } catch (cause) {
        requirementError =
          cause instanceof Error ? cause : new Error(String(cause));
        diagnostics.push({
          code:
            cause instanceof AgentRuntimeCompatibilityError
              ? "runtime-incompatible"
              : "probe-failed",
          message: requirementError.message,
          ...(cause instanceof AgentRuntimeCompatibilityError &&
          cause.capability
            ? { capability: cause.capability }
            : {}),
        });
      }
      if (!version && !diagnostics.some((item) => item.code === "probe-failed"))
        diagnostics.push({
          code: "probe-failed",
          message: `${definition.name} did not return a readable version`,
        });
      if (auth.status === "signed-out")
        diagnostics.push({
          code: "signed-out",
          message: `${definition.name} is not signed in`,
          ...(id !== "codex-cli" ? { command: definition.loginCommand } : {}),
        });
      const result: ProbeCache = {
        signature: binary.signature,
        ...(version ? { version } : {}),
        auth,
        diagnostics,
        checkedAt: Date.now(),
        ...(requirementError ? { requirementError } : {}),
      };
      if (this.#revisions.get(id) === revision) this.#probes.set(id, result);
      return result;
    })().finally(() => {
      if (this.#probing.get(id) === work) this.#probing.delete(id);
    });
    this.#probing.set(id, work);
    return work;
  }

  #loadModels(id: AgentRuntimeId): Promise<AgentModel[]> {
    if (id === "qoder-cli") {
      if (this.#closed || !this.settings.get(id).enabled) return Promise.resolve([]);
      return this.#qoderStatus(false).then((status) =>
        !this.#closed && status.installed && status.enabled && status.auth.status === "signed-in" && this.settings.get(id).enabled
          ? this.#models.get(id)?.models ?? [] : [],
      );
    }
    const running = this.#modelLoads.get(id);
    if (running) return running;
    const revision = this.#revisions.get(id);
    const work = (async () => {
      const settings = this.settings.get(id);
      const binary = await resolveBinary(id, settings.binaryPath);
      if (!binary) return [];
      const probe = await this.#probe(id, binary, false);
      if (probe?.requirementError) throw probe.requirementError;
      if (id === "codex-cli" && probe?.auth.status !== "signed-in") return [];
      const cached = this.#models.get(id);
      if (
        cached?.signature === binary.signature &&
        Date.now() - cached.at < MODELS_TTL_MS
      )
        return cached.models;
      const failed = this.#modelErrors.get(id);
      if (
        failed?.signature === binary.signature &&
        failed.cause &&
        Date.now() - failed.at < STATUS_TTL_MS
      )
        throw failed.cause;
      const env = await this.#environment(id, binary.path);
      await mkdir(path.join(this.#root, "probes"), {
        recursive: true,
        mode: 0o700,
      });
      const folder = await privateFolder(path.join(this.#root, "probes"), id);
      try {
        const { models, account, limits } = await probeModels(
          binary.path,
          id,
          env,
          folder.path,
        );
        if (this.#revisions.get(id) !== revision) return [];
        this.#models.set(id, {
          signature: binary.signature,
          models,
          at: Date.now(),
        });
        this.#modelErrors.delete(id);
        if (!models.length)
          this.#modelErrors.set(id, {
            signature: binary.signature,
            at: Date.now(),
            diagnostic: {
              code: "models-unavailable",
              message: `${AGENT_RUNTIME_DEFINITIONS[id].name} returned an empty model catalog. Check sign-in and CLI protocol support.`,
            },
          });
        if (limits) this.#recordLimits(id, limits);
        const probe = this.#probes.get(id);
        if (account && probe && !probe.auth.account)
          probe.auth = { ...probe.auth, account };
        return models;
      } catch (cause) {
        if (this.#revisions.get(id) === revision)
          this.#modelErrors.set(id, {
            signature: binary.signature,
            at: Date.now(),
            cause: cause instanceof Error ? cause : new Error(String(cause)),
            diagnostic: {
              code:
                cause instanceof AgentRuntimeCompatibilityError
                  ? "runtime-incompatible"
                  : "models-unavailable",
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof AgentRuntimeCompatibilityError &&
              cause.capability
                ? { capability: cause.capability }
                : {}),
            },
          });
        throw cause;
      } finally {
        await folder.remove();
      }
    })().finally(() => {
      if (this.#modelLoads.get(id) === work) this.#modelLoads.delete(id);
    });
    this.#modelLoads.set(id, work);
    return work;
  }
}

/** Project agents use only Qoder's own catalog; configured BYOK endpoints are not imported. */
export function qoderModels(value: unknown): AgentModel[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { models?: unknown }).models : undefined;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows.slice(0, 500).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const model = row as Record<string, unknown>;
    const id = model.value;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_./:+-]{1,200}$/.test(id) || id === "lite" || seen.has(id) || model.isEnabled === false ||
      model.source !== undefined && model.source !== "system") return [];
    seen.add(id);
    const efforts = Array.isArray(model.efforts) ? model.efforts.filter((entry): entry is string => typeof entry === "string" && ["low", "medium", "high", "max"].includes(entry)) : [];
    const context = model.defaultContextWindow;
    return [{ provider: "qoder-cli", providerName: "Qoder", id,
      name: typeof model.displayName === "string" ? model.displayName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 150) || id : id,
      reasoningLevels: [], supportsImages: model.isVl === true,
      ...(efforts.length ? { nativeReasoningLevels: [...new Set(efforts)] } : {}),
      ...(typeof context === "number" && Number.isSafeInteger(context) && context > 0 && context <= 10_000_000 ? { contextWindow: context } : {}),
    }];
  });
}

function isUsageLimit(value: unknown): value is AgentUsageLimit {
  const limit = value as AgentUsageLimit | null;
  return (
    !!limit &&
    typeof limit.id === "string" &&
    typeof limit.usedPercent === "number" &&
    (limit.windowMinutes === undefined ||
      typeof limit.windowMinutes === "number") &&
    (limit.resetsAt === undefined || typeof limit.resetsAt === "number")
  );
}
