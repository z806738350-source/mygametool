import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareInkRuntime } from "../src/daemon/ink-runtime.js";
import { PROJECT_SOURCE_LIMITS } from "../src/daemon/isolated-project-files.js";

const OLD_COMMIT = "f4b5644a26f4a0d2a707b1c74dc58ea4f5ba692c";
const NEW_COMMIT = "549ac7e625281b3e1a03ecf5277a27f9426f1f15";
const OLD_BUILD = "f4b5644a-bake-r1";
const NEW_BUILD = "549ac7e6-bake-r1";
const TOOLKIT = "ink-toolkit.min.mjs";
const RENDERER = "ink-renderer.min.mjs";
const MANIFEST = "runtime-manifest.json";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function writeBundle(directory: string, upstreamCommit = OLD_COMMIT) {
  const files = {
    [TOOLKIT]: Buffer.from(`export const commit = ${JSON.stringify(upstreamCommit)};\n`),
    [RENDERER]: Buffer.from("export function createRenderer() {}\n"),
    "LICENSE.txt": Buffer.from("MIT\n"),
    "NOTICE.md": Buffer.from("Ink Studio test fixture\n"),
  };
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes);
  await writeFile(path.join(directory, MANIFEST), JSON.stringify({
    upstreamCommit, profile: "bake", distributionRevision: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, {
      size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    }])),
  }));
}

async function fixture(startupDirectory = ".") {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-ink-runtime-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  const bundledDirectory = path.join(root, "bundle");
  await mkdir(path.join(workspace, startupDirectory), { recursive: true });
  await writeBundle(bundledDirectory);
  return { root, install: { workspace, startupDirectory, bundledDirectory } };
}

describe("Ink Studio runtime installation", () => {
  it("publishes matching modules, license and manifest under the selected game directory and reuses the same files", async () => {
    const { install } = await fixture("client/game");
    const parent = path.join(install.workspace, "client/game/vendor/ink-studio");
    const result = await prepareInkRuntime({
      ...install,
      publish: async (commit) => {
        await expect(lstat(path.join(parent, OLD_BUILD))).rejects.toMatchObject({ code: "ENOENT" });
        await commit();
      },
    });
    const directory = `client/game/vendor/ink-studio/${OLD_BUILD}`;
    expect(result).toEqual({
      status: "created", directory, toolkitPath: `${directory}/${TOOLKIT}`, rendererPath: `${directory}/${RENDERER}`,
      manifestPath: `${directory}/${MANIFEST}`, upstreamCommit: OLD_COMMIT,
    });
    const location = path.join(install.workspace, result.directory);
    for (const name of [TOOLKIT, RENDERER, "LICENSE.txt", "NOTICE.md", MANIFEST]) {
      expect(await readFile(path.join(location, name))).toEqual(await readFile(path.join(install.bundledDirectory, name)));
    }
    const before = await lstat(path.join(location, TOOLKIT));
    expect(await prepareInkRuntime(install)).toEqual({ ...result, status: "reused" });
    expect((await lstat(path.join(location, TOOLKIT))).ino).toBe(before.ino);
    expect(await readdir(parent)).toEqual([OLD_BUILD]);
  });

  it("retains a valid previous runtime when the app changes its bundled build and rejects an ambiguous project", async () => {
    const { install } = await fixture();
    const initial = await prepareInkRuntime(install);
    await writeBundle(install.bundledDirectory, NEW_COMMIT);
    expect(await prepareInkRuntime(install)).toEqual({ ...initial, status: "reused" });
    const parent = path.join(install.workspace, "vendor/ink-studio");
    expect(await readdir(parent)).toEqual([OLD_BUILD]);
    await writeBundle(path.join(parent, NEW_BUILD), NEW_COMMIT);
    await expect(prepareInkRuntime(install)).rejects.toThrow("Several Ink Studio runtime versions");
    expect((await readdir(parent)).sort()).toEqual([NEW_BUILD, OLD_BUILD]);
  });

  it("reuses the winner if two publications stage the same version concurrently", async () => {
    const { install } = await fixture();
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const publish = async (commit: () => Promise<void>) => {
      if (++arrived === 2) release();
      await gate;
      await commit();
    };
    const results = await Promise.all([prepareInkRuntime({ ...install, publish }), prepareInkRuntime({ ...install, publish })]);
    expect(results.map(result => result.status).sort()).toEqual(["created", "reused"]);
    expect(await readdir(path.join(install.workspace, "vendor/ink-studio"))).toEqual([OLD_BUILD]);
  });

  it("rejects a modified original and a corrupt bundle without replacing existing files", async () => {
    const { install } = await fixture();
    const result = await prepareInkRuntime(install);
    const target = path.join(install.workspace, result.toolkitPath);
    const changed = (await readFile(target, "utf8")).replace("export", "return");
    await writeFile(target, changed);
    await expect(prepareInkRuntime(install)).rejects.toThrow("does not match its manifest");
    expect(await readFile(target, "utf8")).toBe(changed);

    const fresh = await fixture();
    await writeFile(path.join(fresh.install.bundledDirectory, TOOLKIT), changed);
    await expect(prepareInkRuntime(fresh.install)).rejects.toThrow("does not match its manifest");
    expect(await readdir(fresh.install.workspace)).toEqual([]);
  });

  it("rejects a different distribution claiming the app's build identifier", async () => {
    const { install } = await fixture();
    const first = await prepareInkRuntime(install);
    const location = path.join(install.workspace, first.directory);
    const differentCommit = OLD_COMMIT.slice(0, -1) + "f";
    await writeBundle(location, differentCommit);
    await expect(prepareInkRuntime(install)).rejects.toThrow("conflicts with this build");
    expect(await readFile(path.join(location, TOOLKIT), "utf8")).toContain(differentCommit);
  });

  it("keeps staged files from becoming visible when publication is denied or cancelled", async () => {
    const { install } = await fixture();
    const parent = path.join(install.workspace, "vendor/ink-studio");
    await expect(prepareInkRuntime({
      ...install,
      publish: async () => { throw new Error("Ink Studio was disabled"); },
    })).rejects.toThrow("disabled");
    expect(await readdir(parent)).toEqual([]);

    const controller = new AbortController();
    await expect(prepareInkRuntime({
      ...install, signal: controller.signal,
      publish: async (commit) => {
        controller.abort(new Error("Installation cancelled"));
        await commit();
      },
    })).rejects.toThrow("cancelled");
    expect(await readdir(parent)).toEqual([]);
    expect((await prepareInkRuntime(install)).status).toBe("created");
  });

  it("rejects path escape and linked destinations", async () => {
    const { root, install } = await fixture();
    await expect(prepareInkRuntime({ ...install, startupDirectory: "../bundle" })).rejects.toThrow("parent paths");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(install.workspace, "vendor"), "junction");
    await expect(prepareInkRuntime(install)).rejects.toThrow("Symbolic links");
    expect(await readdir(outside)).toEqual([]);
    const linkedPackage = path.join(root, "linked-package");
    await symlink(install.bundledDirectory, linkedPackage, "junction");
    await rm(path.join(install.workspace, "vendor"));
    await expect(prepareInkRuntime({ ...install, bundledDirectory: linkedPackage })).rejects.toThrow("Invalid bundled Ink Studio runtime directory");
  });

  it("accounts for the runtime bytes in the projected total workspace budget before writing", async () => {
    const { install } = await fixture();
    const fileBytes = PROJECT_SOURCE_LIMITS.fileBytes;
    const chunk = Buffer.alloc(fileBytes);
    for (let index = 0; index < PROJECT_SOURCE_LIMITS.totalBytes / fileBytes; index++) {
      await writeFile(path.join(install.workspace, `source-${index}.txt`), chunk);
    }
    await expect(prepareInkRuntime(install)).rejects.toThrow("exceeds the isolated project budget");
    await expect(lstat(path.join(install.workspace, "vendor"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
