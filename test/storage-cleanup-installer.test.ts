import * as fs from "node:fs/promises";
import { createHash, type BinaryToTextEncoding } from "node:crypto";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageCleanupService } from "../src/desktop/storage-cleanup.js";

const approvedDigests = vi.hoisted(() => new Map<string, string>());
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (
      algorithm: string,
      options?: import("node:crypto").HashOptions,
    ) => {
      const hash = actual.createHash(algorithm, options);
      const digest = hash.digest.bind(hash);
      Object.defineProperty(hash, "digest", {
        value: (encoding?: BinaryToTextEncoding) => {
          const value = encoding ? digest(encoding) : digest();
          return algorithm === "sha256" &&
            encoding === "hex" &&
            typeof value === "string"
            ? (approvedDigests.get(value) ?? value)
            : value;
        },
      });
      return hash;
    },
  };
});

type CommandCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;
const execFile = vi.hoisted(() =>
  vi.fn<
    (
      binary: string,
      args: string[],
      options: ExecFileOptions,
      callback: CommandCallback,
    ) => ChildProcess
  >(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile,
}));

const ARCHIVE =
  ".runtime/local-execution/downloads/lima-2.2.1-Darwin-arm64.tar.gz";
const INSTALLED = ".runtime/local-execution/tools/lima";
const MANIFEST = ".runtime/local-execution/evidence/lima-archive-members.json";
const EXPECTED = {
  archive: "9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e",
  cli: "6d32fb0f880c0ea750434f2ac855a3f2129126752a301ce4d88adbd2fa599e1e",
  manifest: "35ccbb7469920212b7fa0cf2e477fb2fc54e5bdca3739f56618aa066f9783b95",
};
interface ArchiveRecord {
  path: string;
  bytes: number;
  mode: string;
  link: string | null;
}
const directories: string[] = [];

beforeEach(() => {
  approvedDigests.clear();
  execFile.mockReset().mockImplementation((binary) => {
    throw new Error(`Unexpected real-command request in fixture: ${binary}`);
  });
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function approveFixtureBytes(contents: Buffer | string, approved: string) {
  approvedDigests.set(
    createHash("sha256").update(contents).digest("hex"),
    approved,
  );
}

async function fixture(
  kind: "normal" | "declared escape" | "undeclared target" = "normal",
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ohmygame-cleanup-installer-")),
  );
  directories.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const records: ArchiveRecord[] = [];
  const fileContents = new Map<string, Buffer>();
  const directory = (file: string) =>
    records.push({ path: file, bytes: 0, mode: "0o755", link: null });
  const regular = (file: string, contents: Buffer) => {
    records.push({
      path: file,
      bytes: contents.length,
      mode: "0o644",
      link: null,
    });
    fileContents.set(file, contents);
  };
  directory(".");
  directory("./bin");
  const cli = Buffer.from("reviewed fixture Lima executable bytes\n");
  regular("./bin/limactl", cli);
  directory("./share");
  directory("./share/doc");
  directory("./share/doc/lima");
  directory("./share/lima");
  directory("./share/lima/templates");
  regular(
    "./share/lima/templates/fixture.yaml",
    Buffer.from("images: fixture-only\n"),
  );
  const link = path.join(root, INSTALLED, "share/doc/lima/templates");
  const outside = path.join(root, "outside-installed-fixture");
  await fs.mkdir(outside);
  let linkTarget = "../../lima/templates";
  if (kind === "declared escape")
    linkTarget = path.relative(path.dirname(link), outside);
  else if (kind === "undeclared target") {
    linkTarget = "../../lima/unregistered-templates";
    await fs.mkdir(
      path.join(root, INSTALLED, "share/lima/unregistered-templates"),
      { recursive: true },
    );
  }
  records.push({
    path: "./share/doc/lima/templates",
    bytes: 0,
    mode: "0o777",
    link: linkTarget,
  });
  for (let index = 0; index < 190; index++)
    regular(
      `./share/lima/public-${String(index).padStart(3, "0")}.txt`,
      Buffer.from(`public fixture record ${String(index).padStart(3, "0")}\n`),
    );
  expect(records).toHaveLength(200);
  for (const record of records) {
    const absolute = path.join(root, INSTALLED, record.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (record.link !== null) await fs.symlink(record.link, absolute);
    else if (fileContents.has(record.path))
      await fs.writeFile(absolute, fileContents.get(record.path)!);
    else await fs.mkdir(absolute, { recursive: true });
  }
  const archive = Buffer.from(
    "reviewed fixture archive bytes, never executed\n",
  );
  await fs.mkdir(path.join(root, path.dirname(ARCHIVE)), { recursive: true });
  await fs.writeFile(path.join(root, ARCHIVE), archive);
  const manifest = JSON.stringify(records);
  await fs.mkdir(path.join(root, path.dirname(MANIFEST)), { recursive: true });
  await fs.writeFile(path.join(root, MANIFEST), manifest);
  approveFixtureBytes(archive, EXPECTED.archive);
  approveFixtureBytes(cli, EXPECTED.cli);
  approveFixtureBytes(manifest, EXPECTED.manifest);
  const listing =
    records
      .map((record) =>
        record.link === null &&
        !fileContents.has(record.path) &&
        record.path !== "."
          ? `${record.path}/`
          : record.path,
      )
      .join("\n") + "\n";
  const expanded = Buffer.concat(
    records.flatMap((record) =>
      fileContents.has(record.path) ? [fileContents.get(record.path)!] : [],
    ),
  );
  execFile.mockImplementation((binary, args, _options, callback) => {
    if (
      binary !== "/usr/bin/tar" ||
      args[1] !== path.join(root, ARCHIVE) ||
      !["-tf", "-xOf"].includes(args[0]!)
    )
      throw new Error(
        `Unexpected command in installer fixture: ${binary} ${args.join(" ")}`,
      );
    queueMicrotask(() =>
      args[0] === "-tf"
        ? callback(null, listing, "")
        : callback(null, expanded, Buffer.alloc(0)),
    );
    return {} as ChildProcess;
  });
  const unlink = vi.fn(async () => {
    throw new Error("No deletion is authorized by this scan-only fixture");
  });
  const service = new StorageCleanupService({
    root,
    supported: true,
    trackedPaths: async () => new Set(),
    isInUse: async () => false,
    cacheIdle: async () => true,
    unlink,
  });
  const scanArchive = async () => {
    const scan = await service.scan();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, ARCHIVE))).toEqual(archive);
    return scan.items.find((item) => item.relativePath === ARCHIVE)!;
  };
  return { root, records, fileContents, link, outside, service, scanArchive };
}

describe("storage cleanup's default installed-archive verification", () => {
  it("accepts an exact trusted in-tree symlink and verifies every installed regular file", async () => {
    const { scanArchive } = await fixture();
    expect(await scanArchive()).toMatchObject({
      state: "eligible",
      category: "install-archives",
    });
    expect(execFile.mock.calls.map(([, args]) => args[0])).toEqual([
      "-tf",
      "-xOf",
    ]);
    expect(
      execFile.mock.calls.every(
        ([binary, _args, options]) =>
          binary === "/usr/bin/tar" && options.shell !== true,
      ),
    ).toBe(true);
  });

  it("retains an installer when a declared symlink's readlink text no longer matches", async () => {
    const { root, link, scanArchive } = await fixture();
    await fs.unlink(link);
    await fs.mkdir(path.join(root, INSTALLED, "share/lima/other-templates"));
    await fs.symlink("../../lima/other-templates", link);
    expect((await scanArchive()).state).toBe("blocked");
  });

  it("does not accept a declared target that escapes the installed runtime root", async () => {
    const { outside, scanArchive } = await fixture("declared escape");
    await fs.writeFile(
      path.join(outside, "keep.txt"),
      "outside runtime stays intact",
    );
    expect((await scanArchive()).state).toBe("blocked");
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe(
      "outside runtime stays intact",
    );
  });

  it("retains an installer when the declared target directory is replaced by an external link", async () => {
    const { root, outside, scanArchive } = await fixture();
    const target = path.join(root, INSTALLED, "share/lima/templates");
    await fs.rename(target, `${target}.saved-fixture`);
    await fs.symlink(outside, target, "dir");
    expect((await scanArchive()).state).toBe("blocked");
  });

  it("rejects an internal link target absent from the trusted regular-file/directory manifest", async () => {
    const { scanArchive } = await fixture("undeclared target");
    expect((await scanArchive()).state).toBe("blocked");
  });

  it("rejects a symlink substituted for a declared regular installed file", async () => {
    const { root, scanArchive } = await fixture();
    const target = path.join(root, INSTALLED, "share/lima/public-000.txt");
    await fs.rename(target, `${target}.saved-fixture`);
    await fs.symlink("public-001.txt", target);
    expect((await scanArchive()).state).toBe("blocked");
  });

  it("retains the archive when an installed file changes contents while keeping its original size", async () => {
    const { root, fileContents, scanArchive } = await fixture();
    const relative = "./share/lima/public-000.txt";
    const original = fileContents.get(relative)!;
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    expect(changed.length).toBe(original.length);
    await fs.writeFile(path.join(root, INSTALLED, relative), changed);
    expect((await scanArchive()).state).toBe("blocked");
    expect(execFile.mock.calls.some(([, args]) => args[0] === "-xOf")).toBe(
      true,
    );
  });
});
