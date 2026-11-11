import path from "node:path";
import { fileURLToPath } from "node:url";
import { takeAccessToken } from "./access-token.js";
import { IsolatedProjectExecution } from "./isolated-project-execution.js";
import { createApp } from "./app.js";
import { ensureOhMyGamePiEnvironment } from "./pi-agent.js";
import { activateNetworkProxy } from "./proxy.js";
import { loadDaemonLocalEnv, localEnvFileArgument, reuseLocalEnvArgument } from "./local-env.js";
import { NetworkSettingsService } from "./network-settings.js";
import { requestSystemProxy } from "./system-proxy-resolver.js";
import { ProcessPlaytestDriver } from "./playtest-driver.js";
import { isLoopbackHostname } from "../shared/local-debug.js";
import { publishLocalDaemonRuntime } from "./runtime-descriptor.js";
import { isAllowedLocalOrigin } from "../shared/local-security.js";
import { bindDesktopDaemonOwner } from "./desktop-owner.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const localEnvFile = localEnvFileArgument(process.argv.slice(2));
// Credentials are daemon-owned file data, never a subprocess environment variable.
delete process.env.KUNPO_API_KEY;
// Processes the daemon starts inherit its environment, and none of them may call the daemon as the app.
const desktopOwned = process.env.OHMYGAME_DAEMON_TOKEN_STDIN === "1";
if (desktopOwned && !process.connected) throw new Error("The desktop-owned daemon requires its private parent IPC connection");
const reuseLocalEnv = reuseLocalEnvArgument(process.argv.slice(2), Boolean(desktopOwned));
const accessToken = await takeAccessToken(process.env, process.stdin);
delete process.env.OHMYGAME_EXTERNAL_MCP_LAUNCHER;
delete process.env.OHMYGAME_EXTERNAL_SKILL_DIR;
if (process.env.DAEMON_HOST && !isLoopbackHostname(process.env.DAEMON_HOST)) throw new Error("The daemon must listen on loopback");
const host = "127.0.0.1";
const dataDirectory = path.resolve(process.env.OHMYGAME_DATA_DIR ?? path.join(repositoryRoot, ".data"));
const piAgentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
const localApiKeyFile = localEnvFile || reuseLocalEnv ? path.join(dataDirectory, "local-env-api-keys.json") : undefined;
process.env.PI_CODING_AGENT_DIR = piAgentDirectory;
let app: ReturnType<typeof createApp> | undefined;
let shuttingDown = false;
let removeRuntimeDescriptor: (() => Promise<void>) | undefined;
const playtestDriver = process.env.OHMYGAME_PLAYTEST_IPC === "1" && process.connected
  ? new ProcessPlaytestDriver()
  : undefined;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await removeRuntimeDescriptor?.();
    await app?.close();
    process.exit(0);
  } catch (error) {
    console.error("Could not close the daemon cleanly", error);
    process.exit(1);
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (desktopOwned) bindDesktopDaemonOwner(process, shutdown);
process.on("message", (value: unknown) => {
  if ((value as { channel?: string } | null)?.channel === "ohmygame:shutdown")
    void shutdown();
});

try {
  if (localEnvFile && localApiKeyFile) await loadDaemonLocalEnv(localEnvFile, localApiKeyFile);
  const networkSettings = new NetworkSettingsService(dataDirectory, {
    environment: process.env,
    initialSystemProxy: process.env.OHMYGAME_SYSTEM_PROXY,
    resolveSystemProxy: desktopOwned ? requestSystemProxy : undefined,
  });
  await networkSettings.load();
  activateNetworkProxy(networkSettings.runtime());
  try {
    await ensureOhMyGamePiEnvironment(piAgentDirectory);
  } catch (error) {
    console.warn("Could not initialize the OhMyGame Pi environment; continuing without managed MCP configuration.", error);
  }
  app = createApp({
    projectExecution: await IsolatedProjectExecution.load(dataDirectory),
    dataDirectory,
    networkSettings,
    piAgentDirectory,
    localApiKeyFile,
    bundledPluginsDirectory: process.env.OHMYGAME_BUNDLED_PLUGINS_DIR,
    preinstalledPluginsDirectory: undefined,
    examplesDirectory: undefined,
    interactiveStoryPlayerDirectory: process.env.OHMYGAME_PLAYER_DIR,
    accessToken,
    allowedOrigins: (desktopOwned ? process.env.OHMYGAME_ALLOWED_ORIGINS ?? "" : "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => !!origin && isAllowedLocalOrigin(origin, "127.0.0.1", new Set([origin]))),
    logger: true,
    logDirectory: process.env.OHMYGAME_LOG_DIR,
    localDebug: false,
    playtestDriver,
  });
  await app.listen({ host, port: Number(process.env.DAEMON_PORT ?? 43110) });
  if (!desktopOwned) {
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Invalid daemon listener");
    removeRuntimeDescriptor = await publishLocalDaemonRuntime(dataDirectory, { url: `http://127.0.0.1:${address.port}`, token: accessToken, pid: process.pid });
  }
} catch (error) {
  if (app) app.log.error(error); else console.error(error);
  await app?.close();
  await removeRuntimeDescriptor?.();
  process.exit(1);
}
