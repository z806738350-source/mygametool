import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageCleanupError,
  StorageCleanupService,
} from "../src/desktop/storage-cleanup.js";
import type {
  StorageCleanupItem,
  StorageCleanupPlan,
} from "../src/shared/desktop-storage.js";

const directories: string[] = [];
const FINDER_HEADER = Buffer.from("0000000142756431", "hex");
const finderBytes = (value: string) =>
  Buffer.concat([FINDER_HEADER, Buffer.from(value)]);
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

type Options = ConstructorParameters<typeof StorageCleanupService>[0];
async function fixture(overrides: Partial<Options> = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ohmygame-storage-cleanup-")),
  );
  directories.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const service = new StorageCleanupService({
    root,
    supported: true,
    trackedPaths: async () => new Set(),
    isInUse: async () => false,
    cacheIdle: async () => true,
    verifyInstaller: async () => true,
    ...overrides,
  });
  const cachedModules = new Map<string, Set<string>>();
  const write = async (relativePath: string, value = "temporary fixture") => {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(
      absolutePath,
      path.basename(relativePath) === ".DS_Store" ? finderBytes(value) : value,
    );
    const module = relativePath.match(
      /^((?:node_modules\/)?\.vite\/deps)\/([^/]+\.[cm]?js)$/,
    );
    if (module) {
      const modules = cachedModules.get(module[1]!) ?? new Set<string>();
      modules.add(module[2]!);
      cachedModules.set(module[1]!, modules);
      await fs.writeFile(
        path.join(root, module[1]!, "_metadata.json"),
        JSON.stringify({
          optimized: Object.fromEntries(
            [...modules].map((file) => [file, { file }]),
          ),
          chunks: {},
        }),
      );
    }
    return absolutePath;
  };
  const read = async (relativePath: string) => {
    const bytes = await fs.readFile(path.join(root, relativePath));
    return (
      path.basename(relativePath) === ".DS_Store" &&
      bytes.subarray(0, 8).equals(FINDER_HEADER)
        ? bytes.subarray(8)
        : bytes
    ).toString();
  };
  const item = async (relativePath: string) => {
    const scan = await service.scan();
    const selected = scan.items.find(
      (candidate) => candidate.relativePath === relativePath,
    );
    expect(selected, `Missing scan item: ${relativePath}`).toBeDefined();
    return { scan, selected: selected! };
  };
  const plan = async (relativePaths: string[]) => {
    const scan = await service.scan();
    const selected = relativePaths.map((relativePath) => {
      const candidate = scan.items.find(
        (entry) => entry.relativePath === relativePath,
      );
      expect(candidate, `Missing scan item: ${relativePath}`).toMatchObject({
        state: "eligible",
      });
      return candidate!;
    });
    return service.plan({
      scanId: scan.scanId,
      itemIds: selected.map((entry) => entry.id),
    });
  };
  return { root, service, write, read, item, plan };
}

function confirmation(plan: StorageCleanupPlan) {
  return {
    planId: plan.planId,
    confirmationToken: plan.confirmationToken,
    confirmation: "PERMANENT_DELETE" as const,
  };
}
function eligible(items: StorageCleanupItem[]) {
  return items.filter((item) => item.state === "eligible");
}

describe("local desktop storage cleanup", () => {
  it("does not classify an arbitrary user file named .DS_Store as Finder metadata", async () => {
    const { root, service } = await fixture();
    const file = path.join(root, ".DS_Store");
    await fs.writeFile(
      file,
      "user-authored bytes with an unfortunate filename",
    );
    const scan = await service.scan();
    expect(
      eligible(scan.items).some((item) => item.relativePath === ".DS_Store"),
    ).toBe(false);
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store")?.reason,
    ).toBe("unverified");
    expect(await fs.readFile(file, "utf8")).toBe(
      "user-authored bytes with an unfortunate filename",
    );
  });

  it("reports unsupported environments and refuses to create a cleanup plan", async () => {
    const { service, write, read } = await fixture({ supported: false });
    await write(".DS_Store", "keep");
    const scan = await service.scan();
    expect(scan.supported).toBe(false);
    expect(eligible(scan.items)).toEqual([]);
    await expect(
      service.plan({ scanId: scan.scanId, itemIds: ["arbitrary"] }),
    ).rejects.toBeInstanceOf(StorageCleanupError);
    expect(await read(".DS_Store")).toBe("keep");
  });

  it("measures real file sizes and allocated blocks, and deletes only explicitly confirmed entries", async () => {
    const { service, write, read, plan } = await fixture();
    const metadata = await write("src/.DS_Store", "finder metadata");
    await write("src/work-in-progress.ts", "uncommitted source");
    const stat = await fs.stat(metadata);
    const planned = await plan(["src/.DS_Store"]);
    expect(planned.permanent).toBe(true);
    expect(planned.entries).toHaveLength(1);
    expect(planned.entries[0]).toMatchObject({
      relativePath: "src/.DS_Store",
      logicalBytes: stat.size,
      allocatedBytes: stat.blocks * 512,
    });
    expect(planned.logicalBytes).toBe(stat.size);
    expect(planned.allocatedBytes).toBe(stat.blocks * 512);
    expect(await read("src/.DS_Store")).toBe("finder metadata");
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toEqual([
      expect.objectContaining({
        relativePath: "src/.DS_Store",
        status: "deleted",
      }),
    ]);
    expect(result.deletedLogicalBytes).toBe(stat.size);
    expect(result.deletedAllocatedBytes).toBe(stat.blocks * 512);
    await expect(fs.stat(metadata)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read("src/work-in-progress.ts")).toBe("uncommitted source");
    expect(await service.result(planned.planId)).toEqual(result);
  });

  it("keeps sparse files' logical size separate from their actual allocated blocks", async () => {
    const { write, plan } = await fixture();
    const absolute = await write(".DS_Store", "sparse fixture");
    const handle = await fs.open(absolute, "r+");
    try {
      await handle.truncate(64 * 1024);
    } finally {
      await handle.close();
    }
    const stat = await fs.stat(absolute);
    const planned = await plan([".DS_Store"]);
    expect(planned.logicalBytes).toBe(64 * 1024);
    expect(planned.allocatedBytes).toBe(stat.blocks * 512);
    expect(planned.entries[0]?.allocatedBytes).toBe(stat.blocks * 512);
  });

  it("counts shared hardlink storage once while keeping both files protected", async () => {
    const { root, service, write } = await fixture();
    const directory = ".runtime/local-execution/manual-data";
    const original = await write(`${directory}/original.bin`, "shared blocks");
    await fs.link(original, path.join(root, directory, "second.bin"));
    const stat = await fs.stat(original);
    const scan = await service.scan();
    const item = scan.items.find(
      (candidate) => candidate.relativePath === directory,
    )!;
    expect(item.state).toBe("blocked");
    expect(item.logicalBytes).toBe(stat.size * 2);
    expect(item.allocatedBytes).toBe(stat.blocks * 512);
    expect(eligible(scan.items)).toEqual([]);
  });

  it("rejects arbitrary paths, unknown scans, duplicate item IDs and additional request fields", async () => {
    const { service, write, read } = await fixture();
    await write(".DS_Store", "keep");
    const scan = await service.scan();
    const selected = scan.items.find(
      (item) => item.relativePath === ".DS_Store",
    )!;
    for (const request of [
      { scanId: "missing", itemIds: [selected.id] },
      { scanId: scan.scanId, itemIds: ["../outside"] },
      { scanId: scan.scanId, itemIds: [selected.id, selected.id] },
      { scanId: scan.scanId, itemIds: [selected.id], paths: ["/arbitrary"] },
    ])
      await expect(service.plan(request)).rejects.toBeInstanceOf(
        StorageCleanupError,
      );
    expect(await read(".DS_Store")).toBe("keep");
  });

  it("requires the exact confirmation and token before performing any deletion", async () => {
    const { service, write, read, plan } = await fixture();
    await write(".DS_Store", "keep");
    const planned = await plan([".DS_Store"]);
    await expect(
      service.execute({
        ...confirmation(planned),
        confirmation: "delete",
      } as never),
    ).rejects.toBeInstanceOf(StorageCleanupError);
    await expect(
      service.execute({
        ...confirmation(planned),
        confirmationToken: "wrong-token",
      }),
    ).rejects.toBeInstanceOf(StorageCleanupError);
    await expect(
      service.execute({
        ...confirmation(planned),
        paths: ["/arbitrary"],
      } as never),
    ).rejects.toBeInstanceOf(StorageCleanupError);
    expect(await read(".DS_Store")).toBe("keep");
  });

  it("expires scans and confirmation plans instead of reusing old filesystem checks", async () => {
    let now = Date.now();
    const { service, write, read, plan } = await fixture({ now: () => now });
    await write(".DS_Store", "keep");
    const scan = await service.scan();
    now = Date.parse(scan.expiresAt) + 1;
    await expect(
      service.plan({
        scanId: scan.scanId,
        itemIds: [
          scan.items.find((item) => item.relativePath === ".DS_Store")!.id,
        ],
      }),
    ).rejects.toMatchObject({ code: "expired" });
    const planned = await plan([".DS_Store"]);
    now = Date.parse(planned.expiresAt) + 1;
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "expired",
    });
    expect(await read(".DS_Store")).toBe("keep");
  });

  it("rejects changed contents between the scan and confirmation plan", async () => {
    const { service, write, read } = await fixture();
    await write(".DS_Store", "before");
    const scan = await service.scan();
    await write(".DS_Store", "after!");
    await expect(
      service.plan({
        scanId: scan.scanId,
        itemIds: [
          scan.items.find((item) => item.relativePath === ".DS_Store")!.id,
        ],
      }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(await read(".DS_Store")).toBe("after!");
  });

  it("rechecks same-size edited files even when their mtime is restored", async () => {
    const { service, write, read, plan } = await fixture();
    const absolute = await write(".DS_Store", "before");
    const stat = await fs.stat(absolute);
    const planned = await plan([".DS_Store"]);
    await fs.writeFile(absolute, finderBytes("after!"));
    await fs.utimes(absolute, stat.atime, stat.mtime);
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "changed",
    });
    expect(await read(".DS_Store")).toBe("after!");
  });

  it("rejects a replacement inode even when the replacement has identical bytes", async () => {
    const { service, write, read, plan } = await fixture();
    const absolute = await write(".DS_Store", "identical");
    const planned = await plan([".DS_Store"]);
    await fs.rename(absolute, `${absolute}.saved-fixture`);
    await fs.writeFile(absolute, finderBytes("identical"));
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "changed",
    });
    expect(await read(".DS_Store")).toBe("identical");
  });

  it("rejects new cache files added after confirmation without deleting any planned leaf", async () => {
    const { service, write, read, plan } = await fixture();
    await write("node_modules/.vite/deps/generated.js", "cached module");
    const planned = await plan(["node_modules/.vite"]);
    await write("node_modules/.vite/deps/new-draft.txt", "newly appeared");
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "changed",
    });
    expect(await read("node_modules/.vite/deps/generated.js")).toBe(
      "cached module",
    );
    expect(await read("node_modules/.vite/deps/new-draft.txt")).toBe(
      "newly appeared",
    );
  });

  it("plans only cache leaf files and preserves sibling dependencies and sources", async () => {
    const { service, write, read, plan } = await fixture();
    await write("node_modules/.vite/deps/generated.js", "generated");
    await write("node_modules/.vite/deps/package.json", '{"type":"module"}');
    await write("node_modules/react/package.json", "dependency");
    await write("src/unsaved-work.ts", "source");
    const planned = await plan(["node_modules/.vite"]);
    expect(planned.entries.map((entry) => entry.relativePath).sort()).toEqual([
      "node_modules/.vite/deps/_metadata.json",
      "node_modules/.vite/deps/generated.js",
      "node_modules/.vite/deps/package.json",
    ]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries.every((entry) => entry.status === "deleted")).toBe(
      true,
    );
    expect(await read("node_modules/react/package.json")).toBe("dependency");
    expect(await read("src/unsaved-work.ts")).toBe("source");
  });

  it.each(["notes.json", "scratch.js"])(
    "keeps a cache containing an unregistered %s file",
    async (name) => {
      const { root, service, write } = await fixture();
      await write("node_modules/.vite/deps/generated.js", "known module");
      const unknown = path.join(root, "node_modules/.vite/deps", name);
      await fs.writeFile(unknown, "unknown work must remain");
      const scan = await service.scan();
      expect(
        scan.items.find((item) => item.relativePath === "node_modules/.vite"),
      ).toMatchObject({ state: "blocked", reason: "unknown" });
      expect(await fs.readFile(unknown, "utf8")).toBe(
        "unknown work must remain",
      );
    },
  );

  it("does not accept a cache manifest that points outside its managed directory", async () => {
    const { root, service, write, read } = await fixture();
    await write("node_modules/.vite/deps/generated.js", "known module");
    await write("src/important.js", "must remain");
    await fs.writeFile(
      path.join(root, "node_modules/.vite/deps/_metadata.json"),
      JSON.stringify({
        optimized: { escaped: { file: "../../../src/important.js" } },
        chunks: {},
      }),
    );
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite"),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
    expect(await read("src/important.js")).toBe("must remain");
  });

  it("accepts only recognizable inactive Vite config build files", async () => {
    const { service, write, read, plan } = await fixture();
    const generated =
      "node_modules/.vite-temp/vite.config.ts.timestamp-1793736000000-abcdef123.mjs";
    await write(generated, "generated config build");
    const planned = await plan(["node_modules/.vite-temp"]);
    expect(planned.entries.map((entry) => entry.relativePath)).toEqual([
      generated,
    ]);
    await service.execute(confirmation(planned));
    await write("node_modules/.vite-temp/scratch.js", "unknown work");
    const scan = await service.scan();
    expect(
      scan.items.find(
        (item) => item.relativePath === "node_modules/.vite-temp",
      ),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
    expect(await read("node_modules/.vite-temp/scratch.js")).toBe(
      "unknown work",
    );
  });

  it("recognizes inactive Vitest result data without admitting extra files", async () => {
    const { root, service, write, plan } = await fixture();
    const relative = `.vite/vitest/${"a".repeat(40)}/results.json`;
    await write(relative, JSON.stringify({ version: "3.2.6", results: [] }));
    const planned = await plan([".vite"]);
    expect(planned.entries.map((entry) => entry.relativePath)).toEqual([
      relative,
    ]);
    await fs.writeFile(path.join(root, ".vite/notes.json"), "unknown data");
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "changed",
    });
  });

  it("blocks linked targets, linked ancestors and multiple-link Finder metadata", async () => {
    const { root, service, write } = await fixture();
    const original = await write("untouched.txt", "keep");
    await fs.symlink(original, path.join(root, ".DS_Store"));
    await fs.mkdir(path.join(root, "docs"));
    await fs.link(original, path.join(root, "docs/.DS_Store"));
    await fs.mkdir(path.join(root, "outside-fixture"));
    await fs.writeFile(
      path.join(root, "outside-fixture/.DS_Store"),
      "keep linked directory",
    );
    await fs.symlink(
      path.join(root, "outside-fixture"),
      path.join(root, "src"),
      "dir",
    );
    const scan = await service.scan();
    expect(
      eligible(scan.items).some((item) =>
        [".DS_Store", "src/.DS_Store", "docs/.DS_Store"].includes(
          item.relativePath,
        ),
      ),
    ).toBe(false);
    expect(await fs.readFile(original, "utf8")).toBe("keep");
  });

  it("rejects an ancestor replaced by a symlink after the plan", async () => {
    const { root, service, write, plan } = await fixture();
    await write("src/.DS_Store", "planned");
    await write("replacement-fixture/.DS_Store", "keep replacement");
    const planned = await plan(["src/.DS_Store"]);
    await fs.rename(
      path.join(root, "src"),
      path.join(root, "src.saved-fixture"),
    );
    await fs.symlink(
      path.join(root, "replacement-fixture"),
      path.join(root, "src"),
      "dir",
    );
    await expect(service.execute(confirmation(planned))).rejects.toBeInstanceOf(
      StorageCleanupError,
    );
    expect(
      await fs.readFile(path.join(root, "replacement-fixture/.DS_Store")),
    ).toEqual(finderBytes("keep replacement"));
    expect(
      await fs.readFile(path.join(root, "src.saved-fixture/.DS_Store")),
    ).toEqual(finderBytes("planned"));
  });

  it("blocks tracked files and caches containing tracked files", async () => {
    const { service, write } = await fixture({
      trackedPaths: async () =>
        new Set([".DS_Store", "node_modules/.vite/deps/generated.js"]),
    });
    await write(".DS_Store");
    await write("node_modules/.vite/deps/generated.js");
    const scan = await service.scan();
    expect(eligible(scan.items)).toEqual([]);
  });

  it("never turns failed usage or Git inspection into permission to delete", async () => {
    for (const overrides of [
      {
        trackedPaths: async () => {
          throw new Error("Git unavailable");
        },
      },
      {
        isInUse: async () => {
          throw new Error("lsof could not inspect files");
        },
      },
    ]) {
      const { service, write, read } = await fixture(overrides);
      await write(".DS_Store", "keep");
      const scan = await service.scan();
      expect(eligible(scan.items)).toEqual([]);
      expect(await read(".DS_Store")).toBe("keep");
    }
  });

  it("blocks running tool caches even if no cache file currently has an open handle", async () => {
    const { service, write } = await fixture({
      cacheIdle: async () => false,
      isInUse: async () => false,
    });
    await write("node_modules/.vite/deps/generated.js");
    const scan = await service.scan();
    expect(
      eligible(scan.items).some((item) => item.category === "tool-cache"),
    ).toBe(false);
  });

  it("rechecks file use before execute and retains the entire plan if it becomes unsafe", async () => {
    let used = false;
    const { service, write, read, plan } = await fixture({
      isInUse: async () => used,
    });
    await write(".DS_Store", "first");
    await write("src/.DS_Store", "second");
    const planned = await plan([".DS_Store", "src/.DS_Store"]);
    used = true;
    await expect(service.execute(confirmation(planned))).rejects.toBeInstanceOf(
      StorageCleanupError,
    );
    expect(await read(".DS_Store")).toBe("first");
    expect(await read("src/.DS_Store")).toBe("second");
  });

  it("blocks unverified installers and never offers the configured Ubuntu image", async () => {
    const { service, write } = await fixture({
      verifyInstaller: async () => false,
    });
    await write(
      ".runtime/local-execution/downloads/lima-2.2.1-Darwin-arm64.tar.gz",
    );
    await write(
      ".runtime/local-execution/downloads/node-v22.23.4-linux-arm64.tar.xz",
    );
    await write(
      ".runtime/local-execution/downloads/ubuntu-24.04-server-cloudimg-arm64.img",
    );
    const scan = await service.scan();
    expect(
      eligible(scan.items).some((item) => item.category === "install-archives"),
    ).toBe(false);
    expect(
      eligible(scan.items).some((item) => item.relativePath.endsWith(".img")),
    ).toBe(false);
  });

  it("requires the built-in archive hash instead of trusting an installer filename", async () => {
    const { service, write, read } = await fixture({
      verifyInstaller: undefined,
    });
    const archive =
      ".runtime/local-execution/downloads/lima-2.2.1-Darwin-arm64.tar.gz";
    await write(archive, "not the reviewed installation archive");
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === archive),
    ).toMatchObject({ state: "blocked", reason: "unverified" });
    expect(await read(archive)).toBe("not the reviewed installation archive");
  });

  it("deletes a verified installer copy while preserving every data, VM, draft and backup fixture", async () => {
    const { service, write, read, plan } = await fixture();
    const archive =
      ".runtime/local-execution/downloads/lima-2.2.1-Darwin-arm64.tar.gz";
    await write(archive, "verified installer fixture");
    const preserved = [
      ".runtime/local-execution/manual-data/projects/project/workspace/main.ts",
      ".runtime/local-execution/manual-data/library/files/real-image.png",
      ".runtime/local-execution/manual-data/desktop/browser/Local Storage/leveldb/draft.ldb",
      ".runtime/local-execution/manual-data/desktop/browser/Session Storage/draft.log",
      ".runtime/local-execution/lima/omg/disk",
      ".runtime/local-execution/tools/lima/bin/limactl",
      ".runtime/toolchain/node/bin/node",
      ".runtime/local-recovery/source-backup.ts",
      ".runtime/recovered-media/recovered.mp4",
      ".runtime/local-execution/downloads/ubuntu-24.04-server-cloudimg-arm64.img",
      ".env",
    ];
    for (const file of preserved) await write(file, "keep exact bytes");
    const planned = await plan([archive]);
    expect(planned.entries.map((entry) => entry.relativePath)).toEqual([
      archive,
    ]);
    await service.execute(confirmation(planned));
    for (const file of preserved)
      expect(await read(file)).toBe("keep exact bytes");
  });

  it("keeps browser caches blocked while the application is running", async () => {
    const { service, write } = await fixture();
    await write(
      ".runtime/local-execution/manual-data/desktop/browser/Cache/data_0",
      "browser cache",
    );
    await write(
      ".runtime/local-execution/manual-data/desktop/browser/GPUCache/data_0",
      "gpu cache",
    );
    await write(
      ".runtime/local-execution/manual-data/desktop/browser/Code Cache/js/code",
      "code cache",
    );
    const scan = await service.scan();
    expect(
      eligible(scan.items).some(
        (item) =>
          item.category === "browser-cache" ||
          item.relativePath.includes("/desktop/"),
      ),
    ).toBe(false);
  });

  it("does not offer candidates whose scan exceeds the configured file budget", async () => {
    const { service, write } = await fixture({ maxFiles: 2 });
    await write("node_modules/.vite/deps/one.js");
    await write("node_modules/.vite/deps/two.js");
    await write("node_modules/.vite/deps/three.js");
    const scan = await service.scan();
    expect(
      eligible(scan.items).some(
        (item) => item.relativePath === "node_modules/.vite",
      ),
    ).toBe(false);
    expect(
      scan.errors.some((error) => error.reason === "limit") ||
        scan.items.some((item) => item.reason === "limit"),
    ).toBe(true);
    expect(scan.measurementComplete).toBe(false);
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite")
        ?.measurementComplete,
    ).toBe(false);
  });

  it("keeps oversized files when the configured byte budget is exceeded", async () => {
    const { service, write, read } = await fixture({ maxBytes: 8 });
    await write(".DS_Store", "larger than the scan budget");
    const scan = await service.scan();
    expect(
      eligible(scan.items).some((item) => item.relativePath === ".DS_Store"),
    ).toBe(false);
    expect(
      scan.errors.some((error) => error.reason === "limit") ||
        scan.items.some((item) => item.reason === "limit"),
    ).toBe(true);
    expect(await read(".DS_Store")).toBe("larger than the scan budget");
  });

  it("records partial permission failures without deleting failed files or inflating the reclaimed size", async () => {
    const denied = "src/.DS_Store";
    const { service, root, write, read, plan } = await fixture({
      unlink: async (absolute) => {
        if (absolute.endsWith(`${path.sep}src${path.sep}.DS_Store`))
          throw Object.assign(new Error("Permission denied"), {
            code: "EACCES",
          });
        await fs.unlink(absolute);
      },
    });
    const removed = await write(".DS_Store", "removed");
    await write(denied, "retained");
    const stat = await fs.stat(removed);
    const planned = await plan([".DS_Store", denied]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toContainEqual(
      expect.objectContaining({ relativePath: ".DS_Store", status: "deleted" }),
    );
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        relativePath: denied,
        status: "failed",
        reason: "permission",
      }),
    );
    expect(result.deletedLogicalBytes).toBe(stat.size);
    expect(result.deletedAllocatedBytes).toBe(stat.blocks * 512);
    expect(await read(denied)).toBe("retained");
    await expect(fs.stat(path.join(root, ".DS_Store"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await service.result(planned.planId)).toEqual(result);
  });

  it("consumes a confirmation token once and keeps an immutable result for reconnects", async () => {
    const unlink = vi.fn(async (absolute: string) => fs.unlink(absolute));
    const { service, write, plan } = await fixture({ unlink });
    await write(".DS_Store");
    const planned = await plan([".DS_Store"]);
    const result = await service.execute(confirmation(planned));
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "invalid",
    });
    expect(unlink).toHaveBeenCalledOnce();
    expect(await service.result(planned.planId)).toEqual(result);
  });

  it("rejects concurrent execution while preserving a running plan's unknown outcome", async () => {
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const unlink = vi.fn(async (absolute: string) => {
      started();
      await waiting;
      await fs.unlink(absolute);
    });
    const { service, write, plan } = await fixture({ unlink });
    await write(".DS_Store");
    const planned = await plan([".DS_Store"]);
    const executing = service.execute(confirmation(planned));
    await entered;
    expect(await service.result(planned.planId)).toBeUndefined();
    await expect(service.execute(confirmation(planned))).rejects.toBeInstanceOf(
      StorageCleanupError,
    );
    release();
    await executing;
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("keeps a cache that becomes active after another confirmed item has been deleted", async () => {
    let idle = true;
    const { service, write, read, plan } = await fixture({
      cacheIdle: async () => idle,
      unlink: async (absolute) => {
        await fs.unlink(absolute);
        idle = false;
      },
    });
    await write(".DS_Store", "first item");
    await write("node_modules/.vite/deps/generated.js", "keep active cache");
    const planned = await plan([".DS_Store", "node_modules/.vite"]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toContainEqual(
      expect.objectContaining({ relativePath: ".DS_Store", status: "deleted" }),
    );
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        relativePath: "node_modules/.vite/deps/generated.js",
        status: "retained",
        reason: "running",
      }),
    );
    expect(await read("node_modules/.vite/deps/generated.js")).toBe(
      "keep active cache",
    );
  });

  it("keeps an edited leaf that changes after another confirmed leaf has been deleted", async () => {
    let second = "";
    const unlink = vi.fn(async (absolute: string) => {
      await fs.unlink(absolute);
      await fs.writeFile(
        second,
        finderBytes("new contents after confirmation"),
      );
    });
    const { service, write, read, plan } = await fixture({ unlink });
    await write(".DS_Store", "first item");
    second = await write("src/.DS_Store", "second item");
    const planned = await plan([".DS_Store", "src/.DS_Store"]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toContainEqual(
      expect.objectContaining({ relativePath: ".DS_Store", status: "deleted" }),
    );
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        relativePath: "src/.DS_Store",
        status: "retained",
        reason: "changed",
      }),
    );
    expect(await read("src/.DS_Store")).toBe("new contents after confirmation");
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("retains an installer whose installed-copy verification changes during execution", async () => {
    let verified = true;
    const unlink = vi.fn(async (absolute: string) => {
      await fs.unlink(absolute);
      verified = false;
    });
    const { service, write, read, plan } = await fixture({
      verifyInstaller: async () => verified,
      unlink,
    });
    const archive =
      ".runtime/local-execution/downloads/lima-2.2.1-Darwin-arm64.tar.gz";
    const metadata = await write(".DS_Store", "first item");
    await write(archive, "installer copy that must remain");
    const stat = await fs.stat(metadata);
    const planned = await plan([".DS_Store", archive]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toContainEqual(
      expect.objectContaining({ relativePath: ".DS_Store", status: "deleted" }),
    );
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        relativePath: archive,
        status: "retained",
        reason: "unverified",
      }),
    );
    expect(result.deletedLogicalBytes).toBe(stat.size);
    expect(await read(archive)).toBe("installer copy that must remain");
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("does not report a file as retained when the deletion attempt has an unknown outcome", async () => {
    const unlink = vi.fn(async (absolute: string) => {
      await fs.unlink(absolute);
      throw new Error("The operation result was lost");
    });
    const { root, service, write, plan } = await fixture({ unlink });
    await write(".DS_Store", "temporary metadata");
    const planned = await plan([".DS_Store"]);
    const result = await service.execute(confirmation(planned));
    expect(result.entries).toEqual([
      expect.objectContaining({
        relativePath: ".DS_Store",
        status: "failed",
        reason: "unknown",
      }),
    ]);
    expect(result.deletedLogicalBytes).toBe(0);
    expect(result.deletedAllocatedBytes).toBe(0);
    await expect(fs.stat(path.join(root, ".DS_Store"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(service.execute(confirmation(planned))).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await service.result(planned.planId)).toEqual(result);
    expect(unlink).toHaveBeenCalledOnce();
  });
});
