import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createLogRedactor } from "../shared/log-redaction.js";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";
import { readSafeProjectFile } from "./safe-project-file.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";
import {
  startBlenderLiveView,
  type BlenderLiveView,
  type BlenderLiveViewResult,
} from "./blender-live-view.js";

const EXECUTABLE = "/Applications/Blender.app/Contents/MacOS/Blender";
const SANDBOX = "/usr/bin/sandbox-exec";
const MiB = 1024 * 1024;
const INPUT_LIMIT = 128 * MiB,
  OUTPUT_LIMIT = 128 * MiB,
  FILE_LIMIT = 64 * MiB;
const SCRIPT_LIMIT = 512 * 1024,
  LOG_LIMIT = 48 * 1024;
const OUTPUT_EXTENSIONS = new Set([
  ".blend",
  ".glb",
  ".fbx",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
]);
const INPUT_EXTENSIONS = new Set([
  ...OUTPUT_EXTENSIONS,
  ".webp",
  ".gltf",
  ".bin",
  ".txt",
]);
const redact = createLogRedactor();
// ponytail: one local Blender job at a time; add parallel slots only after measuring memory and disk budgets.
let busy = false;

export interface BlenderRunInput {
  workspace: string;
  scriptPath?: string;
  /** Only the application loads these bundled sources; never an Agent-supplied absolute path. */
  bundledScripts?: { entry: string; files: Record<string, string> };
  inputs: string[];
  args?: string[];
  timeoutMs?: number;
  /** Host-owned desktop display; never changes the worker's execution policy. */
  liveView?: boolean;
  /** Effective workflow and review mode, including runs without a chat session. */
  workflowRequest?: object;
  /** Host-owned call identity, retained before execution for recovery without replay. */
  invocation?: { callId: string; sessionFile: string; request: unknown };
}
export interface BlenderRunResult {
  id: string;
  directory: string;
  outputDirectory: string;
  files: Array<{ path: string; size: number }>;
  log: string;
  liveView?: BlenderLiveViewResult;
}

export class BlenderRunError extends Error {
  constructor(
    message: string,
    readonly jobId?: string,
    readonly log = "",
  ) {
    super(message);
    this.name = "BlenderRunError";
  }
}

function relativeFile(value: string): string {
  if (
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      ) ||
    isPrivateProjectPath(value)
  )
    throw new Error(
      "Blender inputs must be ordinary, non-private project-relative files",
    );
  return value;
}

// SBPL strings are quoted data, never interpolated expressions.
const quote = (value: string) => JSON.stringify(value);
function sandboxProfile(directory: string): string {
  const readPaths = [
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple",
    "/Library/Fonts",
    "/Applications/Blender.app",
    directory,
  ];
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(EXECUTABLE)}))
(allow process-info* sysctl-read)
(allow file-map-executable (subpath "/System") (subpath "/usr/lib") (subpath "/Applications/Blender.app"))
(allow file-read-metadata)
(allow file-read* ${readPaths.map((value) => `(subpath ${quote(value)})`).join(" ")}
  (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath ${quote(path.join(directory, "output"))}) (subpath ${quote(path.join(directory, "tmp"))}) (subpath ${quote(path.join(directory, "home"))}) (literal "/dev/null"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.FontObjectsServer"))
`;
}

const BOOTSTRAP = `import json, os, resource, runpy, sys
from pathlib import Path
root = Path(__file__).parent
config = json.loads((root / "launch.json").read_text())
resource.setrlimit(resource.RLIMIT_FSIZE, (${FILE_LIMIT}, ${FILE_LIMIT}))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
resource.setrlimit(resource.RLIMIT_CPU, (config["cpu"], config["cpu"]))
os.chdir(root / "inputs")
sys.path.insert(0, str(root / "scripts"))
if config.get("liveView"):
    os.environ["OHMYGAME_BLENDER_LIVE_DIR"] = str(root / "tmp" / "live")
entry = str(root / "scripts" / config["entry"])
sys.argv = [entry, "--", *config["args"], "--input-dir", str(root / "inputs"), "--output-dir", str(root / "output")]
runpy.run_path(entry, run_name="__main__")
`;

async function checkMemory(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-p", String(child.pid), "-o", "rss="],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  }).catch((error) => {
    if (child.exitCode !== null || child.signalCode !== null) return "";
    throw new Error(
      "Blender memory monitoring is unavailable; the job was stopped",
    );
  });
  if (child.exitCode !== null || child.signalCode !== null) return;
  const rss = output.trim();
  if (!/^\d+$/.test(rss))
    throw new Error("Blender memory monitoring returned an invalid result");
  // A sampled watchdog, not a hard RAM quota: a rapid native allocation can exceed it between samples.
  if (Number(rss) > 2 * 1024 * 1024)
    throw new Error(
      "Blender exceeded the 2 GiB resident-memory watchdog; previous assets are unchanged",
    );
}

async function inventory(root: string, limit: number, validate: boolean) {
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("Linked Blender output directories are unavailable");
  const files: Array<{ path: string; size: number }> = [];
  let entries = 0,
    bytes = 0;
  const walk = async (directory: string) => {
    const children = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (!validate && error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const item of children) {
      if (++entries > 512)
        throw new Error("Blender job exceeds its 512-entry limit");
      const filename = path.join(directory, item.name);
      // Running Blender atomically replaces temporary snapshots; completed outputs stay strict.
      const info = await lstat(filename).catch(
        (error: NodeJS.ErrnoException) => {
          if (!validate && error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!info) continue;
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(
          "Blender outputs cannot contain links or special files",
        );
      if (info.isDirectory()) {
        await walk(filename);
        continue;
      }
      if (info.nlink !== 1 || info.size > FILE_LIMIT)
        throw new Error("Blender output is linked or exceeds 64 MiB per file");
      bytes += info.size;
      if (bytes > limit)
        throw new Error("Blender job exceeds its retained output budget");
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (validate) {
        relativeFile(relative);
        if (!OUTPUT_EXTENSIONS.has(path.extname(relative).toLowerCase()))
          throw new Error("Blender output has an unsupported format");
        await readSafeProjectFile(root, filename, FILE_LIMIT);
      }
      files.push({ path: relative, size: info.size });
    }
  };
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** A narrow macOS Blender capability; arbitrary host shell/plugin execution stays disabled. */
export class BlenderRunner {
  constructor(private readonly privateRoot: string) {}

  async status(): Promise<{
    available: boolean;
    executable: string;
    reason?: string;
  }> {
    if (process.platform !== "darwin")
      return {
        available: false,
        executable: EXECUTABLE,
        reason: "Controlled Blender currently requires macOS",
      };
    try {
      for (const filename of [EXECUTABLE, SANDBOX]) {
        if (
          (await realpath(filename)) !== filename ||
          !(await lstat(filename)).isFile()
        )
          throw new Error();
        await access(filename, constants.X_OK);
      }
      return { available: true, executable: EXECUTABLE };
    } catch {
      return {
        available: false,
        executable: EXECUTABLE,
        reason:
          "Install Blender at /Applications/Blender.app; its macOS sandbox launcher must be available",
      };
    }
  }

  /** Local delivery recovery never executes Blender again. */
  async readJob(id: string): Promise<BlenderRunResult> {
    const diagnostic = await this.inspectJob(id);
    if (diagnostic.status !== "completed")
      throw new BlenderRunError(
        diagnostic.message ?? "Blender job has no confirmed successful result",
        id,
        diagnostic.log,
      );
    const directory = path.join(await realpath(this.privateRoot), id),
      outputDirectory = path.join(directory, "output");
    const files = await inventory(outputDirectory, OUTPUT_LIMIT, true);
    if (!files.length)
      throw new BlenderRunError("Blender job has no retained outputs", id);
    return { id, directory, outputDirectory, files, log: diagnostic.log };
  }

  /** Failed/interrupted jobs retain diagnostics, but their partial files are never approved outputs. */
  async inspectJob(id: string): Promise<{
    id: string;
    status: "completed" | "failed" | "interrupted";
    message?: string;
    log: string;
  }> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      )
    )
      throw new BlenderRunError("Invalid Blender job ID");
    const root = await realpath(this.privateRoot);
    if (root !== path.resolve(this.privateRoot))
      throw new BlenderRunError("Linked Blender storage is unavailable");
    const directory = path.join(root, id);
    if (
      !(await lstat(directory)).isDirectory() ||
      (await realpath(directory)) !== directory
    )
      throw new BlenderRunError("Linked Blender jobs are unavailable", id);
    const optional = async (name: string, maximum: number) =>
      readSafeProjectFile(root, path.join(directory, name), maximum).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        },
      );
    const log = redact(
      (await optional("run.log", LOG_LIMIT))?.toString("utf8") ?? "",
      { maxLength: LOG_LIMIT },
    );
    const completed = await optional("completed.json", 1024);
    if (completed) {
      const receipt = JSON.parse(completed.toString("utf8"));
      if (receipt.id !== id || receipt.status !== "completed")
        throw new BlenderRunError("Blender completion record is invalid", id);
      return { id, status: "completed", log };
    }
    const failed = await optional("failed.json", 32 * 1024);
    if (failed) {
      const receipt = JSON.parse(failed.toString("utf8"));
      if (receipt.id !== id || typeof receipt.message !== "string")
        throw new BlenderRunError("Blender failure record is invalid", id);
      return { id, status: "failed", message: redact(receipt.message), log };
    }
    return {
      id,
      status: "interrupted",
      message:
        "Blender has no completed result; inspect the retained inputs before starting a new local job",
      log,
    };
  }

  async run(
    input: BlenderRunInput,
    signal?: AbortSignal,
  ): Promise<BlenderRunResult> {
    signal?.throwIfAborted();
    if (busy)
      throw new BlenderRunError(
        "Another local Blender job is running; wait for its result",
      );
    busy = true;
    let id: string | undefined,
      directory: string | undefined,
      log = "";
    let liveView: BlenderLiveView | undefined;
    let liveResult: BlenderLiveViewResult | undefined;
    try {
      const status = await this.status();
      if (!status.available) throw new Error(status.reason);
      if (!!input.scriptPath === !!input.bundledScripts)
        throw new Error("Choose a project script or bundled Blender workflow");
      const timeout = input.timeoutMs ?? 120_000;
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300_000)
        throw new Error("Blender timeout must be between 1 and 300 seconds");
      if (
        input.inputs.length > 32 ||
        new Set(input.inputs).size !== input.inputs.length
      )
        throw new Error("Choose at most 32 distinct Blender input files");
      const args = input.args ?? [];
      if (
        args.length > 64 ||
        args.some(
          (value) =>
            typeof value !== "string" ||
            value.length > 4096 ||
            /[\x00-\x1f\x7f]/.test(value),
        )
      )
        throw new Error("Invalid Blender script arguments");
      const workspace = await realpath(input.workspace);
      if (
        workspace !== path.resolve(input.workspace) ||
        !(await lstat(workspace)).isDirectory()
      )
        throw new Error("A linked workspace cannot run Blender");
      if (input.scriptPath && path.extname(input.scriptPath) !== ".py")
        throw new Error("Blender scripts must use .py files");
      const scripts = input.bundledScripts ?? {
        entry: "script.py",
        files: {
          "script.py": (
            await readSafeProjectFile(
              workspace,
              path.join(workspace, relativeFile(input.scriptPath!)),
              SCRIPT_LIMIT,
            )
          ).toString("utf8"),
        },
      };
      if (
        !Object.hasOwn(scripts.files, scripts.entry) ||
        Object.keys(scripts.files).length > 8 ||
        Object.entries(scripts.files).some(
          ([name, code]) =>
            !/^[a-zA-Z0-9_-]+\.py$/.test(name) ||
            Buffer.byteLength(code) > SCRIPT_LIMIT,
        )
      )
        throw new Error("Invalid bundled Blender scripts");
      const snapshots: Array<{ path: string; bytes: Buffer }> = [];
      let total = 0;
      for (const name of input.inputs) {
        signal?.throwIfAborted();
        relativeFile(name);
        if (!INPUT_EXTENSIONS.has(path.extname(name).toLowerCase()))
          throw new Error("Unsupported Blender input format");
        const bytes = await readSafeProjectFile(
          workspace,
          path.join(workspace, name),
          FILE_LIMIT,
        );
        total += bytes.length;
        if (total > INPUT_LIMIT)
          throw new Error("Blender inputs exceed 128 MiB");
        snapshots.push({ path: name, bytes });
      }
      await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(this.privateRoot);
      if (
        root !== path.resolve(this.privateRoot) ||
        (await lstat(root)).isSymbolicLink()
      )
        throw new Error("Linked Blender storage is unavailable");
      const space = await statfs(root);
      if (space.bavail * space.bsize < 2 * 1024 * MiB + total)
        throw new Error("Blender needs at least 2 GiB of free working space");
      id = randomUUID();
      directory = path.join(root, id);
      await mkdir(directory, { mode: 0o700 });
      for (const folder of ["inputs", "scripts", "output", "tmp", "home"])
        await mkdir(path.join(directory, folder), { mode: 0o700 });
      for (const snapshot of snapshots) {
        const destination = path.join(directory, "inputs", snapshot.path);
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(destination, snapshot.bytes, {
          flag: "wx",
          mode: 0o400,
        });
      }
      for (const [name, code] of Object.entries(scripts.files))
        await writeFile(path.join(directory, "scripts", name), code, {
          flag: "wx",
          mode: 0o400,
        });
      await writeFile(path.join(directory, "bootstrap.py"), BOOTSTRAP, {
        flag: "wx",
        mode: 0o400,
      });
      await writeFile(
        path.join(directory, "launch.json"),
        JSON.stringify({
          entry: scripts.entry,
          args,
          cpu: Math.ceil(timeout / 1000),
          liveView: input.liveView === true,
        }),
        { flag: "wx", mode: 0o400 },
      );
      if (input.workflowRequest)
        await writeFile(path.join(directory, "workflow.json"), JSON.stringify(input.workflowRequest), { flag: "wx", mode: 0o400 });
      if (input.invocation)
        await writeFile(
          path.join(directory, "invocation.json"),
          JSON.stringify(input.invocation),
          {
            flag: "wx",
            mode: 0o400,
          },
        );
      signal?.throwIfAborted();
      if (input.liveView)
        liveView = await startBlenderLiveView(
          directory,
          async (viewer, viewerDirectory) => {
            await checkMemory(viewer);
            await inventory(viewerDirectory, 192 * MiB, false);
          },
          signal,
        );
      signal?.throwIfAborted();
      const child = spawn(
        SANDBOX,
        [
          "-p",
          sandboxProfile(directory),
          EXECUTABLE,
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--threads",
          "2",
          "--python-exit-code",
          "1",
          "--python",
          path.join(directory, "bootstrap.py"),
        ],
        {
          cwd: path.join(directory, "inputs"),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            HOME: path.join(directory, "home"),
            TMPDIR: path.join(directory, "tmp"),
            PATH: "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            PYTHONNOUSERSITE: "1",
            OMP_NUM_THREADS: "2",
            BLENDER_USER_CONFIG: path.join(directory, "home"),
            BLENDER_USER_SCRIPTS: path.join(directory, "home"),
          },
        },
      );
      registerProjectProcess(child);
      let failure: string | undefined, stopping: Promise<void> | undefined;
      const stop = (reason: string) => {
        failure ??= reason;
        stopping ??= terminateProjectProcess(child);
      };
      const abort = () =>
        stop("Blender job cancelled; previous project assets are unchanged");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(
        () =>
          stop("Blender job timed out; previous project assets are unchanged"),
        timeout,
      );
      let scanning: Promise<void> | undefined,
        memoryCheckedAt = 0;
      const monitor = setInterval(() => {
        if (scanning || failure) return;
        scanning = (async () => {
          await inventory(directory!, INPUT_LIMIT + 256 * MiB, false).catch(
            () => {
              throw new Error("Blender temporary output exceeded its limits");
            },
          );
          if (Date.now() - memoryCheckedAt >= 1000) {
            memoryCheckedAt = Date.now();
            await checkMemory(child);
          }
        })()
          .catch((error) =>
            stop(
              error instanceof Error
                ? error.message
                : "Blender resource monitoring failed",
            ),
          )
          .finally(() => {
            scanning = undefined;
          });
      }, 250);
      const capture = (bytes: Buffer) => {
        if (Buffer.byteLength(log) + bytes.length > LOG_LIMIT) {
          stop("Blender log exceeded its 48 KiB limit");
          return;
        }
        log += bytes.toString("utf8");
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
        clearInterval(monitor);
        signal?.removeEventListener("abort", abort);
        await scanning;
        await (stopping ?? terminateProjectProcess(child));
        liveResult = await liveView?.finish();
      }
      log = redact(log, { maxLength: LOG_LIMIT });
      await writeFile(path.join(directory, "run.log"), log, {
        flag: "wx",
        mode: 0o600,
      });
      if (failure || code !== 0)
        throw new Error(
          failure ??
            `Blender exited with ${child.signalCode ?? `code ${code ?? "unknown"}`}; inspect the retained job log`,
        );
      signal?.throwIfAborted();
      const outputDirectory = path.join(directory, "output");
      const files = await inventory(outputDirectory, OUTPUT_LIMIT, true);
      if (!files.length)
        throw new Error("Blender returned no supported output files");
      await writeFile(
        path.join(directory, "completed.json"),
        JSON.stringify({ id, status: "completed" }),
        { flag: "wx", mode: 0o600 },
      );
      return {
        id,
        directory,
        outputDirectory,
        files,
        log,
        ...(liveResult ? { liveView: liveResult } : {}),
      };
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : "Blender job failed",
      );
      log = redact(log, { maxLength: LOG_LIMIT });
      if (directory) {
        await writeFile(path.join(directory, "run.log"), log, {
          flag: "wx",
          mode: 0o600,
        }).catch(() => {});
        await writeFile(
          path.join(directory, "failed.json"),
          JSON.stringify({ id, message }),
          { flag: "wx", mode: 0o600 },
        ).catch(() => {});
      }
      throw new BlenderRunError(message, id, log);
    } finally {
      await liveView?.finish();
      busy = false;
    }
  }
}
