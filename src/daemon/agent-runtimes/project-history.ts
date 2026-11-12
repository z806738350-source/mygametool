import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { ProjectState } from "../../shared/contracts.js";
import { sessionDirectory } from "../conversations.js";

export const NATIVE_PRIVATE_SESSION_ENTRY = "ohmygame-native-private-session";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Runtime = "codex-cli" | "qoder-cli";

// Qoder 1.1.83's transcript-paths sanitizePath format, including long private paths.
function qoderProjectName(directory: string): string {
  const encoded = directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 5381;
  for (let i = 0; i < directory.length; i++)
    hash = (hash * 33) ^ directory.charCodeAt(i);
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function privateRuntime(root: string, directory: unknown): Runtime | undefined {
  if (
    typeof directory !== "string" ||
    path.dirname(directory) !== path.join(root, "sessions")
  )
    return;
  const name = path.basename(directory);
  for (const runtime of ["codex-cli", "qoder-cli"] as const)
    if (
      name.startsWith(`${runtime}-`) &&
      UUID.test(name.slice(runtime.length + 1))
    )
      return runtime;
}

/** Do not follow links in a CLI history path, including an ancestor of the target. */
async function ordinary(root: string, file: string): Promise<boolean> {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Native history path escaped its private root");
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (!info) return false;
    if (
      info.isSymbolicLink() ||
      (info.isFile() && info.nlink !== 1) ||
      (!info.isDirectory() && current !== file)
    )
      throw new Error(
        "Native history contains a linked or invalid path; no unrelated data was removed",
      );
  }
  return true;
}

async function directories(root: string, directory: string): Promise<string[]> {
  if (!(await ordinary(root, directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new Error("Native history contains a linked directory");
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

async function firstRecord(file: string): Promise<Record<string, unknown>> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0)
      throw new Error("Native history metadata is incomplete or too large");
    return JSON.parse(buffer.subarray(0, end).toString());
  } finally {
    await handle.close();
  }
}

/** Run after the project's sessions have stopped, before removing its canonical history. */
export async function removeProjectNativeHistory(
  root: string,
  project: ProjectState,
  deleteCodexThreads: (
    ids: readonly string[],
    directories: ReadonlySet<string>,
  ) => Promise<void>,
): Promise<void> {
  root = path.resolve(root);
  const owned = new Map<string, Runtime>();
  const ids: Record<Runtime, Set<string>> = {
    "codex-cli": new Set(),
    "qoder-cli": new Set(),
  };
  const sessionRoot = sessionDirectory(project);
  if (await ordinary(path.dirname(sessionRoot), sessionRoot)) {
    for (const entry of await readdir(sessionRoot, { withFileTypes: true })) {
      if (!entry.name.endsWith(".jsonl")) continue;
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Project conversation history is not an ordinary file");
      const stream = createReadStream(path.join(sessionRoot, entry.name));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (record.type !== "custom") continue;
          const data = record.data;
          if (record.customType === NATIVE_PRIVATE_SESSION_ENTRY) {
            const runtime = privateRuntime(root, data?.privateDirectory);
            if (
              !runtime ||
              runtime !== data.runtime ||
              data.version !== 1 ||
              data.projectId !== project.id
            )
              throw new Error(
                "Native history ownership does not match the project",
              );
            owned.set(data.privateDirectory, runtime);
          } else if (
            record.customType === "ohmygame-native-session" &&
            (data?.runtime === "codex-cli" || data?.runtime === "qoder-cli") &&
            UUID.test(String(data.sessionId))
          ) {
            ids[data.runtime as Runtime].add(data.sessionId);
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
  }

  const qoderProjects = path.join(root, "qoder", "config", "projects");
  const qoderLogs = path.join(root, "qoder", "config", "logs", "sessions");
  const qoderRuns = new Map<string, string>();
  for (const directory of await directories(
    root,
    path.join(root, "qoder", "config", "logs", "runs"),
  )) {
    const file = path.join(directory, "manifest.json");
    if (!(await ordinary(root, file))) continue;
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (privateRuntime(root, manifest.cwd) === "qoder-cli")
      qoderRuns.set(directory, manifest.cwd);
  }
  const encodedRoot = path.join(root, "sessions").replace(/[^a-zA-Z0-9]/g, "-");
  for (const directory of await directories(root, qoderProjects)) {
    const name = path.basename(directory),
      prefix = `${encodedRoot}-qoder-cli-`;
    // Older releases recorded the native ID but not their disposable cwd.
    if (
      (await readdir(directory)).some(
        (file) =>
          file.endsWith(".jsonl") && ids["qoder-cli"].has(file.slice(0, -6)),
      )
    ) {
      const cwd =
        [...owned.keys(), ...qoderRuns.values()].find(
          (cwd) => qoderProjectName(cwd) === name,
        ) ??
        (name.startsWith(prefix) && UUID.test(name.slice(prefix.length))
          ? path.join(
              root,
              "sessions",
              `qoder-cli-${name.slice(prefix.length)}`,
            )
          : undefined);
      if (!cwd)
        throw new Error("Qoder history ownership format could not be verified");
      owned.set(cwd, "qoder-cli");
    }
  }

  const codexFiles: string[] = [];
  const pending = [
    path.join(root, "codex-home", "sessions"),
    path.join(root, "codex-home", "archived_sessions"),
  ];
  while (pending.length) {
    const directory = pending.pop()!;
    if (!(await ordinary(root, directory))) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Codex history contains a linked path");
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const record = await firstRecord(file),
        meta = record.payload as Record<string, unknown> | undefined;
      if (
        record.type !== "session_meta" ||
        !meta ||
        typeof meta.id !== "string" ||
        !UUID.test(meta.id)
      )
        throw new Error("Codex history metadata could not be verified");
      const runtime = privateRuntime(root, meta.cwd);
      if (runtime !== "codex-cli") continue;
      if (
        owned.get(String(meta.cwd)) === runtime ||
        ids[runtime].has(meta.id)
      ) {
        owned.set(String(meta.cwd), runtime);
        ids[runtime].add(meta.id);
        codexFiles.push(file);
      }
    }
  }

  // The native API owns conversation state; never edit its tables directly.
  if (ids["codex-cli"].size)
    await deleteCodexThreads(
      [...ids["codex-cli"]],
      new Set(
        [...owned]
          .filter(([, runtime]) => runtime === "codex-cli")
          .map(([cwd]) => cwd),
      ),
    );
  // Codex's thread/delete removes thread state, but retains per-thread diagnostic content.
  const logs = path.join(root, "codex-home", "logs_2.sqlite");
  if (ids["codex-cli"].size && (await ordinary(root, logs))) {
    const database = new DatabaseSync(logs);
    try {
      database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      const processes = new Map<string, Set<string>>();
      for (const row of database
        .prepare(
          "SELECT DISTINCT process_uuid, thread_id FROM logs WHERE thread_id IS NOT NULL AND process_uuid IS NOT NULL",
        )
        .all()) {
        const process = String(row.process_uuid),
          threads = processes.get(process) ?? new Set<string>();
        threads.add(String(row.thread_id));
        processes.set(process, threads);
      }
      // Some tool-response logs omit thread_id. Remove those only for an exclusively owned CLI instance.
      const removeProcess = database.prepare(
        "DELETE FROM logs WHERE process_uuid = ?",
      );
      for (const [process, threads] of processes)
        if ([...threads].every((id) => ids["codex-cli"].has(id)))
          removeProcess.run(process);
      const remove = database.prepare("DELETE FROM logs WHERE thread_id = ?");
      for (const id of ids["codex-cli"]) remove.run(id);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
  }
  for (const file of codexFiles) if (await ordinary(root, file)) await rm(file);
  for (const [directory, cwd] of qoderRuns)
    if (owned.get(cwd) === "qoder-cli" && (await ordinary(root, directory)))
      await rm(directory, { recursive: true });
  for (const [cwd, runtime] of owned) {
    if (runtime === "qoder-cli") {
      const encoded = qoderProjectName(cwd);
      for (const base of [qoderProjects, qoderLogs]) {
        const target = path.join(base, encoded);
        if (await ordinary(root, target)) await rm(target, { recursive: true });
      }
    }
    if (await ordinary(root, cwd)) await rm(cwd, { recursive: true });
  }
}
