import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  controlledQoderEnvironment,
  controlledQoderProcess,
  isControlledQoderProcess,
  resolveControlledQoder,
} from "../src/daemon/agent-runtimes/controlled-qoder.js";
import * as discovery from "../src/daemon/agent-runtimes/discovery.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import {
  setAgentProcessSpawner,
  type AgentProcessOptions,
} from "../src/daemon/agent-runtimes/process.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setAgentProcessSpawner(undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ohmygame-qoder-policy-")),
  );
  roots.push(root);
  return root;
}

async function launch(): Promise<AgentProcessOptions> {
  const root = await temporary();
  const env = await controlledQoderEnvironment(root);
  const cwd = path.join(root, "session");
  return {
    binaryPath: process.execPath,
    args: [
      path.join(
        repositoryRoot,
        "dist",
        "daemon",
        "agent-runtimes",
        "qoder-sdk-host.js",
      ),
      path.join(
        repositoryRoot,
        ".runtime",
        "qoder-sdk",
        "1.0.59",
        "node_modules",
        "@qoder-ai",
        "qoder-agent-sdk",
        "dist",
        "index.js",
      ),
    ],
    cwd,
    env: {
      ...env,
      TMPDIR: path.join(cwd, "tmp"),
      TMP: path.join(cwd, "tmp"),
      TEMP: path.join(cwd, "tmp"),
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

it("keeps Qoder login state in private directories without ambient credentials or shell settings", async () => {
  vi.stubEnv("HOME", "/ambient-home");
  vi.stubEnv("QODER_CONFIG_DIR", "/ambient-qoder");
  vi.stubEnv("QODER_PERSONAL_ACCESS_TOKEN", "QODER_AMBIENT_CANARY");
  vi.stubEnv("OPENAI_API_KEY", "UNRELATED_AMBIENT_CANARY");
  vi.stubEnv("NODE_OPTIONS", "--require=/untrusted-hook.js");
  const root = await temporary();
  const env = await controlledQoderEnvironment(root);
  expect(env).toEqual({
    HOME: path.join(root, "qoder", "home"),
    QODER_CONFIG_DIR: path.join(root, "qoder", "config"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    OTEL_SDK_DISABLED: "true",
    QODER_DISABLE_MALFORMED_TOOL_USE_RETRY: "1",
    QODER_MAX_REASONING_ONLY_RETRIES: "0",
    XDG_CONFIG_HOME: path.join(root, "qoder", "home", "config"),
    XDG_CACHE_HOME: path.join(root, "qoder", "home", "cache"),
    XDG_DATA_HOME: path.join(root, "qoder", "home", "data"),
  });
  expect(JSON.stringify(env)).not.toMatch(/AMBIENT|untrusted|ambient-/);
  expect(env).not.toHaveProperty("TMPDIR");
  expect(
    JSON.parse(
      await readFile(path.join(env.QODER_CONFIG_DIR!, "settings.json"), "utf8"),
    ),
  ).toEqual({
    general: {
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      maxAttempts: 1,
      retryFetchErrors: false,
    },
    privacy: { usageStatisticsEnabled: false },
    aiCodeStatistics: { enabled: false, installGitCommitHook: false },
    autoMemoryEnabled: false,
    autoMemoryUserScopeEnabled: false,
    dream: { enabled: false },
    hooks: {},
    mcpServers: {},
    enabledPlugins: {},
  });
  if (process.platform !== "win32")
    expect(
      (await lstat(path.join(env.QODER_CONFIG_DIR!, "settings.json"))).mode &
        0o777,
    ).toBe(0o600);
  for (const directory of [
    path.join(root, "qoder"),
    env.HOME!,
    env.QODER_CONFIG_DIR!,
    env.XDG_CONFIG_HOME!,
    env.XDG_CACHE_HOME!,
    env.XDG_DATA_HOME!,
  ]) {
    const entry = await lstat(directory);
    expect(entry.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(entry.mode & 0o777).toBe(0o700);
    if (process.getuid) expect(entry.uid).toBe(process.getuid());
  }
});

it("rejects linked configuration roots without creating login state in their target", async () => {
  const root = await temporary();
  const outside = await temporary();
  const original = path.join(outside, "original.txt");
  await writeFile(original, "retained");
  await symlink(outside, path.join(root, "qoder"), "dir");
  await expect(controlledQoderEnvironment(root)).rejects.toThrow(
    "ordinary directories",
  );
  expect(await readFile(original, "utf8")).toBe("retained");
  await expect(access(path.join(outside, "home"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["hooks", "mcpServers", "enabledPlugins", "auto-update", "unknown"])(
  "retains and refuses unreviewed %s startup settings instead of inheriting or overwriting them",
  async (kind) => {
    const root = await temporary();
    const env = await controlledQoderEnvironment(root);
    const file = path.join(env.QODER_CONFIG_DIR!, "settings.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (kind === "hooks")
      value.hooks = { SessionStart: [{ command: "unreviewed-command" }] };
    if (kind === "mcpServers")
      value.mcpServers = { other: { command: "unreviewed-mcp" } };
    if (kind === "enabledPlugins") value.enabledPlugins = { other: true };
    if (kind === "auto-update") value.general.enableAutoUpdate = true;
    if (kind === "unknown")
      value.permissions = { defaultMode: "bypassPermissions" };
    const original = JSON.stringify(value);
    await writeFile(file, original);
    await expect(controlledQoderEnvironment(root)).rejects.toThrow(
      "unreviewed configuration",
    );
    expect(await readFile(file, "utf8")).toBe(original);
  },
);

it("rejects linked startup settings without reading or replacing the linked original", async () => {
  const root = await temporary();
  const env = await controlledQoderEnvironment(root);
  const file = path.join(env.QODER_CONFIG_DIR!, "settings.json");
  const original = path.join(root, "original-settings.json");
  await writeFile(original, "retain this private original", { mode: 0o600 });
  await rm(file);
  await symlink(original, file);
  await expect(controlledQoderEnvironment(root)).rejects.toThrow(
    "cannot be read safely",
  );
  expect(await readFile(original, "utf8")).toBe("retain this private original");
});

it.skipIf(process.platform === "win32")(
  "refuses a shared configuration directory instead of changing its permissions",
  async () => {
    const root = await temporary();
    const config = path.join(root, "qoder");
    await mkdir(config, { mode: 0o700 });
    await chmod(config, 0o755);
    await expect(controlledQoderEnvironment(root)).rejects.toThrow("private");
    expect((await lstat(config)).mode & 0o777).toBe(0o755);
  },
);

it("brands only a fixed helper launch and copies caller-owned arguments and environment", async () => {
  const options = await launch();
  const controlled = controlledQoderProcess(options);
  expect(isControlledQoderProcess(options)).toBe(false);
  expect(isControlledQoderProcess(controlled)).toBe(true);
  options.args[0] = "/arbitrary.js";
  options.env.QODER_PERSONAL_ACCESS_TOKEN = "CALLER_CANARY";
  expect(controlled.args[0]).not.toBe(options.args[0]);
  expect(controlled.env).not.toHaveProperty("QODER_PERSONAL_ACCESS_TOKEN");
  controlled.args.push("--eval=untrusted()");
  expect(isControlledQoderProcess(controlled)).toBe(false);
});

it.each([
  "binary",
  "helper",
  "sdk",
  "extra-argument",
  "source-loader",
  "credential",
  "node-options",
  "path",
  "temporary",
])("refuses the %s helper bypass before process execution", async (kind) => {
  const options = await launch();
  if (kind === "binary") options.binaryPath = "/bin/sh";
  if (kind === "helper")
    options.args[0] = path.join(
      repositoryRoot,
      "src",
      "daemon",
      "agent-runtimes",
      "qoder-sdk-host.js",
    );
  if (kind === "sdk") options.args[1] = "/other-sdk/index.js";
  if (kind === "extra-argument") options.args.push("--eval=untrusted()");
  if (kind === "source-loader") options.args.unshift("--import", "tsx");
  if (kind === "credential")
    options.env.QODER_PERSONAL_ACCESS_TOKEN = "FORBIDDEN_CANARY";
  if (kind === "node-options")
    options.env.NODE_OPTIONS = "--require=/untrusted.js";
  if (kind === "path") options.env.PATH += ":/untrusted";
  if (kind === "temporary") options.env.TMP = "/tmp";
  expect(() => controlledQoderProcess(options)).toThrow(
    "Only the fixed Qoder SDK helper",
  );
  expect(isControlledQoderProcess(options)).toBe(false);
});

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "rejects unaudited Qoder bytes without probing, importing or starting them",
  async () => {
    const root = await temporary();
    const binary = path.join(root, "qoder");
    const marker = path.join(root, "executed");
    await writeFile(binary, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const shell = vi
      .spyOn(environment, "loginShellPath")
      .mockRejectedValue(new Error("No shell may run"));
    const version = vi
      .spyOn(discovery, "probeVersion")
      .mockRejectedValue(new Error("No version process may run"));
    const auth = vi
      .spyOn(discovery, "probeAuth")
      .mockRejectedValue(new Error("No authentication process may run"));
    const spawn = vi.fn();
    setAgentProcessSpawner(spawn as never);
    await expect(resolveControlledQoder(binary)).rejects.toThrow(
      "has not passed",
    );
    expect(shell).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it
  .skipIf(process.platform !== "darwin" || process.arch !== "arm64")
  .each(["symbolic", "hard"])(
  "refuses a %s-linked Qoder executable before any process can start",
  async (kind) => {
    const root = await temporary();
    const original = path.join(root, "original");
    const binary = path.join(root, "qoder");
    await writeFile(original, "unaudited executable bytes", { mode: 0o700 });
    if (kind === "symbolic") await symlink(original, binary);
    else await link(original, binary);
    await expect(resolveControlledQoder(binary)).rejects.toThrow(
      kind === "symbolic" ? "symbolic links" : "ordinary installation files",
    );
  },
);
