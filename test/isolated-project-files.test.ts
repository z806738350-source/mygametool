import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  open,
  readFile,
  readdir,
  mkdir,
  rm,
  symlink,
  realpath,
  rename,
  link,
  truncate,
  chmod,
  stat,
} from "node:fs/promises";
import { Writable } from "node:stream";
import { CheckedMediaSnapshotStore } from "../src/daemon/checked-media-snapshot.js";
import { inspectSafeProjectMedia } from "../src/daemon/safe-project-file.js";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  lockedPackages,
  copyRuntimeMedia,
  inspectRuntimeMedia,
  withCheckedFileStream,
  closeRuntimeMediaSnapshots,
  PROJECT_SOURCE_LIMITS,
  sourceManifestEntries,
  inspectProjectSourceBudget,
  projectFiles,
  readRuntimeMedia,
  type RuntimeMedia,
  publicPackages,
  restoreArtifacts,
  mediaHeaderMatches,
  runtimeMediaPath,
  transferPath,
} from "../src/daemon/isolated-project-files.js";
import { applySourceChanges } from "../src/daemon/isolated-source-changes.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import mediaCases from "./fixtures/isolated-media.json" with { type: "json" };
import { isIsolatedInputBudgetError, isolatedInputBudgetError } from "../src/daemon/isolated-tool-receipts.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeRuntimeMediaSnapshots();
  await Promise.all(
    directories
      .splice(0)
      .map((file) => rm(file, { recursive: true, force: true })),
  );
});
const archive = Buffer.from("small public package fixture");
const integrity =
  "sha512-" + createHash("sha512").update(archive).digest("base64");
const manifest = {
  name: "fixture",
  version: "1.0.0",
  dependencies: { "is-number": "7.0.0" },
};
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/is-number": {
      version: "7.0.0",
      resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      integrity,
    },
  },
});
async function fixture() {
  const workspace = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-public-package-")),
  );
  directories.push(workspace);
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(workspace, "package-lock.json"),
    JSON.stringify(lock()),
  );
  return { workspace, cache: path.join(workspace, ".cache") };
}

it.each(mediaCases)("classifies $extension consistently at imported and renamed runtime paths", async ({ extension, header }) => {
  const { workspace } = await fixture();
  const bytes = Buffer.alloc(64);
  Buffer.from(header, "hex").copy(bytes);
  const name = `assets/files/Folder/KEY${extension.toUpperCase()}`;
  expect(runtimeMediaPath(name)).toBe(true);
  expect(runtimeMediaPath(`assets/files/Folder/renamed${extension}`)).toBe(true);
  expect(runtimeMediaPath(`arbitrary/clip${extension}`)).toBe(false);
  expect(() => transferPath(name)).not.toThrow();
  expect(() => transferPath(`public/credentials.json${extension}`)).toThrow();
  await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
  await writeFile(path.join(workspace, name), bytes);
  const media: RuntimeMedia[] = [];
  await projectFiles(workspace, media);
  expect(media).toEqual([{ path: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]);
  expect(await readRuntimeMedia(workspace, media[0]!)).toEqual(bytes);
  expect(mediaHeaderMatches(name, bytes)).toBe(true);
  await writeFile(path.join(workspace, name), Buffer.alloc(64, 0x41));
  await expect(projectFiles(workspace, [])).rejects.toThrow(/extension|incomplete/);
});

it("rejects high-bit signature aliases and partial/mismatched media before preparation", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  for (const [extension, header] of [[".gif", "474946383961"], [".webp", "524946460000000057454250"], [".mp3", "494433"], [".mp4", "000000186674797069736f6d"], [".wav", "524946460000000057415645"]]) {
    const bytes = Buffer.alloc(64); Buffer.from(header!, "hex").copy(bytes);
    const signature = extension === ".mp4" ? 4 : 0;
    bytes[signature]! |= 0x80;
    expect(mediaHeaderMatches("public/test" + extension, bytes)).toBe(false);
  }
  for (const bytes of [Buffer.from("not a movie"), Buffer.from("....ftyp")]) {
    await writeFile(path.join(workspace, "public/incomplete.mp4"), bytes);
    const media: RuntimeMedia[] = [];
    await expect(projectFiles(workspace, media)).rejects.toThrow("does not match its extension or is incomplete");
    expect(media).toEqual([]);
    expect(await readFile(path.join(workspace, "public/incomplete.mp4"))).toEqual(bytes);
  }
});

it("rejects malformed Unicode and counts path limits in the same UTF-16 units as the guest", () => {
  expect(() => transferPath("public/角色-😀.png")).not.toThrow();
  expect(() => transferPath("public/\ud800.png")).toThrow();
  expect(() => transferPath("public/" + "😀".repeat(500) + ".png")).toThrow();
});

it("uses a separate bounded channel for runtime media, restores matching builds and rejects changed snapshots", async () => {
  const { workspace } = await fixture();
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  bytes.writeUInt32BE(24);
  bytes.write("ftypisom", 4);
  const folder = path.join(workspace, "client/public/video");
  await mkdir(folder, { recursive: true });
  const video = path.join(folder, "intro.mp4");
  await writeFile(video, bytes);
  await writeFile(path.join(folder, "module.js"), "export default 7");
  const media: RuntimeMedia[] = [];
  const source = await projectFiles(workspace, media);
  expect(source.map(file => file.path)).toEqual(expect.arrayContaining(["client/public/video/module.js"]));
  expect(source.some(file => file.path.endsWith("intro.mp4"))).toBe(false);
  expect(media).toEqual([{ path: "client/public/video/intro.mp4", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]);
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.mediaBytes).toBeGreaterThanOrEqual(bytes.length);
  expect(await readRuntimeMedia(workspace, media[0]!)).toEqual(bytes);
  const output = { ...media[0]!, path: "dist/intro.mp4" };
  await restoreArtifacts(workspace, [], [output], () => readRuntimeMedia(workspace, media[0]!));
  expect(await readFile(path.join(workspace, output.path))).toEqual(bytes);
  await expect(restoreArtifacts(workspace, [], [output], async () => Buffer.alloc(0))).rejects.toThrow("match");
  expect(await readFile(path.join(workspace, output.path))).toEqual(bytes);
  bytes[100] = 77;
  await writeFile(video, bytes);
  await expect(readRuntimeMedia(workspace, media[0]!)).rejects.toThrow("changed");
  await expect(applySourceChanges(workspace, source, source, undefined, media)).rejects.toThrow("conflict");
});

it("checks media limits and secrets before exposing an upload manifest", async () => {
  const { workspace } = await fixture();
  const target = path.join(workspace, "public/big.mp4");
  await mkdir(path.dirname(target));
  await writeFile(target, "");
  await truncate(target, 32 * 1024 * 1024 + 1);
  await expect(projectFiles(workspace, [])).rejects.toThrow("32 MiB");
  const secret = "isolated-runtime-media-credential-canary";
  registerSensitiveValue(secret);
  await writeFile(target, Buffer.concat([Buffer.from("....ftypisom"), Buffer.alloc(65536 - 24), Buffer.from(secret)]));
  const media: RuntimeMedia[] = [];
  await expect(projectFiles(workspace, media)).rejects.toThrow("credential");
  expect(media).toEqual([]);
});

it("admits exact media metadata bounds and reports one-byte excess without changing files", async () => {
  const { workspace } = await fixture();
  const fileLimit = 32 * 1024 * 1024;
  const files = [{ path: "assets/files/a.wav", size: fileLimit }, { path: "public/b.wav", size: fileLimit }];
  const exact = await inspectProjectSourceBudget(workspace, files);
  expect(exact.mediaBytes).toBe(64 * 1024 * 1024);
  expect(exact.largestLargeMedia).toEqual({ path: "assets/files/a.wav", size: fileLimit });
  expect(exact.largestBaseMedia).toBeUndefined();
  expect(exact.limits).toEqual(PROJECT_SOURCE_LIMITS);
  expect(exact.limits).toMatchObject({ mediaFileBytes: fileLimit, mediaBytes: 64 * 1024 * 1024, entries: 4000, fileCount: 2000 });
  expect(exact.scope).toEqual({ kind: "eligible-workspace-metadata", separateMedia: true, canvasCandidates: "excluded-unverified", unverifiedCanvasCandidateCount: 0, mediaClassMaximaVersion: 1 });
  expect(exact.overage.mediaBytes).toBeUndefined();
  expect(exact.overage.mediaFileBytes).toBeUndefined();
  const fileOver = await inspectProjectSourceBudget(workspace, [{ path: "assets/files/a.wav", size: fileLimit + 1 }]);
  expect(fileOver.overage.mediaFileBytes).toBe(1);
  const totalOver = await inspectProjectSourceBudget(workspace, [...files, { path: "src/c.wav", size: 1 }]);
  expect(totalOver.overage.mediaBytes).toBe(1);
  expect(totalOver.overage.mediaFileBytes).toBeUndefined();
  expect(await readdir(workspace)).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
});

it("builds typed metadata from real verified seeds, counts equal media by path and preserves host mode", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public")); await mkdir(path.join(workspace, "src"));
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24)]);
  await writeFile(path.join(workspace, "public/a.png"), png); await writeFile(path.join(workspace, "src/b.png"), png);
  const source = Buffer.from("const title = '森林';\n", "utf8");
  await writeFile(path.join(workspace, "src/game.js"), source); await chmod(path.join(workspace, "src/game.js"), 0o640);
  await writeFile(path.join(workspace, "src/empty.txt"), "");
  const media: RuntimeMedia[] = [], ordinary = await projectFiles(workspace, media);
  const result = sourceManifestEntries([...ordinary, ...media]);
  expect(result.files).toContainEqual({ path: "src/game.js", kind: "source", size: source.length, sha256: createHash("sha256").update(source).digest("hex"), executable: false });
  expect(result.files).toContainEqual({ path: "src/empty.txt", kind: "source", size: 0, sha256: createHash("sha256").update("").digest("hex"), executable: false });
  const images = result.files.filter(entry => entry.kind === "media");
  expect(images).toHaveLength(2); expect(images[0]!.sha256).toBe(images[1]!.sha256);
  expect(result.binaryDeclaredBytes).toBe(png.length * 2);
  expect(result.ordinaryInlineBytes).toBe(ordinary.reduce((sum, file) => sum + Buffer.from(file.data, "base64").length, 0));
  expect((await stat(path.join(workspace, "src/game.js"))).mode & 0o777).toBe(0o640);
});

it("rejects malformed or tampered metadata without treating declared media hashes as authority", () => {
  const bytes = Buffer.from("payload"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = { path: "src/file.js", data: bytes.toString("base64"), sha256, executable: false, mode: 0o640 };
  const media = { path: "public/frame.png", size: 10, sha256: "a".repeat(64) };
  expect(sourceManifestEntries([media]).files).toEqual([{ ...media, kind: "media", executable: false }]);
  for (const value of [
    { ...source, data: "cGF5bG9hZA==\n" },
    { ...source, data: "AB==", sha256: createHash("sha256").update(Buffer.from([0])).digest("hex") },
    { ...source, sha256: "f".repeat(64) },
    { ...source, size: bytes.length },
    { ...source, kind: "source" },
    { ...source, mode: 0o755 },
    { ...source, mode: 0o1000 },
    { ...source, executable: "false" },
    { ...media, executable: false },
    { ...media, kind: "media" },
    { ...media, size: 0 },
    { ...media, size: 32 * 1024 * 1024 + 1 },
    { ...media, path: "private/frame.png" },
    { ...media, path: "dist/frame.png" },
  ]) expect(() => sourceManifestEntries([value] as never)).toThrow();
  expect(() => sourceManifestEntries([source, { ...source }] )).toThrow("duplicate");
  expect(() => sourceManifestEntries([source, { ...source, path: "src/file.js/child" }])).toThrow("file parent");
  const secret = "source-manifest-secret-fixture-91024"; registerSensitiveValue(secret);
  const privateBytes = Buffer.from(secret);
  expect(() => sourceManifestEntries([{ path: "src/ordinary.txt", data: privateBytes.toString("base64"), sha256: createHash("sha256").update(privateBytes).digest("hex") }])).toThrow("credential");
});

it("enforces unchanged source and media limits on typed entries without deduplicating equal hashes", () => {
  const sourceBytes = Buffer.alloc(2 * 1024 * 1024), data = sourceBytes.toString("base64"), hash = createHash("sha256").update(sourceBytes).digest("hex");
  const source = (index: number) => ({ path: `src/${index}.js`, data, sha256: hash });
  expect(sourceManifestEntries([0, 1, 2, 3].map(source)).ordinaryInlineBytes).toBe(8 * 1024 * 1024);
  expect(() => sourceManifestEntries([0, 1, 2, 3, 4].map(source))).toThrow("budget");
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1);
  expect(() => sourceManifestEntries([{ path: "src/big.js", data: tooLarge.toString("base64"), sha256: createHash("sha256").update(tooLarge).digest("hex") }])).toThrow();
  const media = (index: number, size = 32 * 1024 * 1024) => ({ path: `public/${index}.png`, size, sha256: "a".repeat(64) });
  expect(sourceManifestEntries([media(0), media(1)]).binaryDeclaredBytes).toBe(64 * 1024 * 1024);
  expect(() => sourceManifestEntries([media(0), media(1), media(2, 1)])).toThrow("budget");
  expect(() => sourceManifestEntries(Array.from({ length: 2001 }, (_, i) => ({ path: `src/${i}.txt`, data: "", sha256: createHash("sha256").update("").digest("hex") })))).toThrow("count");
});

it("retains all paths for many small identical sources and counts decoded UTF-8 bytes", () => {
  expect(sourceManifestEntries([])).toEqual({ files: [], ordinaryInlineBytes: 0, binaryDeclaredBytes: 0 });
  const bytes = Buffer.from("帧", "utf8"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const inputs = Array.from({ length: 1000 }, (_, i) => ({ path: `src/frame-${i}.txt`, data: bytes.toString("base64"), sha256 }));
  const result = sourceManifestEntries(inputs);
  expect(result.files).toHaveLength(1000); expect(result.ordinaryInlineBytes).toBe(3000);
  expect(new Set(result.files.map(file => file.path)).size).toBe(1000);
  expect(result.files.every(file => file.kind === "source" && file.size === 3 && file.sha256 === sha256)).toBe(true);
});

it("counts equal media bytes at distinct paths across the complete eligible workspace", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public")); await mkdir(path.join(workspace, "src"));
  const bytes = Buffer.from("identical media bytes");
  await writeFile(path.join(workspace, "public/a.png"), bytes);
  await writeFile(path.join(workspace, "src/b.png"), bytes);
  await mkdir(path.join(workspace, "dist")); await writeFile(path.join(workspace, "dist/ignored.png"), bytes);
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.complete).toBe(true); expect(budget.mediaBytes).toBe(bytes.length * 2);
  expect(budget.fileCount).toBe(4);
  const inline = await inspectProjectSourceBudget(workspace, [], false);
  expect(inline.scope.separateMedia).toBe(false); expect(inline.mediaBytes).toBe(0);
  expect(inline.totalBytes).toBe(budget.totalBytes + bytes.length * 2);
});

it("reports incomplete media totals and overages as lower bounds, not per-batch capacity", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  for (let index = 0; index < 4001; index++) {
    const file = path.join(workspace, `public/frame-${index}.png`);
    await writeFile(file, ""); await truncate(file, 20 * 1024);
  }
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.complete).toBe(false); expect(budget.entryCount).toBe(4001);
  expect(budget.overage.mediaBytes).toBeGreaterThan(0);
  const error = await projectFiles(workspace, []).catch(cause => cause);
  expect(isIsolatedInputBudgetError(error)).toBe(true);
  expect(error.message).toContain(`Eligible media: at least ${budget.mediaBytes} bytes`);
  expect(error.message).toContain(`total overage at least ${budget.overage.mediaBytes} bytes`);
  expect(error.message).toContain("entire eligible workspace media set, not a per-batch allowance");
  expect(error.message).toContain("totals and overages are lower bounds");
  expect(error.message).toContain("Preserve originals");
  expect(error.message).toContain("capacity diagnostic");
}, 30_000);

it("aborts budget inspection before reads or while walking without returning a partial result", async () => {
  const { workspace } = await fixture();
  const controller = new AbortController(); controller.abort();
  const lstat = vi.spyOn(fs, "lstat");
  try {
    await expect(inspectProjectSourceBudget(workspace, [], true, controller.signal)).rejects.toThrow();
    expect(lstat).not.toHaveBeenCalled();
  } finally { lstat.mockRestore(); }
  await mkdir(path.join(workspace, "public"));
  const target = path.join(workspace, "public/frame.png"); await writeFile(target, "fixture");
  const during = new AbortController(), original = fs.lstat;
  const walking = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const result = await original(...args);
    if (String(args[0]) === target) during.abort();
    return result;
  }) as typeof fs.lstat);
  try {
    await expect(inspectProjectSourceBudget(workspace, [], true, during.signal)).rejects.toThrow();
    expect(during.signal.aborted).toBe(true);
  } finally { walking.mockRestore(); }
});

it("omits only registered, correctly typed Canvas candidates and inspects their links", async () => {
  const { workspace } = await fixture();
  const folder = path.join(workspace, "assets/canvas");
  await mkdir(folder, { recursive: true });
  await mkdir(path.join(workspace, "canvas"));
  const assets = Object.fromEntries(["draft.mp4", "code.png"].map(name => [
    name.split(".")[0], { name, path: "assets/canvas/" + name, canvasOnly: true },
  ]));
  await writeFile(path.join(workspace, "canvas/assets.json"), JSON.stringify({ version: 1, assets }));
  const video = path.join(folder, "draft.mp4");
  await writeFile(video, Buffer.from("....ftypisom"));
  await truncate(video, 4 * 1024 * 1024);
  await writeFile(path.join(folder, "code.png"), "export default 17");
  await writeFile(path.join(folder, "unregistered.wav"), "RIFF....WAVE");
  const files = await projectFiles(workspace, []);
  expect(files.map(file => file.path)).toEqual(expect.arrayContaining(["assets/canvas/code.png", "assets/canvas/unregistered.wav"]));
  expect(files.some(file => file.path.endsWith("draft.mp4"))).toBe(false);
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.scope).toEqual({ kind: "eligible-workspace-metadata", separateMedia: true, canvasCandidates: "excluded-unverified", unverifiedCanvasCandidateCount: 2, mediaClassMaximaVersion: 1 });
  await link(video, path.join(workspace, "aliased.mp4"));
  await expect(projectFiles(workspace, [])).rejects.toThrow("unlinked");
});

it("accepts only exact public locked tarballs without install lifecycle scripts", () => {
  expect(lockedPackages(manifest, lock())).toHaveLength(1);
  for (const resolved of [
    "https://evil.invalid/a.tgz",
    "git+https://registry.npmjs.org/a",
    "https://user:pass@registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
    "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz?auth=value",
  ]) {
    const value = lock();
    value.packages["node_modules/is-number"].resolved = resolved;
    expect(() => lockedPackages(manifest, value)).toThrow();
  }
  expect(() =>
    lockedPackages(
      { ...manifest, dependencies: { "is-number": "^7.0.0" } },
      lock(),
    ),
  ).toThrow("exact");
  expect(() =>
    lockedPackages(
      { ...manifest, scripts: { postinstall: "node unsafe.js" } },
      lock(),
    ),
  ).toThrow("lifecycle");
  expect(() =>
    lockedPackages(manifest, { ...lock(), lockfileVersion: 2 }),
  ).toThrow();
});

it("downloads without credentials or redirects and rechecks cached integrity", async () => {
  const { workspace, cache } = await fixture();
  const fetcher = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(archive),
  );
  const result = await publicPackages(
    workspace,
    cache,
    fetcher as typeof fetch,
  );
  expect(result[0].sha512).toBe(
    createHash("sha512").update(archive).digest("hex"),
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    redirect: "manual",
    headers: { accept: "application/octet-stream" },
  });
  await publicPackages(workspace, cache, fetcher as typeof fetch);
  expect(fetcher).toHaveBeenCalledOnce();
  await writeFile(path.join(cache, result[0].sha512 + ".tgz"), "tampered");
  await expect(
    publicPackages(workspace, cache, fetcher as typeof fetch),
  ).rejects.toThrow("integrity");
});

it("refuses redirects, oversized bytes and wrong digests before cache delivery", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.invalid" },
    }),
    new Response(Buffer.alloc(4 * 1024 * 1024 + 1)),
    new Response("wrong bytes"),
  ]) {
    const { workspace, cache } = await fixture();
    await expect(
      publicPackages(
        workspace,
        cache,
        vi.fn(async () => response) as typeof fetch,
      ),
    ).rejects.toThrow();
  }
});

it("excludes private source paths and refuses source links and known secrets", async () => {
  const { workspace } = await fixture();
  await writeFile(path.join(workspace, ".env"), "do not transfer");
  expect(
    (await projectFiles(workspace)).map((file) => file.path),
  ).not.toContain(".env");
  const outside = path.join(workspace, "outside");
  await writeFile(outside, "fixture");
  await symlink(outside, path.join(workspace, "linked"));
  await expect(projectFiles(workspace)).rejects.toThrow("links");
  await rm(path.join(workspace, "linked"));
  registerSensitiveValue("project-transfer-private-canary");
  await writeFile(outside, "project-transfer-private-canary");
  await expect(projectFiles(workspace)).rejects.toThrow("Private");
});

it("validates all artifacts before bounded replacement and never follows the old output link", async () => {
  const { workspace } = await fixture();
  const data = Buffer.from("built output");
  const file = {
    path: "dist/index.html",
    data: data.toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  for (const value of [
    { ...file, path: "../outside" },
    { ...file, path: "dist/.env" },
    { ...file, sha256: "bad" },
  ])
    await expect(restoreArtifacts(workspace, [value])).rejects.toThrow();
  const outside = await mkdtemp(
    path.join(tmpdir(), "ohmygame-artifact-outside-"),
  );
  directories.push(outside);
  await writeFile(path.join(outside, "canary"), "unchanged");
  await symlink(outside, path.join(workspace, "dist"));
  await restoreArtifacts(workspace, [file]);
  expect(await readFile(path.join(outside, "canary"), "utf8")).toBe(
    "unchanged",
  );
  expect(await realpath(path.join(workspace, "dist"))).toBe(
    path.join(workspace, "dist"),
  );
  await writeFile(path.join(workspace, "dist/stale"), "old");
  await restoreArtifacts(workspace, [file]);
  await expect(readFile(path.join(workspace, "dist/stale"))).rejects.toThrow();
  registerSensitiveValue("artifact-transfer-private-canary");
  const secret = Buffer.from("artifact-transfer-private-canary");
  await expect(
    restoreArtifacts(workspace, [
      {
        path: "dist/leak",
        data: secret.toString("base64"),
        sha256: createHash("sha256").update(secret).digest("hex"),
      },
    ]),
  ).rejects.toThrow("Private");
});


it("restores every previous output directory when publishing a later directory fails", async () => {
  const { workspace } = await fixture();
  const bytes = Buffer.from("new build");
  const incoming = ["dist", "build"].map(name => ({
    path: name + "/entry", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  for (const name of ["dist", "build"]) {
    await mkdir(path.join(workspace, name));
    await writeFile(path.join(workspace, name, "entry"), name);
  }
  await expect(restoreArtifacts(workspace, incoming, [], undefined, async () => {
    const staging = (await readdir(workspace)).find(name => name.startsWith(".omg-artifacts-"))!;
    await rename(path.join(workspace, staging, "build"), path.join(workspace, staging, "missing"));
  })).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(workspace, "dist/entry"), "utf8")).toBe("dist");
  expect(await readFile(path.join(workspace, "build/entry"), "utf8")).toBe("build");
});

it("reports oversized project assets safely and keeps recovery originals outside execution", async () => {
  const { workspace } = await fixture();
  const limit = 2 * 1024 * 1024;
  const relative = "assets/original.png";
  await mkdir(path.join(workspace, "assets"));
  const original = Buffer.alloc(limit + 1, 7);
  await writeFile(path.join(workspace, relative), original);
  const error = await projectFiles(workspace).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(isIsolatedInputBudgetError(error)).toBe(true);
  expect(getToolPreflightFailure(error)).toBeUndefined();
  expect(isIsolatedInputBudgetError(Object.assign(new Error((error as Error).message), { budget: true }))).toBe(false);
  expect((error as Error).message).toContain('"assets/original.png"');
  expect((error as Error).message).toContain("2097153 bytes");
  expect((error as Error).message).toContain("2097152 bytes (2 MiB)");
  expect((error as Error).message).toContain("outside the execution workspace");
  expect((error as Error).message).toContain("use optimize_image_asset locally");
  expect((error as Error).message).toContain("never regenerate or switch transparent assets to JPEG");
  expect((error as Error).message).toContain("Do not delete or overwrite");
  expect((error as Error).message).not.toContain(workspace);
  expect(await readFile(path.join(workspace, relative))).toEqual(original);

  const recovery = await mkdtemp(path.join(tmpdir(), "ohmygame-recovery-"));
  directories.push(recovery);
  await rename(path.join(workspace, relative), path.join(recovery, "original.png"));
  // Exactly the limit is still allowed; the larger preserved original is not transferred.
  await writeFile(path.join(workspace, "assets/working.png"), original.subarray(0, limit));
  expect((await projectFiles(workspace)).map((file) => file.path)).toEqual(
    expect.arrayContaining(["assets/working.png", "package.json", "package-lock.json"]),
  );
  expect((await projectFiles(workspace)).map((file) => file.path)).not.toContain(relative);
  expect(await readFile(path.join(recovery, "original.png"))).toEqual(original);
});

it("brands aggregate runtime budgets only as reader diagnostics and leaves arbitrary file-policy failures unbranded", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  for (let index = 0; index < 3; index++) {
    const name = path.join(workspace, `public/input-${index}.png`);
    await writeFile(name, ""); await truncate(name, 23 * 1024 * 1024);
  }
  const media: RuntimeMedia[] = [];
  const failure = await projectFiles(workspace, media).catch(cause => cause);
  expect(isIsolatedInputBudgetError(failure)).toBe(true); expect(getToolPreflightFailure(failure)).toBeUndefined();
  expect(failure.message).toContain("32 MiB per-file or 64 MiB total limit");
  expect(failure.message).toContain(`Eligible media: ${69 * 1024 * 1024} bytes`);
  expect(failure.message).toContain(`total overage ${5 * 1024 * 1024} bytes`);
  expect(failure.message).toContain("entire eligible workspace media set, not a per-batch allowance");
  expect(failure.message).toContain("capacity diagnostic"); expect(media).toEqual([]);
  await rm(path.join(workspace, "public"), { recursive: true });
  await symlink(path.join(workspace, "package.json"), path.join(workspace, "linked.json"));
  const unsafe = await projectFiles(workspace).catch(cause => cause);
  expect(isIsolatedInputBudgetError(unsafe)).toBe(false);
});

it("does not expose registered secrets or private paths in oversize diagnostics", async () => {
  const { workspace } = await fixture();
  const secret = "oversize-filename-private-canary";
  registerSensitiveValue(secret);
  await writeFile(path.join(workspace, ".env"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(projectFiles(workspace)).resolves.toHaveLength(2);
  await writeFile(path.join(workspace, `${secret}.png`), Buffer.alloc(2 * 1024 * 1024 + 1));
  const error = await projectFiles(workspace).catch((error: Error) => error);
  expect((error as Error).message).toContain("[redacted project file]");
  expect((error as Error).message).not.toContain(secret);
  expect((error as Error).message).not.toContain(workspace);
});

it("reports aggregate eligible bytes and bounded largest files without reading huge assets", async () => {
  const { workspace } = await fixture();
  const baseline = await inspectProjectSourceBudget(workspace);
  for (let index = 0; index < 6; index++) {
    const file = path.join(workspace, `asset-${index}.png`);
    await writeFile(file, "");
    await truncate(file, 2 * 1024 * 1024);
  }
  await mkdir(path.join(workspace, "dist"));
  await writeFile(path.join(workspace, "dist", "ignored.png"), "");
  await truncate(path.join(workspace, "dist", "ignored.png"), 1024 ** 3);
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.complete).toBe(true);
  expect(budget.totalBytes).toBe(baseline.totalBytes + 12 * 1024 * 1024);
  expect(budget.fileCount).toBe(baseline.fileCount + 6);
  expect(budget.overage.totalBytes).toBe(budget.totalBytes - 8 * 1024 * 1024);
  expect(budget.overage.fileBytes).toBe(0);
  expect(budget.largestFiles).toHaveLength(5);
  await expect(projectFiles(workspace)).rejects.toThrow(`${budget.totalBytes} bytes / 8 files`);
  await expect(projectFiles(workspace)).rejects.toThrow(`overage ${budget.overage.totalBytes} bytes / 0 files`);
  await truncate(path.join(workspace, "asset-0.png"), 1024 ** 3);
  await expect(projectFiles(workspace)).rejects.toThrow("1073741824 bytes");
});

it("reports file count overage and stops entry inspection with explicit lower bounds", async () => {
  const { workspace } = await fixture();
  for (let index = 0; index < 2001; index++) await writeFile(path.join(workspace, `file-${index}`), "");
  const budget = await inspectProjectSourceBudget(workspace);
  expect(budget.fileCount).toBe(2003);
  expect(budget.overage.fileCount).toBe(3);
  await expect(projectFiles(workspace)).rejects.toThrow("/ 3 files");
  for (let index = 0; index < 2000; index++) await writeFile(path.join(workspace, `.ignored-${index}`), "");
  const partial = await inspectProjectSourceBudget(workspace);
  expect(partial.complete).toBe(false);
  expect(partial.entryCount).toBe(4001);
  await expect(projectFiles(workspace)).rejects.toThrow("totals are lower bounds");
}, 30_000);

it("projects replacements and removals without overlooking other oversized files or mutating originals", async () => {
  const { workspace } = await fixture();
  const oversized = 2 * 1024 * 1024 + 1;
  for (let index = 0; index < 7; index++) {
    await writeFile(path.join(workspace, `large-${index}.png`), "");
    await truncate(path.join(workspace, `large-${index}.png`), oversized);
  }
  const projections = Array.from({ length: 6 }, (_, index) => ({ path: `large-${index}.png`, size: null }));
  const partial = await inspectProjectSourceBudget(workspace, projections);
  expect(partial.overage.fileBytes).toBe(1);
  const baseline = await inspectProjectSourceBudget(workspace);
  const projected = await inspectProjectSourceBudget(workspace, [
    ...projections, { path: "large-6.png", size: 100 }, { path: "assets/working.webp", size: 100 },
  ]);
  expect(projected.fileCount).toBe(4);
  expect(projected.totalBytes).toBe(baseline.totalBytes - 7 * oversized + 200);
  expect(projected.overage).toEqual({ totalBytes: 0, fileCount: 0, fileBytes: 0, entries: 0 });
  expect((await inspectProjectSourceBudget(workspace)).totalBytes).toBe(baseline.totalBytes);
  const baseBytes = baseline.totalBytes - 7 * oversized;
  const exact = await inspectProjectSourceBudget(workspace, [
    ...Array.from({ length: 7 }, (_, index) => ({ path: `large-${index}.png`, size: null })),
    ...Array.from({ length: 4 }, (_, index) => ({ path: `fit-${index}.webp`, size: 2 * 1024 * 1024 - (index === 0 ? baseBytes : 0) })),
  ]);
  expect(exact.totalBytes).toBe(8 * 1024 * 1024);
  expect(exact.overage.totalBytes).toBe(0);
  expect(exact.overage.fileBytes).toBe(0);
  await expect(inspectProjectSourceBudget(workspace, [{ path: ".env", size: 1 }])).rejects.toThrow("Private");
  await expect(inspectProjectSourceBudget(workspace, [{ path: "dist/new", size: 1 }])).rejects.toThrow("invalid");
  await expect(inspectProjectSourceBudget(workspace, [{ path: "package.json/child", size: 1 }])).rejects.toThrow("file parent");
  await expect(inspectProjectSourceBudget(workspace, [{ path: "new", size: -1 }])).rejects.toThrow("invalid");
});

it("rejects hardlinks and symlinks even when projected away; keeps metadata paths redacted", async () => {
  const { workspace } = await fixture();
  const secret = "budget-filename-private-canary.png";
  registerSensitiveValue(secret);
  await writeFile(path.join(workspace, secret), "safe");
  const budget = await inspectProjectSourceBudget(workspace);
  expect(JSON.stringify(budget)).not.toContain(secret);
  expect(JSON.stringify(budget)).toContain("[redacted project file]");
  await expect(inspectProjectSourceBudget(workspace, [{ path: secret, size: null }])).rejects.toThrow("Private");
  await link(path.join(workspace, "package.json"), path.join(workspace, "hardlinked"));
  await expect(inspectProjectSourceBudget(workspace, [{ path: "hardlinked", size: null }])).rejects.toThrow("unlinked");
  await rm(path.join(workspace, "hardlinked"));
  await symlink("package.json", path.join(workspace, "linked"));
  await expect(inspectProjectSourceBudget(workspace, [{ path: "linked", size: null }])).rejects.toThrow("links");
});

it("requires an explicit 128-v2 profile for a complete workspace above the legacy media cap", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  for (const [name, size] of [["a.png", 32 * 1024 * 1024], ["b.png", 32 * 1024 * 1024], ["c.png", 16]] as const) {
    const target = path.join(workspace, "public", name);
    await writeFile(target, header); await truncate(target, size);
  }
  await expect(projectFiles(workspace, [])).rejects.toThrow("64 MiB");
  const media: RuntimeMedia[] = [];
  const source = await projectFiles(workspace, media, undefined, { profile: "capacity-128-v2" });
  expect(media.reduce((sum, item) => sum + item.size, 0)).toBe(64 * 1024 * 1024 + 16);
  expect(media.find(item => item.path === "public/a.png")?.sha256).toBe(media.find(item => item.path === "public/b.png")?.sha256);
  expect(() => sourceManifestEntries([...source, ...media])).toThrow("media budget");
  expect(sourceManifestEntries([...source, ...media], { profile: "capacity-128-v2" }).binaryDeclaredBytes).toBe(64 * 1024 * 1024 + 16);
  const budget = await inspectProjectSourceBudget(workspace, [], true, undefined, { profile: "capacity-128-v2" });
  expect(budget.limits.mediaBytes).toBe(128 * 1024 * 1024);
  expect(budget.overage.mediaBytes).toBeUndefined();
  await expect(projectFiles(workspace, [], undefined, { profile: "unrecognised" as never })).rejects.toThrow("Unknown");
  const cancelled = new AbortController(); cancelled.abort();
  await expect(projectFiles(workspace, [], undefined, { profile: "capacity-128-v2", signal: cancelled.signal })).rejects.toThrow();
});

it("counts every media descriptor against the selected complete-set limit", async () => {
  const { workspace } = await fixture();
  const size = 32 * 1024 * 1024;
  const entries = Array.from({ length: 4 }, (_, index) => ({ path: `public/${index}.png`, size, sha256: "a".repeat(64) }));
  expect(sourceManifestEntries(entries, { profile: "capacity-128-v2" }).binaryDeclaredBytes).toBe(128 * 1024 * 1024);
  expect(() => sourceManifestEntries([...entries, { ...entries[0]!, path: "public/extra.png", size: 1 }], { profile: "capacity-128-v2" })).toThrow("media budget");
  const projected = await inspectProjectSourceBudget(workspace, [...entries.map(({ path, size }) => ({ path, size })), { path: "public/extra.png", size: 1 }], true, undefined, { profile: "capacity-128-v2" });
  expect(projected.overage.mediaBytes).toBe(1);
});

it("restores over-64 MiB verified host copies only under the explicit new profile", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  for (const [name, size] of [["a.png", 32 * 1024 * 1024], ["b.png", 32 * 1024 * 1024], ["c.png", 16]] as const) {
    const target = path.join(workspace, "public", name); await writeFile(target, header); await truncate(target, size);
  }
  const sources: RuntimeMedia[] = []; await projectFiles(workspace, sources, undefined, { profile: "capacity-128-v2" });
  const output = sources.map(source => ({ ...source, path: `dist/${path.basename(source.path)}` }));
  const verifiedCopies = new Map(output.map((entry, index) => [entry.path, sources[index]!]));
  let generatedReads = 0;
  const readGenerated = async () => { generatedReads++; throw new Error("unexpected generated read"); };
  await expect(restoreArtifacts(workspace, [], output, readGenerated)).rejects.toThrow();
  await expect(restoreArtifacts(workspace, [], output, readGenerated, undefined, { profile: "capacity-128-v2" })).rejects.toThrow("64 MiB");
  await restoreArtifacts(workspace, [], output, readGenerated, undefined, { profile: "capacity-128-v2", sourceWorkspace: workspace, verifiedCopies });
  expect(generatedReads).toBe(0);
  for (const item of output) expect((await stat(path.join(workspace, item.path))).size).toBe(item.size);
  await writeFile(path.join(workspace, "public/c.png"), Buffer.alloc(16));
  await expect(restoreArtifacts(workspace, [], output, readGenerated, undefined, { profile: "capacity-128-v2", sourceWorkspace: workspace, verifiedCopies })).rejects.toThrow();
  for (const item of output) expect((await stat(path.join(workspace, item.path))).size).toBe(item.size);
});

it("limits generated build media to 64 MiB and rejects unbound copy claims before publication", async () => {
  const { workspace } = await fixture();
  const size = 32 * 1024 * 1024;
  const media = [0, 1, 2].map(index => ({ path: `dist/${index}.png`, size: index === 2 ? 16 : size, sha256: "a".repeat(64) }));
  let reads = 0; const read = async () => { reads++; return Buffer.alloc(0); };
  await expect(restoreArtifacts(workspace, [], media, read, undefined, { profile: "capacity-128-v2" })).rejects.toThrow("64 MiB");
  expect(reads).toBe(0);
  await expect(restoreArtifacts(workspace, [], media.slice(0, 1), read, undefined, { profile: "capacity-128-v2", sourceWorkspace: workspace, verifiedCopies: new Map([["dist/unknown.png", { ...media[0]!, path: "public/a.png" }]]) })).rejects.toThrow("Unexpected");
  const copies = Array.from({ length: 4 }, (_, index) => ({ path: `dist/copy-${index}.png`, size, sha256: "a".repeat(64) }));
  const sourceBindings = new Map(copies.map((item, index) => [item.path, { ...item, path: `public/source-${index}.png` }]));
  await expect(restoreArtifacts(workspace, [], [...copies, { path: "dist/generated.png", size: 16, sha256: "b".repeat(64) }], read, undefined, { profile: "capacity-128-v2", sourceWorkspace: workspace, verifiedCopies: sourceBindings })).rejects.toThrow("complete-set");
  expect(reads).toBe(0);
});

const media64Profile = "capacity-128-media64-v3" as const;
async function sparseWave(workspace: string, relative: string, size: number): Promise<RuntimeMedia> {
  const target = path.join(workspace, relative); await mkdir(path.dirname(target), { recursive: true });
  const header = Buffer.alloc(44); header.write("RIFF"); header.writeUInt32LE(size - 8, 4); header.write("WAVEfmt ", 8);
  await writeFile(target, header); await truncate(target, size);
  const checked = await inspectSafeProjectMedia(workspace, target, 64 * 1024 ** 2); return { path: relative, size: checked.size, sha256: checked.sha256 };
}
it("media64 streams an exact 64 MiB known WAV through bounded chunks and leaves old profiles/raster bounds intact", async () => {
  const { workspace } = await fixture(), size = 64 * 1024 ** 2, entry = await sparseWave(workspace, "public/large.wav", size);
  await expect(projectFiles(workspace, [], undefined, { profile: "capacity-128-v2" })).rejects.toThrow("32 MiB");
  const media: RuntimeMedia[] = []; await projectFiles(workspace, media, undefined, { profile: media64Profile }); expect(media).toEqual([expect.objectContaining({ size, sha256: entry.sha256 })]);
  let bytes = 0, largest = 0; const hash = createHash("sha256");
  await copyRuntimeMedia(workspace, entry, new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) { bytes += chunk.length; largest = Math.max(largest, chunk.length); hash.update(chunk); setImmediate(done); } }), { profile: media64Profile });
  expect(bytes).toBe(size); expect(largest).toBeLessThanOrEqual(64 * 1024); expect(hash.digest("hex")).toBe(entry.sha256);
  expect(await inspectRuntimeMedia(workspace, entry, { profile: media64Profile })).toMatchObject({ size, sha256: entry.sha256 });
  await truncate(path.join(workspace, entry.path), size + 1); await expect(projectFiles(workspace, [], undefined, { profile: media64Profile })).rejects.toThrow("64 MiB");
  await rename(path.join(workspace, entry.path), path.join(workspace, "public/large.png"));
  const budget = await inspectProjectSourceBudget(workspace, [], true, undefined, { profile: media64Profile }); expect(budget.overage.mediaFileBytes).toBe(32 * 1024 ** 2 + 1);
}, 30_000);

it.each([65530, 1024 * 1024 - 40])("media64 scans secrets at offset %s before offering any bytes", async offset => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/secret.wav", 1024 * 1024);
  const secret = "media64-secret-cross-chunk-canary"; registerSensitiveValue(secret);
  const handle = await open(path.join(workspace, entry.path), "r+"); try { await handle.write(secret, offset); } finally { await handle.close(); }
  let offered = 0;
  await expect(copyRuntimeMedia(workspace, entry, new Writable({ write(chunk, _encoding, done) { offered += chunk.length; done(); } }), { profile: media64Profile })).rejects.toThrow("Protected credential");
  expect(offered).toBe(0);
});
it("media64 metadata-only, cancelled, changed and non-executable-copy checks keep the source intact", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/check.wav", 1024 * 1024), file = path.join(workspace, entry.path);
  const checked = await withCheckedFileStream(workspace, file, { maxBytes: entry.size, expectedSha256: entry.sha256 }, async (_unused, info) => info); expect(checked.sha256).toBe(entry.sha256);
  const cancelled = new AbortController(); cancelled.abort(); await expect(inspectRuntimeMedia(workspace, entry, { profile: media64Profile, signal: cancelled.signal })).rejects.toThrow();
  await chmod(file, 0o700); await expect(inspectRuntimeMedia(workspace, entry, { profile: media64Profile })).rejects.toThrow("changed"); await chmod(file, 0o600);
  await expect(inspectRuntimeMedia(workspace, { ...entry, sha256: "f".repeat(64) }, { profile: media64Profile })).rejects.toThrow();
  expect((await stat(file)).size).toBe(entry.size);
});
it("media64 cleanup uncertainty cannot keep a no-effect budget brand and retains the original cause", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/cleanup.wav", 256);
  const primary = isolatedInputBudgetError("primary input rejection"); expect(isIsolatedInputBudgetError(primary)).toBe(true);
  const evict = vi.spyOn(CheckedMediaSnapshotStore.prototype, "evictScope").mockRejectedValueOnce(new Error("cleanup unconfirmed"));
  const failure = await withCheckedFileStream(workspace, path.join(workspace, entry.path), { maxBytes: entry.size }, async () => { throw primary; }).catch(cause => cause);
  expect(failure.message).toBe("Checked transfer cleanup could not be confirmed"); expect(failure.cause).toBeInstanceOf(AggregateError); expect(failure.cause.errors).toContain(primary); expect(isIsolatedInputBudgetError(failure)).toBe(false); evict.mockRestore();
});
it("media64 rejects new cache producers while a shared close is pending and can reopen after shutdown", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/close.wav", 256);
  await inspectRuntimeMedia(workspace, entry, { profile: media64Profile });
  const original = CheckedMediaSnapshotStore.prototype.close; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const close = vi.spyOn(CheckedMediaSnapshotStore.prototype, "close").mockImplementation(async function (this: CheckedMediaSnapshotStore) { await gate; return original.call(this); });
  const first = closeRuntimeMediaSnapshots(), second = closeRuntimeMediaSnapshots();
  await expect(inspectRuntimeMedia(workspace, entry, { profile: media64Profile })).rejects.toThrow("closing"); release(); await Promise.all([first, second]); expect(close).toHaveBeenCalledTimes(1); close.mockRestore();
  await expect(inspectRuntimeMedia(workspace, entry, { profile: media64Profile })).resolves.toMatchObject({ sha256: entry.sha256 });
});
it("media64 build copies use the checked source stream while untrusted 64 MiB output is rejected without a read", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/build.wav", 64 * 1024 ** 2), output = { ...entry, path: "dist/build.wav" }, read = vi.fn(async () => Buffer.alloc(0));
  await expect(restoreArtifacts(workspace, [], [output], read, undefined, { profile: media64Profile })).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  await restoreArtifacts(workspace, [], [output], read, undefined, { profile: media64Profile, sourceWorkspace: workspace, verifiedCopies: new Map([[output.path, entry]]) });
  expect(read).not.toHaveBeenCalled(); expect(await inspectSafeProjectMedia(workspace, path.join(workspace, output.path), output.size)).toMatchObject({ size: output.size, sha256: entry.sha256 });
}, 30_000);
function ftyp(major: string, compatible: string[], extended = false) { const header = extended ? 16 : 8, size = header + 8 + compatible.length * 4, bytes = Buffer.alloc(size); bytes.writeUInt32BE(extended ? 1 : size); bytes.write("ftyp", 4); if (extended) bytes.writeBigUInt64BE(BigInt(size), 8); bytes.write(major, header); compatible.forEach((value, i) => bytes.write(value, header + 8 + i * 4)); return bytes; }
it.each([false, true])("media64 accepts complete ftyp headers and rejects image-brand camouflage (extended=%s)", extended => {
  const size = 33 * 1024 ** 2, valid = ftyp("isom", ["iso2", "mp42"], extended);
  expect(mediaHeaderMatches("public/video.mp4", valid, size, media64Profile)).toBe(true);
  for (const brand of ["avif", "avis", "mif1", "msf1", "miaf", "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "heif"]) {
    expect(mediaHeaderMatches("public/video.mp4", ftyp(brand, [], extended), size, media64Profile)).toBe(false);
    expect(mediaHeaderMatches("public/music.m4a", ftyp("isom", [brand], extended), size, media64Profile)).toBe(false);
  }
  expect(mediaHeaderMatches("public/video.mp4", valid.subarray(0, valid.length - 1), size, media64Profile)).toBe(false);
  expect(mediaHeaderMatches("public/video.mp4", ftyp("avif", [], extended), size, "capacity-128-v2")).toBe(true);
  expect(mediaHeaderMatches("public/video.mp4", ftyp("avif", [], extended), 32 * 1024 ** 2, media64Profile)).toBe(true);
});
it.each([0, 17, 260])("media64 rejects invalid or unbounded ftyp box size %s", boxSize => { const bytes = ftyp("isom", []); bytes.writeUInt32BE(boxSize); expect(mediaHeaderMatches("public/a.mov", bytes, 33 * 1024 ** 2, media64Profile)).toBe(false); });

it("media64 bounds two simultaneous source pipelines without whole-media allocation", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/concurrent.wav", 64 * 1024 ** 2);
  let started = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const results = [0, 1].map(() => ({ size: 0, hash: createHash("sha256"), largest: 0 }));
  const alloc = vi.spyOn(Buffer, "alloc"), unsafe = vi.spyOn(Buffer, "allocUnsafe");
  try { await Promise.all(results.map(result => copyRuntimeMedia(workspace, entry, new Writable({ highWaterMark: 1024, write(chunk, _encoding, done) { if (!result.size && ++started === 2) release(); result.size += chunk.length; result.largest = Math.max(result.largest, chunk.length); result.hash.update(chunk); void gate.then(() => done()); } }), { profile: media64Profile }))); }
  finally { const largest = Math.max(0, ...alloc.mock.calls.map(call => call[0]), ...unsafe.mock.calls.map(call => call[0])); alloc.mockRestore(); unsafe.mockRestore(); expect(largest).toBeLessThan(32 * 1024 ** 2); }
  expect(started).toBe(2); for (const result of results) { expect(result.size).toBe(entry.size); expect(result.largest).toBeLessThanOrEqual(64 * 1024); expect(result.hash.digest("hex")).toBe(entry.sha256); }
}, 30_000);
it.each(["abort", "policy"])("media64 stops an active checked copy after %s without branding a partial offer as no-effect", async fault => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/interrupted.wav", 1024 * 1024), controller = new AbortController(); let offered = 0;
  const outcome = await copyRuntimeMedia(workspace, entry, new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { offered += chunk.length; if (fault === "abort") controller.abort(); else registerSensitiveValue("media64-new-policy-after-first-byte"); done(); } }), { profile: media64Profile, signal: controller.signal }).catch(cause => cause);
  expect(outcome).toBeInstanceOf(Error); expect(offered).toBeGreaterThan(0); expect(offered).toBeLessThan(entry.size); expect(isIsolatedInputBudgetError(outcome)).toBe(false); expect((await stat(path.join(workspace, entry.path))).size).toBe(entry.size);
});
it("media64 rejects source replacement between the prefix and full lease before offering payload bytes", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/race.wav", 1024 * 1024), acquire = CheckedMediaSnapshotStore.prototype.acquire; let calls = 0, offered = 0;
  const race = vi.spyOn(CheckedMediaSnapshotStore.prototype, "acquire").mockImplementation(async function (this: CheckedMediaSnapshotStore, ...args) { if (++calls === 2) { const handle = await open(path.join(workspace, entry.path), "r+"); try { await handle.write(Buffer.from([1]), 0, 1, 100); } finally { await handle.close(); } } return acquire.apply(this, args); });
  await expect(copyRuntimeMedia(workspace, entry, new Writable({ write(chunk, _encoding, done) { offered += chunk.length; done(); } }), { profile: media64Profile })).rejects.toThrow(); race.mockRestore(); expect(offered).toBe(0); expect(calls).toBe(2);
});
it("media64 keeps a failed cache shutdown latched rather than creating a second store", async () => {
  const { workspace } = await fixture(), entry = await sparseWave(workspace, "public/poison.wav", 256);
  vi.resetModules(); const freshFiles = await import("../src/daemon/isolated-project-files.js"), freshSnapshots = await import("../src/daemon/checked-media-snapshot.js");
  const make = fs.mkdtemp; const made = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => { const created = await make(...args); if (typeof created === "string") directories.push(created); return created; });
  await freshFiles.inspectRuntimeMedia(workspace, entry, { profile: media64Profile }); made.mockRestore();
  const close = freshSnapshots.CheckedMediaSnapshotStore.prototype.close;
  const failing = vi.spyOn(freshSnapshots.CheckedMediaSnapshotStore.prototype, "close").mockImplementation(async function (this: CheckedMediaSnapshotStore) { await close.call(this); throw new Error("synthetic close uncertainty"); });
  await expect(freshFiles.closeRuntimeMediaSnapshots()).rejects.toThrow("synthetic close uncertainty");
  await expect(freshFiles.closeRuntimeMediaSnapshots()).rejects.toThrow("synthetic close uncertainty");
  await expect(freshFiles.inspectRuntimeMedia(workspace, entry, { profile: media64Profile })).rejects.toThrow("closing"); expect(failing).toHaveBeenCalledTimes(1); failing.mockRestore();
});
