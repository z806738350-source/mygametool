import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { localAgentPath } from "./agent-local-files.js";
import { inspectProjectSourceBudget, PROJECT_SOURCE_LIMITS, type ProjectSourceProfile } from "./isolated-project-files.js";
import { readSafeProjectFile } from "./safe-project-file.js";

const TOOLKIT = "ink-toolkit.min.mjs";
const RENDERER = "ink-renderer.min.mjs";
const MANIFEST = "runtime-manifest.json";
const FILES = [TOOLKIT, RENDERER, "LICENSE.txt", "NOTICE.md"] as const;
const BUILD_DIRECTORY = /^[0-9a-f]{8}-bake-r[1-9][0-9]*$/;
const MANIFEST_LIMIT = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

interface InkManifest {
  upstreamCommit: string;
  profile: "bake";
  distributionRevision: number;
  files: Record<typeof FILES[number], { size: number; sha256: string }>;
}

interface InkRuntime {
  build: string;
  upstreamCommit: string;
  files: Map<string, Buffer>;
}

interface InkInstallation {
  status: "created" | "reused";
  directory: string;
  toolkitPath: string;
  rendererPath: string;
  manifestPath: string;
  upstreamCommit: string;
}

function parseManifest(bytes: Buffer): InkManifest {
  const value: Partial<InkManifest> | null = JSON.parse(bytes.toString("utf8"));
  if (
    !value || typeof value.upstreamCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.upstreamCommit) ||
    value.profile !== "bake" ||
    typeof value.distributionRevision !== "number" || !Number.isSafeInteger(value.distributionRevision) || value.distributionRevision < 1 ||
    !value.files || Object.keys(value.files).length !== FILES.length ||
    FILES.some(name => {
      const file = value.files?.[name];
      return !file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > PROJECT_SOURCE_LIMITS.fileBytes ||
        typeof file.sha256 !== "string" || !SHA256.test(file.sha256);
    })
  ) throw new Error("Invalid Ink Studio runtime manifest");
  return { upstreamCommit: value.upstreamCommit, profile: value.profile, distributionRevision: value.distributionRevision, files: value.files };
}

async function readRuntime(root: string, signal?: AbortSignal): Promise<InkRuntime> {
  signal?.throwIfAborted();
  const manifestBytes = await readSafeProjectFile(root, path.join(root, MANIFEST), MANIFEST_LIMIT);
  const manifest = parseManifest(manifestBytes);
  const files = new Map<string, Buffer>();
  for (const name of FILES) {
    signal?.throwIfAborted();
    const expected = manifest.files[name];
    const bytes = await readSafeProjectFile(root, path.join(root, name), expected.size);
    if (bytes.length !== expected.size || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`Ink Studio runtime file does not match its manifest: ${name}`);
    }
    files.set(name, bytes);
  }
  signal?.throwIfAborted();
  files.set(MANIFEST, manifestBytes);
  return {
    build: `${manifest.upstreamCommit.slice(0, 8)}-${manifest.profile}-r${manifest.distributionRevision}`,
    upstreamCommit: manifest.upstreamCommit,
    files,
  };
}

async function existingBuild(directory: string): Promise<string | undefined> {
  const resolved = await realpath(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
    return undefined;
  });
  if (!resolved) return undefined;
  if (resolved !== directory) throw new Error("Linked Ink Studio runtime directories are unavailable");
  let build: string | undefined;
  let entries = 0;
  for await (const entry of await opendir(directory)) {
    if (++entries > PROJECT_SOURCE_LIMITS.entries) throw new Error("Too many entries to inspect the Ink Studio runtime directory");
    if (!BUILD_DIRECTORY.test(entry.name)) continue;
    if (build) throw new Error("Several Ink Studio runtime versions are present. Choose one in the project before preparing the runtime.");
    build = entry.name;
  }
  return build;
}

function installation(parent: string, runtime: InkRuntime, status: InkInstallation["status"]): InkInstallation {
  const directory = path.posix.join(parent, runtime.build);
  return {
    status, directory,
    toolkitPath: path.posix.join(directory, TOOLKIT),
    rendererPath: path.posix.join(directory, RENDERER),
    manifestPath: path.posix.join(directory, MANIFEST),
    upstreamCommit: runtime.upstreamCommit,
  };
}

/** The caller holds the project write lock, including the checkpoint and project setting boundaries. */
export async function prepareInkRuntime({ workspace, startupDirectory, bundledDirectory, profile, signal, publish = commit => commit() }: {
  workspace: string;
  startupDirectory: string;
  bundledDirectory: string;
  profile?: ProjectSourceProfile;
  signal?: AbortSignal;
  publish?: (commit: () => Promise<void>) => Promise<void>;
}): Promise<InkInstallation> {
  signal?.throwIfAborted();
  const startup = startupDirectory.replaceAll("\\", "/");
  await localAgentPath(workspace, startup);
  const parentPath = path.posix.join(startup, "vendor", "ink-studio");
  const parent = await localAgentPath(workspace, parentPath, true);
  if (!(await lstat(bundledDirectory)).isDirectory()) throw new Error("Invalid bundled Ink Studio runtime directory");
  const bundled = await readRuntime(await realpath(bundledDirectory), signal);
  const reuse = async (build: string): Promise<InkInstallation> => {
    const directory = await localAgentPath(workspace, path.posix.join(parentPath, build));
    const existing = await readRuntime(directory, signal);
    // A previous build remains project-owned. The installed app has reference bytes for only its current build.
    if (existing.build !== build || (build === bundled.build && [...bundled.files].some(([name, expected]) => !existing.files.get(name)?.equals(expected)))) {
      throw new Error("The existing Ink Studio runtime conflicts with this build. Its files were preserved.");
    }
    return installation(parentPath, existing, "reused");
  };
  const current = await existingBuild(parent);
  if (current) return reuse(current);

  const result = installation(parentPath, bundled, "created");
  const budget = await inspectProjectSourceBudget(workspace, [...bundled.files].map(([name, bytes]) => ({
    path: path.posix.join(result.directory, name), size: bytes.length,
  })), true, signal, { profile });
  if (!budget.complete) throw new Error("Workspace inventory is incomplete. Ink Studio cannot determine whether the runtime fits.");
  if (Object.values(budget.overage).some(Boolean)) {
    throw new Error(`Ink Studio runtime exceeds the isolated project budget (${budget.totalBytes}/${budget.limits.totalBytes} source bytes, ${budget.fileCount}/${budget.limits.fileCount} files).`);
  }

  signal?.throwIfAborted();
  await localAgentPath(workspace, parentPath, true);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await localAgentPath(workspace, parentPath);
  const staging = await mkdtemp(path.join(parent, ".ohmygame-ink-"));
  const entry = await lstat(staging, { bigint: true });
  const ownsStaging = async () => {
    const current = await lstat(staging, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
      return undefined;
    });
    return current?.dev === entry.dev && current.ino === entry.ino && current.isDirectory() && await realpath(staging) === staging;
  };
  try {
    for (const [name, bytes] of bundled.files) {
      signal?.throwIfAborted();
      if (!await ownsStaging()) throw new Error("The Ink Studio staging directory changed");
      await writeFile(path.join(staging, name), bytes, { mode: 0o600, flag: "wx" });
    }
    let installed: InkInstallation | undefined;
    await publish(async () => {
      signal?.throwIfAborted();
      const existing = await existingBuild(parent);
      if (existing) {
        installed = await reuse(existing);
        return;
      }
      const target = await localAgentPath(workspace, result.directory, true);
      if (!await ownsStaging()) throw new Error("The Ink Studio staging directory changed");
      signal?.throwIfAborted();
      try {
        await rename(staging, target);
        installed = result;
      } catch (cause) {
        if (!["ENOTEMPTY", "EEXIST"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
        installed = await reuse(bundled.build);
      }
    });
    if (!installed) throw new Error("Ink Studio runtime publication did not complete");
    return installed;
  } finally {
    if (await ownsStaging()) await rm(staging, { recursive: true, force: true });
  }
}
