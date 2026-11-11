import path from "node:path";

export interface LocalDesktopLaunch {
  envFile?: string;
  reuseLocalEnv: boolean;
  profileDirectory: string;
  launchId: string;
}

/** Source-launcher arguments carry paths and an ownership ID, never a credential. */
export function localDesktopLaunch(argv: readonly string[]): LocalDesktopLaunch | undefined {
  const reuseFlags = argv.filter((value) => value === "--reuse-local-env" || value.startsWith("--reuse-local-env="));
  if (reuseFlags.length > 1 || reuseFlags.some((value) => value !== "--reuse-local-env")) throw new Error("Invalid local credential snapshot option");
  const reuseLocalEnv = reuseFlags.length === 1;
  const names = ["--local-env", "--local-profile", "--local-launch-id"] as const;
  const values = names.map((name) => {
    const indices = argv.flatMap((value, index) => value === name || value.startsWith(`${name}=`) ? [index] : []);
    if (indices.length > 1) throw new Error("Duplicate local launcher option");
    if (!indices.length) return undefined;
    const index = indices[0]!;
    const value = argv[index]!.startsWith(`${name}=`) ? argv[index]!.slice(name.length + 1) : argv[index + 1];
    if (!value || value.startsWith("--") || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid local launcher option");
    return value;
  });
  if (values.every((value) => value === undefined) && !reuseLocalEnv) return undefined;
  const [envFile, profileDirectory, launchId] = values;
  if ((!envFile && !reuseLocalEnv) || (envFile && reuseLocalEnv) || !profileDirectory || !launchId || (envFile && !path.isAbsolute(envFile)) || !path.isAbsolute(profileDirectory)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(launchId)) {
    throw new Error("Incomplete local launcher options");
  }
  return { ...(envFile ? { envFile: path.resolve(envFile) } : {}), reuseLocalEnv, profileDirectory: path.resolve(profileDirectory), launchId };
}
