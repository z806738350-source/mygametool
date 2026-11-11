import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
const pendingConfiguration = new Map<string, Promise<void>>();

export function isOhMyGameManagedPiPackage(source: string): boolean {
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

export function withoutOhMyGameManagedPiPackages(
  packages: ReturnType<SettingsManager["getPackages"]>,
): ReturnType<SettingsManager["getPackages"]> {
  const retained = packages.filter((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return !isOhMyGameManagedPiPackage(source);
  });
  return retained.length === packages.length ? packages : retained;
}

export function ensureOhMyGamePiEnvironment(agentDir: string): Promise<void> {
  const directory = path.resolve(agentDir);
  const existing = pendingConfiguration.get(directory);
  if (existing) return existing;
  const configuration = configure(directory).finally(() => {
    if (pendingConfiguration.get(directory) === configuration) pendingConfiguration.delete(directory);
  });
  pendingConfiguration.set(directory, configuration);
  return configuration;
}

async function configure(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const settings = SettingsManager.create(agentDir, agentDir);
  const packages = settings.getGlobalSettings().packages ?? [];
  const migratedPackages = withoutOhMyGameManagedPiPackages(packages);
  if (migratedPackages !== packages) {
    settings.setPackages(migratedPackages);
    await settings.flush();
  }
}
