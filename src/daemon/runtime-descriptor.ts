import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isLoopbackHostHeader } from "../shared/local-security.js";

export const DAEMON_RUNTIME_FILE = "daemon-runtime.json";
export interface LocalDaemonRuntime { url: string; token: string; pid: number }

export function readLocalDaemonRuntime(file: string): LocalDaemonRuntime {
  const info = lstatSync(file);
  if (!info.isFile() || info.size > 16 * 1024 || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error("Private daemon runtime is unavailable");
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<LocalDaemonRuntime>;
  const url = new URL(value.url ?? "");
  if (url.protocol !== "http:" || !isLoopbackHostHeader(url.host) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || typeof value.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value.token) || !Number.isInteger(value.pid)) throw new Error("Invalid private daemon runtime");
  return { url: url.origin, token: value.token, pid: value.pid! };
}

/** This file is for same-user server-side clients, never for serving to a browser. */
export async function publishLocalDaemonRuntime(directory: string, runtime: LocalDaemonRuntime): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, DAEMON_RUNTIME_FILE), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return async () => {
    try {
      const current = JSON.parse(await readFile(file, "utf8")) as LocalDaemonRuntime;
      if (current.pid === runtime.pid && current.token === runtime.token) await rm(file, { force: true });
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not remove private daemon runtime"); }
  };
}
