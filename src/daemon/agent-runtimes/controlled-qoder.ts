import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AgentRuntimeCompatibilityError } from "./compatibility.js";
import { compareVersions, parseVersion, versionAtLeast } from "./definitions.js";
import { runCli, type ResolvedBinary } from "./discovery.js";
import { verifyNativeDeveloperId } from "./native-signature.js";
import type { AgentProcessOptions } from "./process.js";

export const CONTROLLED_QODER_VERSION = "1.1.83";
export const QODER_SDK_VERSION = "1.0.59";
const QODER_SDK_SHA256 =
  "d7b28e41087eafe2913affdfbf37cf72825ff4d1c458debf3fc1490481bf895f";
// The native runtime handles authentication and runs outside the project tool bridge.
const QODER_BINARY_SHA256 =
  "2966736faf6e37316b93a2456ddd4bcc73d2441ec6f861e1832f3caca93751e5";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const sdkRoot = path.join(
  repositoryRoot,
  ".runtime",
  "qoder-sdk",
  QODER_SDK_VERSION,
  "node_modules",
  "@qoder-ai",
  "qoder-agent-sdk",
);
const sdkEntry = path.join(sdkRoot, "dist", "index.js");
const nativeRoot = path.join(repositoryRoot, ".runtime", "qoder-cli");
const helperEntry = path.join(
  repositoryRoot,
  "dist",
  "daemon",
  "agent-runtimes",
  "qoder-sdk-host.js",
);
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const CONTROLLED_SETTINGS = {
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
};

function incompatible(message: string): AgentRuntimeCompatibilityError {
  return new AgentRuntimeCompatibilityError(
    message,
    "controlled Qoder tool isolation",
  );
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (process.platform !== "win32" && (entry.mode & 0o077) !== 0) ||
    (typeof process.getuid === "function" && entry.uid !== process.getuid())
  )
    throw incompatible(
      "Qoder configuration directories must be private, owned ordinary directories",
    );
}

async function privateSettings(config: string): Promise<void> {
  const file = path.join(config, "settings.json");
  try {
    const created = await open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await created.writeFile(
        `${JSON.stringify(CONTROLLED_SETTINGS, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await created.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST")
      throw incompatible(
        "The private Qoder startup settings could not be prepared",
      );
  }
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw incompatible(
      "The private Qoder startup settings cannot be read safely",
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > 64n * 1024n ||
      (process.platform !== "win32" && (before.mode & 0o077n) !== 0n) ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    )
      throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      );
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (
      BigInt(bytes) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      !isDeepStrictEqual(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, bytes),
          ),
        ),
        CONTROLLED_SETTINGS,
      )
    )
      throw new Error();
  } catch {
    throw incompatible(
      "The private Qoder startup settings changed or contain unreviewed configuration; retain them for review",
    );
  } finally {
    await handle.close();
  }
}

/** Never import the person's existing Qoder login, shell configuration or ambient credentials. */
export async function controlledQoderEnvironment(
  root: string,
): Promise<Record<string, string>> {
  if (!path.isAbsolute(root))
    throw incompatible("Qoder requires a private absolute configuration root");
  await privateDirectory(root);
  const configurationRoot = path.join(await realpath(root), "qoder");
  await privateDirectory(configurationRoot);
  const home = path.join(configurationRoot, "home");
  const config = path.join(configurationRoot, "config");
  for (const directory of [home, config]) await privateDirectory(directory);
  await privateSettings(config);
  const env = {
    HOME: home,
    QODER_CONFIG_DIR: config,
    PATH: MINIMAL_PATH,
    LANG: "en_US.UTF-8",
    OTEL_SDK_DISABLED: "true",
    QODER_DISABLE_MALFORMED_TOOL_USE_RETRY: "1",
    QODER_MAX_REASONING_ONLY_RETRIES: "0",
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
  };
  for (const directory of [
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
  ])
    await privateDirectory(directory);
  return env;
}

async function ordinaryFile(
  file: string,
  limit: number,
): Promise<{ bytes: number; sha256: string }> {
  // Installation paths must not redirect the audited files through a link.
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw incompatible(
        "Qoder installation paths cannot contain symbolic links",
      );
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid()))
    )
      throw incompatible(
        "Qoder requires bounded, owned ordinary installation files",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      const chunk = await handle.read(buffer, 0, buffer.length, bytes);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
      if (bytes > limit)
        throw incompatible("Qoder installation exceeds its audit size limit");
      hash.update(buffer.subarray(0, chunk.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const target = await lstat(file, { bigint: true });
    if (
      BigInt(bytes) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      !target.isFile() ||
      target.dev !== before.dev ||
      target.ino !== before.ino
    )
      throw incompatible("Qoder installation changed during its audit");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function installationJson(
  file: string,
): Promise<Record<string, unknown>> {
  await ordinaryFile(file, 64 * 1024);
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > 64 * 1024)
      throw incompatible("Qoder installation metadata is invalid");
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw incompatible("Qoder installation metadata is invalid");
    return value as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

export interface ControlledQoderBinary extends ResolvedBinary {
  sdkEntry: string;
  version: string;
}

async function managedQoderBinaries(): Promise<string[]> {
  const directories = await readdir(nativeRoot, { withFileTypes: true }).catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  return directories
    .filter(entry => entry.isDirectory() && parseVersion(entry.name) === entry.name && versionAtLeast(entry.name, CONTROLLED_QODER_VERSION))
    .sort((left, right) => compareVersions(right.name, left.name))
    .map(release => path.join(nativeRoot, release.name, "qoder"));
}

let checkedNative: { binary: string; sha256: string; version: string } | undefined;

async function qoderNativeVersion(binary: string, sha256: string): Promise<string> {
  if (sha256 === QODER_BINARY_SHA256) return CONTROLLED_QODER_VERSION;
  if (checkedNative?.binary === binary && checkedNative.sha256 === sha256) return checkedNative.version;
  try {
    await verifyNativeDeveloperId(binary, "qodercli", "T27K5A5ZWD");
  } catch {
    throw incompatible("The Qoder CLI publisher signature could not be verified; no CLI was started");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-qoder-version-"));
  try {
    const env = await controlledQoderEnvironment(directory);
    const { code, stdout } = await runCli("/usr/bin/sandbox-exec", [
      "-p", "(version 1) (allow default) (deny network*)", binary, "--version",
    ], { ...env, TMPDIR: directory }, directory);
    const version = code === 0 ? parseVersion(stdout) : undefined;
    if (!version || !versionAtLeast(version, CONTROLLED_QODER_VERSION))
      throw incompatible("The signed Qoder CLI did not report a supported version in its isolated check");
    if ((await ordinaryFile(binary, 256 * 1024 * 1024)).sha256 !== sha256)
      throw incompatible("The signed Qoder CLI changed during its version check");
    checkedNative = { binary, sha256, version };
    return version;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Checks the fixed SDK and verifies the native executable before any version probe. */
export async function resolveControlledQoder(
  override?: string,
): Promise<ControlledQoderBinary | undefined> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw incompatible(
      "The controlled Qoder connection currently requires macOS arm64",
    );
  if (override) return resolveQoderCandidate(override, "manual");
  let diagnostic: unknown;
  for (const candidate of await managedQoderBinaries()) {
    try {
      const resolved = await resolveQoderCandidate(candidate, "common-directory");
      if (resolved) return resolved;
    } catch (cause) {
      diagnostic ??= cause;
    }
  }
  if (diagnostic) throw diagnostic;
  return undefined;
}

async function resolveQoderCandidate(binary: string, source: ControlledQoderBinary["source"]): Promise<ControlledQoderBinary | undefined> {
  if (!path.isAbsolute(binary))
    throw incompatible("Qoder requires an absolute native executable path");
  try {
    await lstat(binary);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const executable = await ordinaryFile(binary, 256 * 1024 * 1024);
    if (((await lstat(binary)).mode & 0o111) === 0)
      throw incompatible("Choose an executable native Qoder CLI");
    const manifest = await installationJson(path.join(sdkRoot, "package.json"));
    if (
      manifest.name !== "@qoder-ai/qoder-agent-sdk" ||
      manifest.version !== QODER_SDK_VERSION ||
      manifest.qoderCliVersion !== CONTROLLED_QODER_VERSION
    )
      throw incompatible(
        "The controlled Qoder SDK package version is unavailable",
      );
    const runtime = await installationJson(
      path.join(sdkRoot, "dist", "runtime-manifest.json"),
    );
    if (
      runtime.sdkVersion !== QODER_SDK_VERSION ||
      runtime.qoderCliVersion !== CONTROLLED_QODER_VERSION
    )
      throw incompatible(
        "The controlled Qoder SDK runtime version is unavailable",
      );
    const entry = await ordinaryFile(sdkEntry, 32 * 1024 * 1024);
    if (entry.sha256 !== QODER_SDK_SHA256)
      throw incompatible(
        "The Qoder SDK entry has not passed OhMyGame's controlled-tool audit",
      );
    const version = await qoderNativeVersion(binary, executable.sha256);
    if (source === "common-directory" && path.basename(path.dirname(binary)) !== version)
      throw incompatible("The managed Qoder directory does not match the verified CLI version");
    return {
      path: binary,
      source,
      signature: `${binary}:${executable.sha256}:${entry.sha256}`,
      sdkEntry,
      version,
    };
  } catch (cause) {
    if (cause instanceof AgentRuntimeCompatibilityError) throw cause;
    throw incompatible(
      "The fixed Qoder SDK/native installation is missing or unavailable; no CLI was started",
    );
  }
}

const launches = new WeakSet<AgentProcessOptions>();
const environmentNames = new Set([
  "HOME",
  "QODER_CONFIG_DIR",
  "PATH",
  "LANG",
  "OTEL_SDK_DISABLED",
  "QODER_DISABLE_MALFORMED_TOOL_USE_RETRY",
  "QODER_MAX_REASONING_ONLY_RETRIES",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "ELECTRON_RUN_AS_NODE",
]);

function assertControlledQoderProcess(options: AgentProcessOptions): void {
  const env = options.env;
  const home = env.HOME;
  const configRoot = home && path.dirname(home);
  if (
    options.binaryPath !== process.execPath ||
    options.args.length !== 2 ||
    options.args[0] !== helperEntry ||
    options.args[1] !== sdkEntry ||
    !path.isAbsolute(options.cwd) ||
    !home ||
    !path.isAbsolute(home) ||
    path.basename(home) !== "home" ||
    env.QODER_CONFIG_DIR !== path.join(configRoot!, "config") ||
    env.PATH !== MINIMAL_PATH ||
    env.LANG !== "en_US.UTF-8" ||
    env.OTEL_SDK_DISABLED !== "true" ||
    env.QODER_DISABLE_MALFORMED_TOOL_USE_RETRY !== "1" ||
    env.QODER_MAX_REASONING_ONLY_RETRIES !== "0" ||
    env.XDG_CONFIG_HOME !== path.join(home, "config") ||
    env.XDG_CACHE_HOME !== path.join(home, "cache") ||
    env.XDG_DATA_HOME !== path.join(home, "data") ||
    env.ELECTRON_RUN_AS_NODE !== "1" ||
    !env.TMPDIR ||
    path.relative(options.cwd, env.TMPDIR) !== "tmp" ||
    (env.TMP !== undefined && env.TMP !== env.TMPDIR) ||
    (env.TEMP !== undefined && env.TEMP !== env.TMPDIR) ||
    Object.keys(env).some((name) => !environmentNames.has(name))
  )
    throw incompatible(
      "Only the fixed Qoder SDK helper with its private environment may start",
    );
}

/** A fixed Node helper is the only Qoder exception to the disabled arbitrary-process boundary. */
export function controlledQoderProcess(
  options: AgentProcessOptions,
): AgentProcessOptions {
  assertControlledQoderProcess(options);
  const env = options.env;
  const launch = { ...options, args: [...options.args], env: { ...env } };
  launches.add(launch);
  return launch;
}

export function isControlledQoderProcess(
  options: AgentProcessOptions,
): boolean {
  if (!launches.has(options)) return false;
  try {
    assertControlledQoderProcess(options);
    return true;
  } catch {
    return false;
  }
}
