import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type {
  DesktopStorageCleanup,
  StorageCategory,
  StorageCleanupEntry,
  StorageCleanupExecuteRequest,
  StorageCleanupItem,
  StorageCleanupPlan,
  StorageCleanupPlanRequest,
  StorageCleanupReason,
  StorageCleanupResult,
  StorageCleanupScan,
} from "../shared/desktop-storage.js";

const TTL = 10 * 60_000;
const SOURCE_DIRS = [
  "src",
  "docs",
  "plugins",
  "scripts",
  "config",
  "integrations",
  "player",
  "build",
  ".github",
];
const CACHES = [
  "node_modules/.vite",
  "node_modules/.vite-temp",
  "node_modules/.cache/vitest",
  ".vite",
];
const DOWNLOADS = ".runtime/local-execution/downloads/";
const INSTALLERS = [
  "lima-2.2.1-Darwin-arm64.tar.gz",
  "node-v22.23.4-linux-arm64.tar.xz",
];
const FINDER_HEADER = Buffer.from("0000000142756431", "hex");
const EXPECTED_ARCHIVES: Record<string, string> = {
  [INSTALLERS[0]!]:
    "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e",
  [INSTALLERS[1]!]:
    "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b",
};

export class StorageCleanupError extends Error {
  constructor(readonly code: StorageCleanupReason) {
    super(code);
  }
}
interface Options {
  root: string;
  supported: boolean;
  trackedPaths?: () => Promise<Set<string>>;
  isInUse?: (absolutePaths: readonly string[]) => Promise<boolean>;
  cacheIdle?: () => Promise<boolean>;
  verifyInstaller?: (relativePath: string) => Promise<boolean>;
  now?: () => number;
  unlink?: (absolutePath: string) => Promise<void>;
  maxFiles?: number;
  maxBytes?: number;
}
interface Leaf {
  relativePath: string;
  signature: string;
  ancestors: string;
  logicalBytes: number;
  allocatedBytes: number;
  inode: string;
  hash?: string;
}
interface Tree {
  signature: string;
  leaves: Leaf[];
  logicalBytes: number;
  allocatedBytes: number;
  unsafe?: StorageCleanupReason;
}
interface Candidate {
  item: StorageCleanupItem;
  tree: Tree;
}
interface StoredPlan {
  value: StorageCleanupPlan;
  candidates: Candidate[];
  used: boolean;
}

function command(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) =>
    execFile(
      binary,
      args,
      {
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed))
          reject(new StorageCleanupError("unknown"));
        else resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
      },
    ),
  );
}
function reason(cause: unknown): StorageCleanupReason {
  if (cause instanceof StorageCleanupError) return cause.code;
  return ["EACCES", "EPERM", "EROFS"].includes(
    (cause as NodeJS.ErrnoException)?.code ?? "",
  )
    ? "permission"
    : "unknown";
}
function exactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}

/** No directory removal and no caller-supplied paths. Unknown files remain untouched. */
export class StorageCleanupService implements DesktopStorageCleanup {
  readonly #root: string;
  #busy = false;
  #scan?: { value: StorageCleanupScan; candidates: Map<string, Candidate> };
  #plan?: StoredPlan;
  readonly #results = new Map<string, StorageCleanupResult>();
  constructor(private readonly options: Options) {
    this.#root = path.resolve(options.root);
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new StorageCleanupError("busy");
    this.#busy = true;
    try {
      return await operation();
    } catch (cause) {
      throw cause instanceof StorageCleanupError
        ? cause
        : new StorageCleanupError(reason(cause));
    } finally {
      this.#busy = false;
    }
  }
  async #rootReady(): Promise<void> {
    if (!this.options.supported) throw new StorageCleanupError("unsupported");
    const entry = await lstat(this.#root);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (await realpath(this.#root)) !== this.#root
    )
      throw new StorageCleanupError("linked");
  }
  async #absolute(
    relative: string,
  ): Promise<{ absolute: string; ancestors: string }> {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new StorageCleanupError("invalid");
    const parts = relative.split("/");
    let current = this.#root;
    const ancestors: string[] = [];
    for (const part of ["", ...parts.slice(0, -1)]) {
      if (part) current = path.join(current, part);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new StorageCleanupError("linked");
      ancestors.push(`${entry.dev}:${entry.ino}:${entry.mode}:${entry.uid}`);
    }
    return {
      absolute: path.join(this.#root, ...parts),
      ancestors: ancestors.join("|"),
    };
  }
  async #digest(relative: string, expected?: string): Promise<string> {
    const { absolute } = await this.#absolute(relative);
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const entry = await handle.stat();
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        entry.size > 128 * 1024 * 1024
      )
        throw new StorageCleanupError("linked");
      if (expected && this.#identity(entry) !== expected)
        throw new StorageCleanupError("changed");
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        digest.update(chunk);
      if (expected && this.#identity(await handle.stat()) !== expected)
        throw new StorageCleanupError("changed");
      return digest.digest("hex");
    } finally {
      await handle.close();
    }
  }
  #identity(entry: Awaited<ReturnType<typeof lstat>>): string {
    return [
      entry.dev,
      entry.ino,
      entry.mode,
      entry.uid,
      entry.nlink,
      entry.size,
      entry.blocks,
      entry.mtimeMs,
      entry.ctimeMs,
    ].join(":");
  }
  async #tree(
    relative: string,
    hashing: boolean,
    excluded = new Set<string>(),
  ): Promise<Tree> {
    const { ancestors } = await this.#absolute(relative);
    const leaves: Leaf[] = [],
      signatures: string[] = [ancestors],
      inodes = new Set<string>();
    let logicalBytes = 0,
      allocatedBytes = 0,
      count = 0,
      unsafe: StorageCleanupReason | undefined;
    const visit = async (name: string): Promise<void> => {
      if (excluded.has(name)) return;
      const { absolute, ancestors: leafAncestors } = await this.#absolute(name),
        entry = await lstat(absolute);
      if (++count > (this.options.maxFiles ?? 100_000))
        throw new StorageCleanupError("limit");
      signatures.push(`${name}:${this.#identity(entry)}`);
      if (entry.isSymbolicLink()) {
        unsafe = "linked";
        return;
      }
      if (entry.isDirectory()) {
        for (const child of (await readdir(absolute)).sort())
          await visit(`${name}/${child}`);
      } else if (entry.isFile()) {
        const inode = `${entry.dev}:${entry.ino}`,
          identity = this.#identity(entry);
        const bytes = inodes.has(inode) ? 0 : entry.blocks * 512;
        inodes.add(inode);
        logicalBytes += entry.size;
        allocatedBytes += bytes;
        if (logicalBytes > (this.options.maxBytes ?? 16 * 1024 ** 3))
          throw new StorageCleanupError("limit");
        if (entry.nlink !== 1 || entry.uid !== process.getuid?.())
          unsafe = "linked";
        const hash =
          hashing && !unsafe ? await this.#digest(name, identity) : undefined;
        if (hash) signatures.push(hash);
        leaves.push({
          relativePath: name,
          signature: identity,
          ancestors: leafAncestors,
          logicalBytes: entry.size,
          allocatedBytes: bytes,
          inode,
          hash,
        });
      } else unsafe = "unknown";
    };
    await visit(relative);
    return {
      signature: createHash("sha256")
        .update(signatures.join("\n"))
        .digest("hex"),
      leaves,
      logicalBytes,
      allocatedBytes,
      unsafe,
    };
  }
  async #tracked(): Promise<Set<string>> {
    if (this.options.trackedPaths) return this.options.trackedPaths();
    await this.#absolute(".git/HEAD");
    const result = await command("/usr/bin/git", [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      this.#root,
      "ls-files",
      "-z",
      "--cached",
    ]);
    if (result.code || result.stderr) throw new StorageCleanupError("unknown");
    return new Set(result.stdout.split("\0").filter(Boolean));
  }
  async #inUse(files: readonly string[]): Promise<boolean> {
    if (this.options.isInUse) return this.options.isInUse(files);
    for (let index = 0; index < files.length; index += 100) {
      const result = await command("/usr/sbin/lsof", [
        "-nP",
        "-Fpn",
        "--",
        ...files.slice(index, index + 100),
      ]);
      if (result.stderr || ![0, 1].includes(result.code))
        throw new StorageCleanupError("unknown");
      if (result.code === 0 && result.stdout) return true;
      if (result.stdout || result.code !== 1)
        throw new StorageCleanupError("unknown");
    }
    return false;
  }
  async #cacheIdle(): Promise<boolean> {
    if (this.options.cacheIdle) return this.options.cacheIdle();
    const result = await command("/bin/ps", ["-axo", "pid=,args="]);
    if (result.code || result.stderr || !result.stdout.trim())
      throw new StorageCleanupError("unknown");
    const processes = result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) throw new StorageCleanupError("unknown");
        return { pid: match[1]!, args: match[2]! };
      });
    if (
      processes.some((process) =>
        /(?:\/|\b)(?:vite|vitest|tsc)(?:\/|\.|\s|$)/i.test(process.args),
      )
    )
      return false;
    const runtimes = processes.filter((process) =>
      /^(?:\S*\/)?(?:node|bun)(?:\s|$)/.test(process.args),
    );
    if (runtimes.some((process) => process.args.includes(this.#root)))
      return false;
    if (!runtimes.length) return true;
    const workingDirectories = await command("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      runtimes.map((process) => process.pid).join(","),
      "-d",
      "cwd",
      "-Fpn",
    ]);
    if (workingDirectories.code || workingDirectories.stderr)
      throw new StorageCleanupError("unknown");
    let currentPid = "";
    const seen = new Set<string>();
    for (const line of workingDirectories.stdout.trim().split("\n")) {
      if (/^p\d+$/.test(line)) currentPid = line.slice(1);
      else if (
        line.startsWith("n/") &&
        currentPid &&
        runtimes.some((process) => process.pid === currentPid)
      ) {
        const directory = line.slice(1);
        seen.add(currentPid);
        if (
          directory === this.#root ||
          directory.startsWith(`${this.#root}/`) ||
          this.#root.startsWith(`${directory.replace(/\/$/, "")}/`)
        )
          return false;
      } else throw new StorageCleanupError("unknown");
    }
    if (seen.size !== runtimes.length) throw new StorageCleanupError("unknown");
    return true;
  }
  async #json(relative: string, limit = 8 * 1024 * 1024): Promise<unknown> {
    const { absolute } = await this.#absolute(relative),
      handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > limit)
        throw new StorageCleanupError("unknown");
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  async #verifyInstaller(relative: string): Promise<boolean> {
    if (this.options.verifyInstaller)
      return this.options.verifyInstaller(relative);
    const name = relative.slice(DOWNLOADS.length);
    if ((await this.#digest(relative)) !== EXPECTED_ARCHIVES[name])
      return false;
    if (name === INSTALLERS[0]) {
      if (
        (await this.#digest(
          ".runtime/local-execution/tools/lima/bin/limactl",
        )) !==
        "6d32fb0f880c0ea750434f2ac855a3f2129126752a301ce4d88adbd2fa599e1e"
      )
        return false;
      if (
        (await this.#digest(
          ".runtime/local-execution/evidence/lima-archive-members.json",
        )) !==
        "35ccbb7469920212b7fa0cf2e477fb2fc54e5bdca3739f56618aa066f9783b95"
      )
        return false;
      const manifest = await this.#json(
        ".runtime/local-execution/evidence/lima-archive-members.json",
      );
      if (
        !Array.isArray(manifest) ||
        manifest.length < 200 ||
        manifest.length > 1000
      )
        return false;
      const listing = await command("/usr/bin/tar", [
        "-tf",
        path.join(this.#root, relative),
      ]);
      const normalize = (file: string) =>
        file.replace(/^\.\//, "").replace(/\/$/, "") || ".";
      const listingPaths = listing.stdout.trim().split("\n");
      if (
        listing.code ||
        listing.stderr ||
        JSON.stringify(listingPaths.map(normalize)) !==
          JSON.stringify(manifest.map((item) => normalize(item.path)))
      )
        return false;
      const installedHash = createHash("sha256");
      let installedBytes = 0;
      for (const [index, item] of manifest.entries()) {
        if (
          !item ||
          typeof item.path !== "string" ||
          typeof item.bytes !== "number"
        )
          return false;
        const file = item.path.replace(/^\.\//, "");
        if (!file || file === ".") continue;
        const { absolute } = await this.#absolute(
            `.runtime/local-execution/tools/lima/${file}`,
          ),
          entry = await lstat(absolute);
        if (item.link !== null) {
          const installedRoot = path.join(
            this.#root,
            ".runtime/local-execution/tools/lima",
          );
          if (
            typeof item.link !== "string" ||
            !entry.isSymbolicLink() ||
            (await readlink(absolute)) !== item.link
          )
            return false;
          const target = path.resolve(path.dirname(absolute), item.link);
          const targetMember = path
            .relative(installedRoot, target)
            .split(path.sep)
            .join("/");
          if (
            !target.startsWith(`${installedRoot}${path.sep}`) ||
            !manifest.some(
              (member) =>
                member.link === null && normalize(member.path) === targetMember,
            ) ||
            (await realpath(absolute)) !== target ||
            this.#identity(await lstat(absolute)) !== this.#identity(entry)
          )
            return false;
          // Only links declared by the pinned archive manifest are permitted; their targets are verified separately.
          continue;
        }
        if (listingPaths[index]!.endsWith("/") !== entry.isDirectory())
          return false;
        if (
          !entry.isDirectory() &&
          (!entry.isFile() ||
            entry.isSymbolicLink() ||
            entry.size !== item.bytes)
        )
          return false;
        if (entry.isFile()) {
          installedBytes += entry.size;
          if (installedBytes > 256 * 1024 * 1024) return false;
          const handle = await open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (this.#identity(await handle.stat()) !== this.#identity(entry))
              return false;
            for await (const chunk of handle.createReadStream({
              autoClose: false,
            }))
              installedHash.update(chunk);
            if (this.#identity(await handle.stat()) !== this.#identity(entry))
              return false;
          } finally {
            await handle.close();
          }
        }
      }
      // -O streams trusted archive entries to stdout; it does not extract files onto disk.
      const archived = await new Promise<Buffer>((resolve, reject) =>
        execFile(
          "/usr/bin/tar",
          ["-xOf", path.join(this.#root, relative)],
          {
            timeout: 30_000,
            maxBuffer: 256 * 1024 * 1024,
            encoding: "buffer",
            env: { PATH: "/usr/bin:/bin", LANG: "C" },
          },
          (error, stdout, stderr) =>
            error || stderr.length
              ? reject(new StorageCleanupError("unverified"))
              : resolve(stdout),
        ),
      );
      return (
        archived.length === installedBytes &&
        createHash("sha256").update(archived).digest("hex") ===
          installedHash.digest("hex")
      );
    }
    // Do not infer the current guest's Node installation from old acceptance logs.
    return false;
  }
  async #knownCache(candidate: Candidate): Promise<boolean> {
    const base = candidate.item.relativePath,
      leaves = candidate.tree.leaves;
    if (base === "node_modules/.vite-temp")
      return leaves.every((leaf) =>
        /^[\w.-]+\.config\.[cm]?[jt]s\.timestamp-\d{13}-[a-f\d]+\.mjs$/i.test(
          leaf.relativePath.slice(base.length + 1),
        ),
      );
    const allowed = new Set<string>(),
      groups = new Set<string>();
    for (const leaf of leaves) {
      const relative = leaf.relativePath.slice(base.length + 1);
      if (
        /^(?:vitest\/)?[a-f\d]{40}\/results\.json$/i.test(relative) ||
        (base === "node_modules/.cache/vitest" && relative === "results.json")
      ) {
        const value = (await this.#json(leaf.relativePath)) as {
          version?: unknown;
          results?: unknown;
        };
        if (typeof value.version !== "string" || !Array.isArray(value.results))
          return false;
        allowed.add(leaf.relativePath);
      } else {
        const match = /^(deps(?:_temp_[a-f\d]+)?)\//i.exec(relative);
        if (match) groups.add(`${base}/${match[1]}`);
      }
    }
    for (const group of groups) {
      const metadataPath = `${group}/_metadata.json`,
        metadata = (await this.#json(metadataPath)) as {
          optimized?: unknown;
          chunks?: unknown;
        };
      if (
        !metadata.optimized ||
        typeof metadata.optimized !== "object" ||
        Array.isArray(metadata.optimized) ||
        !metadata.chunks ||
        typeof metadata.chunks !== "object" ||
        Array.isArray(metadata.chunks)
      )
        return false;
      allowed.add(metadataPath);
      for (const record of [
        ...Object.values(metadata.optimized),
        ...Object.values(metadata.chunks),
      ] as { file?: unknown }[]) {
        if (!record || typeof record.file !== "string") return false;
        const name = path.posix.basename(record.file);
        if (
          !/^[\w@.-]+\.[cm]?js$/i.test(name) ||
          path.resolve(this.#root, group, record.file) !==
            path.join(this.#root, group, name)
        )
          return false;
        if (!leaves.some((leaf) => leaf.relativePath === `${group}/${name}`))
          return false;
        allowed.add(`${group}/${name}`);
        allowed.add(`${group}/${name}.map`);
      }
      const packagePath = `${group}/package.json`;
      if (leaves.some((leaf) => leaf.relativePath === packagePath)) {
        if (
          ((await this.#json(packagePath)) as { type?: unknown }).type !==
          "module"
        )
          return false;
        allowed.add(packagePath);
      }
    }
    return leaves.every((leaf) => allowed.has(leaf.relativePath));
  }
  async #safe(candidate: Candidate, tracked: Set<string>): Promise<void> {
    const { item, tree } = candidate;
    if (tree.unsafe) throw new StorageCleanupError(tree.unsafe);
    if (tree.leaves.some((leaf) => tracked.has(leaf.relativePath)))
      throw new StorageCleanupError("tracked");
    if (!tree.leaves.length) throw new StorageCleanupError("unknown");
    if (item.category === "tool-cache") {
      if (!(await this.#cacheIdle())) throw new StorageCleanupError("running");
      if (!(await this.#knownCache(candidate)))
        throw new StorageCleanupError("unknown");
    } else if (item.category === "install-archives") {
      if (!(await this.#verifyInstaller(item.relativePath)))
        throw new StorageCleanupError("unverified");
    } else if (item.category === "finder-metadata") {
      if (tree.logicalBytes > 16 * 1024 * 1024)
        throw new StorageCleanupError("limit");
      const { absolute } = await this.#absolute(item.relativePath),
        handle = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      try {
        const header = Buffer.alloc(8);
        await handle.read(header, 0, 8, 0);
        if (!header.equals(FINDER_HEADER))
          throw new StorageCleanupError("unverified");
      } finally {
        await handle.close();
      }
    } else throw new StorageCleanupError("protected");
    if (
      await this.#inUse(
        tree.leaves.map((leaf) => path.join(this.#root, leaf.relativePath)),
      )
    )
      throw new StorageCleanupError("in-use");
  }
  async #recheck(candidate: Candidate, tracked: Set<string>): Promise<void> {
    let current: Tree;
    try {
      current = await this.#tree(candidate.item.relativePath, true);
    } catch (cause) {
      if (reason(cause) === "permission") throw cause;
      throw new StorageCleanupError("changed");
    }
    if (current.signature !== candidate.tree.signature)
      throw new StorageCleanupError("changed");
    await this.#safe({ item: candidate.item, tree: current }, tracked);
  }
  scan(): Promise<StorageCleanupScan> {
    return this.#exclusive(async () => {
      this.#scan = undefined;
      this.#plan = undefined;
      const createdAt = new Date(this.#now()).toISOString(),
        expiresAt = new Date(this.#now() + TTL).toISOString();
      const value: StorageCleanupScan = {
        supported: this.options.supported,
        rootPath: this.#root,
        scanId: randomUUID(),
        createdAt,
        expiresAt,
        items: [],
        errors: [],
        logicalBytes: 0,
        allocatedBytes: 0,
        measurementComplete: true,
      };
      if (!this.options.supported) {
        value.reason = "unsupported";
        return value;
      }
      await this.#rootReady();
      let tracked: Set<string> | undefined;
      try {
        tracked = await this.#tracked();
      } catch {
        value.errors.push({ relativePath: ".git", reason: "unknown" });
      }
      const candidates = new Map<string, Candidate>(),
        countedPaths = new Set<string>(),
        countedInodes = new Set<string>();
      const add = async (
        relativePath: string,
        category: StorageCategory,
        blocked?: StorageCleanupReason,
      ): Promise<void> => {
        const item: StorageCleanupItem = {
          id: randomUUID(),
          category,
          relativePath,
          logicalBytes: 0,
          allocatedBytes: 0,
          fileCount: 0,
          state: "blocked",
          measurementComplete: true,
          impact: blocked
            ? "preserved"
            : category === "install-archives"
              ? "installer-copy"
              : "regenerable",
          ...(blocked ? { reason: blocked } : {}),
        };
        try {
          const tree = await this.#tree(
            relativePath,
            !blocked,
            blocked ? countedPaths : undefined,
          );
          if (tree.unsafe) {
            item.measurementComplete = false;
            item.reason = tree.unsafe;
            value.measurementComplete = false;
            value.errors.push({ relativePath, reason: tree.unsafe });
          }
          item.fileCount = tree.leaves.length;
          for (const leaf of tree.leaves) {
            if (!countedPaths.has(leaf.relativePath)) {
              item.logicalBytes += leaf.logicalBytes;
              value.logicalBytes += leaf.logicalBytes;
              countedPaths.add(leaf.relativePath);
            }
            if (!countedInodes.has(leaf.inode)) {
              item.allocatedBytes += leaf.allocatedBytes;
              value.allocatedBytes += leaf.allocatedBytes;
              countedInodes.add(leaf.inode);
            }
          }
          if (!blocked) {
            try {
              if (!tracked) throw new StorageCleanupError("unknown");
              await this.#safe({ item, tree }, tracked);
              item.state = "eligible";
              candidates.set(item.id, { item, tree });
            } catch (cause) {
              item.reason = reason(cause);
            }
          }
          value.items.push(item);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
          item.reason = reason(cause);
          item.measurementComplete = false;
          value.measurementComplete = false;
          value.items.push(item);
          value.errors.push({ relativePath, reason: item.reason });
        }
      };
      const findMetadata = async (
        directory: string,
        depth = 0,
      ): Promise<void> => {
        if (depth > 30) throw new StorageCleanupError("limit");
        let names: string[];
        try {
          const { absolute } = await this.#absolute(`${directory}/.DS_Store`);
          names = await readdir(path.dirname(absolute));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
          value.errors.push({ relativePath: directory, reason: reason(cause) });
          return;
        }
        for (const name of names.sort()) {
          if (name === ".DS_Store")
            await add(`${directory}/${name}`, "finder-metadata");
          else if (!name.startsWith(".") && name !== "node_modules") {
            const child = `${directory}/${name}`,
              { absolute } = await this.#absolute(child),
              entry = await lstat(absolute);
            if (entry.isDirectory() && !entry.isSymbolicLink())
              await findMetadata(child, depth + 1);
          }
        }
      };
      await add(".DS_Store", "finder-metadata");
      for (const directory of SOURCE_DIRS) await findMetadata(directory);
      for (const relative of [
        ".runtime/.DS_Store",
        ".runtime/local-execution/.DS_Store",
        ".runtime/local-launch/.DS_Store",
      ])
        await add(relative, "finder-metadata");
      for (const relative of CACHES) await add(relative, "tool-cache");
      for (const name of INSTALLERS)
        await add(DOWNLOADS + name, "install-archives");
      await add(
        DOWNLOADS + "ubuntu-24.04-server-cloudimg-arm64.img",
        "install-archives",
        "protected",
      );
      for (const profile of ["", "Default/"])
        for (const name of [
          "Cache",
          "GPUCache",
          "Code Cache",
          "DawnGraphiteCache",
          "DawnWebGPUCache",
        ])
          await add(
            `.runtime/local-execution/manual-data/desktop/browser/${profile}${name}`,
            "browser-cache",
            "running",
          );
      for (const relative of [
        ".runtime/local-launch/tmp",
        ".runtime/local-execution/tmp",
      ])
        await add(relative, "runtime-temp", "running");
      let residue = false;
      try {
        const data = ".runtime/local-execution/manual-data",
          library = (await this.#json(`${data}/library/assets.json`)) as {
            assets?: { id?: unknown }[];
          };
        if (
          !Array.isArray(library.assets) ||
          library.assets.some((asset) => typeof asset.id !== "string")
        )
          throw new StorageCleanupError("unknown");
        const ids = new Set(library.assets.map((asset) => asset.id)),
          { absolute } = await this.#absolute(`${data}/projects/.entry`);
        for (const project of await readdir(path.dirname(absolute))) {
          if (!/^[a-f\d-]{36}$/i.test(project)) continue;
          const manifestPath = `${data}/projects/${project}/workspace/canvas/assets.json`;
          let manifest: {
            assets?: Record<
              string,
              { libraryAssetId?: unknown; path?: unknown }
            >;
          };
          try {
            manifest = (await this.#json(manifestPath)) as typeof manifest;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw cause;
          }
          if (
            !manifest.assets ||
            typeof manifest.assets !== "object" ||
            Array.isArray(manifest.assets)
          )
            throw new StorageCleanupError("unknown");
          for (const asset of Object.values(manifest.assets))
            if (
              typeof asset.libraryAssetId === "string" &&
              !ids.has(asset.libraryAssetId) &&
              typeof asset.path === "string"
            ) {
              await add(
                `${data}/projects/${project}/workspace/${asset.path}`,
                "library-residue",
                "protected",
              );
              residue = true;
            }
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          value.errors.push({
            relativePath: ".runtime/local-execution/manual-data/projects",
            reason: "unknown",
          });
      }
      if (!residue)
        value.items.push({
          id: randomUUID(),
          category: "library-residue",
          relativePath: ".runtime/local-execution/manual-data/projects",
          state: "blocked",
          reason: "unknown",
          impact: "preserved",
          fileCount: 0,
          logicalBytes: 0,
          allocatedBytes: 0,
          measurementComplete: false,
        });
      try {
        const { absolute } = await this.#absolute(
          ".runtime/local-execution/.entry",
        );
        for (const name of await readdir(path.dirname(absolute)))
          if (name.startsWith("acceptance-"))
            await add(
              `.runtime/local-execution/${name}`,
              "upgrade-tests",
              "protected",
            );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          value.errors.push({
            relativePath: ".runtime/local-execution",
            reason: "unknown",
          });
      }
      for (const relative of [
        ".runtime/local-execution/evidence",
        ".runtime/local-launch/acceptance",
        ".runtime/local-launch/stale-locks",
      ])
        await add(relative, "upgrade-tests", "protected");
      for (const relative of [
        ".runtime/local-execution/manual-data",
        ".runtime/local-execution/test-data",
        ".runtime/local-execution/lima",
        ".runtime/local-execution/tools",
        ".runtime/toolchain",
        ".runtime/local-recovery",
        ".runtime/recovered-media",
        "node_modules",
      ])
        await add(relative, "protected-data", "protected");
      // Remaining top-level paths contribute occupancy only; they never become cleanup candidates.
      for (const name of (await readdir(this.#root)).sort()) {
        if (name === ".git") {
          value.items.push({
            id: randomUUID(),
            category: "protected-data",
            relativePath: name,
            state: "blocked",
            reason: "protected",
            impact: "preserved",
            logicalBytes: 0,
            allocatedBytes: 0,
            fileCount: 0,
            measurementComplete: false,
          });
        } else await add(name, "protected-data", "protected");
      }
      this.#scan = { value, candidates };
      value.measurementComplete =
        value.errors.length === 0 &&
        value.items.every((item) => item.measurementComplete !== false);
      return structuredClone(value);
    });
  }
  plan(request: StorageCleanupPlanRequest): Promise<StorageCleanupPlan> {
    return this.#exclusive(async () => {
      await this.#rootReady();
      if (
        !exactKeys(request, ["scanId", "itemIds"]) ||
        typeof request.scanId !== "string" ||
        !Array.isArray(request.itemIds) ||
        !request.itemIds.length ||
        request.itemIds.length > 10_000 ||
        request.itemIds.some((id) => typeof id !== "string") ||
        new Set(request.itemIds).size !== request.itemIds.length
      )
        throw new StorageCleanupError("invalid");
      const scan = this.#scan;
      if (!scan || scan.value.scanId !== request.scanId)
        throw new StorageCleanupError("invalid");
      if (this.#now() >= Date.parse(scan.value.expiresAt))
        throw new StorageCleanupError("expired");
      const candidates = request.itemIds.map((id) => {
        const candidate = scan.candidates.get(id);
        if (!candidate) throw new StorageCleanupError("invalid");
        return candidate;
      });
      const tracked = await this.#tracked();
      for (const candidate of candidates)
        await this.#recheck(candidate, tracked);
      const entries = candidates.flatMap((candidate) =>
        candidate.tree.leaves.map((leaf): StorageCleanupEntry => ({
          id: randomUUID(),
          itemId: candidate.item.id,
          category: candidate.item.category,
          relativePath: leaf.relativePath,
          logicalBytes: leaf.logicalBytes,
          allocatedBytes: leaf.allocatedBytes,
        })),
      );
      const value: StorageCleanupPlan = {
        scanId: request.scanId,
        planId: randomUUID(),
        confirmationToken: randomUUID(),
        expiresAt: new Date(this.#now() + TTL).toISOString(),
        entries,
        permanent: true,
        logicalBytes: entries.reduce(
          (sum, entry) => sum + entry.logicalBytes,
          0,
        ),
        allocatedBytes: entries.reduce(
          (sum, entry) => sum + entry.allocatedBytes,
          0,
        ),
      };
      this.#plan = { value, candidates, used: false };
      return structuredClone(value);
    });
  }
  execute(
    request: StorageCleanupExecuteRequest,
  ): Promise<StorageCleanupResult> {
    return this.#exclusive(async () => {
      await this.#rootReady();
      if (
        !exactKeys(request, ["planId", "confirmationToken", "confirmation"]) ||
        request.confirmation !== "PERMANENT_DELETE"
      )
        throw new StorageCleanupError("invalid");
      const plan = this.#plan;
      if (
        !plan ||
        plan.used ||
        request.planId !== plan.value.planId ||
        request.confirmationToken !== plan.value.confirmationToken
      )
        throw new StorageCleanupError("invalid");
      plan.used = true;
      if (this.#now() >= Date.parse(plan.value.expiresAt))
        throw new StorageCleanupError("expired");
      const tracked = await this.#tracked();
      for (const candidate of plan.candidates)
        await this.#recheck(candidate, tracked);
      const result: StorageCleanupResult = {
        planId: plan.value.planId,
        completedAt: "",
        entries: [],
        deletedLogicalBytes: 0,
        deletedAllocatedBytes: 0,
      };
      for (const entry of plan.value.entries) {
        let attempted = false;
        try {
          if (this.#now() >= Date.parse(plan.value.expiresAt))
            throw new StorageCleanupError("expired");
          const expected = plan.candidates
            .find((candidate) => candidate.item.id === entry.itemId)!
            .tree.leaves.find(
              (leaf) => leaf.relativePath === entry.relativePath,
            )!;
          const current = await this.#tree(entry.relativePath, true);
          if (
            current.unsafe ||
            current.leaves.length !== 1 ||
            current.leaves[0]!.signature !== expected.signature ||
            current.leaves[0]!.hash !== expected.hash ||
            current.leaves[0]!.ancestors !== expected.ancestors
          )
            throw new StorageCleanupError("changed");
          const { absolute } = await this.#absolute(entry.relativePath);
          if (await this.#inUse([absolute]))
            throw new StorageCleanupError("in-use");
          if (entry.category === "tool-cache" && !(await this.#cacheIdle()))
            throw new StorageCleanupError("running");
          if (
            entry.category === "install-archives" &&
            !(await this.#verifyInstaller(entry.relativePath))
          )
            throw new StorageCleanupError("unverified");
          if (
            (await this.#absolute(entry.relativePath)).ancestors !==
            expected.ancestors
          )
            throw new StorageCleanupError("changed");
          const final = await lstat(absolute);
          if (
            !final.isFile() ||
            final.isSymbolicLink() ||
            final.nlink !== 1 ||
            this.#identity(final) !== expected.signature
          )
            throw new StorageCleanupError("changed");
          attempted = true;
          await (this.options.unlink ?? unlink)(absolute);
          result.entries.push({ ...entry, status: "deleted" });
          result.deletedLogicalBytes += entry.logicalBytes;
          result.deletedAllocatedBytes += entry.allocatedBytes;
        } catch (cause) {
          result.entries.push({
            ...entry,
            status: attempted ? "failed" : "retained",
            reason: reason(cause),
          });
        }
      }
      result.completedAt = new Date(this.#now()).toISOString();
      this.#results.set(result.planId, structuredClone(result));
      if (this.#results.size > 20)
        this.#results.delete(this.#results.keys().next().value!);
      return result;
    });
  }
  async result(planId: string): Promise<StorageCleanupResult | undefined> {
    if (typeof planId !== "string" || !/^[a-f\d-]{36}$/i.test(planId))
      throw new StorageCleanupError("invalid");
    const result = this.#results.get(planId);
    return result ? structuredClone(result) : undefined;
  }
}
