import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { LocalApiKeyStore } from "./local-model-runtime.js";
import { KUNPO_PROVIDER_ID } from "../shared/kunpo-models.js";

const MAX_LOCAL_ENV_BYTES = 32 * 1024;
const LOCAL_ENV_ERROR = "The local credential file is unavailable, invalid or not private. Use a regular file owned by this user with mode 0600 and only KUNPO_API_KEY=<literal value or empty>.";

/** Only the daemon consumes this path. The desktop and renderer must never read the file. */
export function localEnvFileArgument(args: readonly string[]): string | undefined {
  let selected: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument !== "--local-env" && !argument.startsWith("--local-env=")) continue;
    const value = argument === "--local-env" ? args[++index] : argument.slice("--local-env=".length);
    if (selected !== undefined || !value || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) throw new Error("Pass --local-env once with an absolute file path");
    selected = path.resolve(value);
  }
  return selected;
}

/** Recovery reuses the desktop lifetime's snapshot; it never rereads the editable source file. */
export function reuseLocalEnvArgument(args: readonly string[], desktopOwned: boolean): boolean {
  const matches = args.filter((argument) => argument === "--reuse-local-env" || argument.startsWith("--reuse-local-env="));
  if (!matches.length) return false;
  if (!desktopOwned || matches.length !== 1 || matches[0] !== "--reuse-local-env" || localEnvFileArgument(args)) {
    throw new Error("A desktop-owned recovery may pass --reuse-local-env once without --local-env");
  }
  return true;
}

function privateFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && info.size <= MAX_LOCAL_ENV_BYTES && (process.platform === "win32" ||
    (info.mode & 0o777) === 0o600 && info.uid === process.getuid?.());
}

function parseLocalEnv(text: string): string | undefined {
  let key: string | undefined;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || /^[\t ]*#/.test(line)) continue;
    if (!line.startsWith("KUNPO_API_KEY=") || seen) throw new Error(LOCAL_ENV_ERROR);
    seen = true;
    const value = line.slice("KUNPO_API_KEY=".length);
    // No quoting, interpolation, shell syntax or invisible whitespace is interpreted.
    if (value && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,16383}$/.test(value)) throw new Error(LOCAL_ENV_ERROR);
    key = value || undefined;
  }
  if (!seen) throw new Error(LOCAL_ENV_ERROR);
  return key;
}

/** Replaces only the dedicated launch store. An empty template never reads old account credentials. */
export async function loadDaemonLocalEnv(file: string, credentialFile: string): Promise<{ configured: boolean }> {
  if (!path.isAbsolute(file) || !path.isAbsolute(credentialFile) || path.resolve(file) === path.resolve(credentialFile)) throw new Error(LOCAL_ENV_ERROR);
  const buffer = Buffer.alloc(MAX_LOCAL_ENV_BYTES + 1);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    if (!privateFile(before)) throw new Error();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    let size = 0;
    while (size <= MAX_LOCAL_ENV_BYTES) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > MAX_LOCAL_ENV_BYTES) throw new Error();
    const after = await lstat(file);
    if (!privateFile(after) || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    const contents = buffer.subarray(0, size), text = contents.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(contents)) throw new Error();
    const key = parseLocalEnv(text);
    const store = new LocalApiKeyStore(credentialFile);
    await store.replace(key ? { [KUNPO_PROVIDER_ID]: { type: "api_key", key } } : {});
    return { configured: Boolean(key) };
  } catch { throw new Error(LOCAL_ENV_ERROR); }
  finally {
    buffer.fill(0);
    try { await handle?.close(); } catch { throw new Error(LOCAL_ENV_ERROR); }
  }
}
