import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  open,
  chmod,
  link,
  symlink,
  statfs,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  projectFiles,
  closeRuntimeMediaSnapshots,
  type RuntimeMedia,
  type TransferFile,
} from "../src/daemon/isolated-project-files.js";
import { inspectSafeProjectMedia } from "../src/daemon/safe-project-file.js";
import { applySourceChanges, sourceRecoveryBudget } from "../src/daemon/isolated-source-changes.js";
import { assertSourcePublicationSettled, initializePublicationManifest, savePublicationManifest, pendingSourcePublications, retainedPublicationOriginal, resumeSourcePublications, samePublicationContext, sourcePublicationMetadata, type PublicationContext } from "../src/daemon/isolated-publication-journal.js";
import { validateRasterReturn } from "../src/daemon/isolated-raster-returns.js";
import { prepareWorkingImage } from "../src/daemon/image-working-assets.js";
import { RECOVERY_LIMIT_BYTES, reserveRecoverySpace } from "../src/daemon/recovery-space.js";
import { validateRasterArtifact } from "../src/daemon/validated-raster-artifact.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { approvedSourceReview, assertReviewedHost, buildSourceReview, readSourceReview, saveSourceReview } from "../src/daemon/isolated-source-review.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { createIsolatedShellTool } from "../src/daemon/isolated-shell-tool.js";
import {
  activePiToolNames,
  planningPiToolNames,
} from "../src/daemon/agent-tools.js";
import {
  assertSourceDeltaSummary,
  canonicalSourceManifestRows,
  createSourceManifest,
  createSourceManifestV2,
  parseSourceContract,
  parseSourceManifest,
  sourceManifestFromLegacyBaseline,
  planSourceDelta,
  type SourceManifestEntryV1,
} from "../src/daemon/isolated-source-manifest.js";

const directories: string[] = [];
const interception = vi.hoisted(() => ({
  beforeLink: undefined as undefined | ((target: string) => Promise<void>),
  beforeWrite: undefined as undefined | ((file: string, bytes: Uint8Array, partial: (bytes: Uint8Array) => Promise<void>) => Promise<void>),
  beforeSync: undefined as undefined | ((file: string) => Promise<void>),
  diskAvailable: undefined as undefined | bigint,
  diskUnit: undefined as undefined | bigint,
  freeInodes: undefined as undefined | bigint,
  workspaceDevices: new Map<string, number>(),
  beforeStatfs: undefined as undefined | (() => void),
  beforeOpenDirectory: undefined as undefined | ((directory: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const value = await actual.lstat(...args), device = interception.workspaceDevices.get(String(args[0]));
      return device === undefined ? value : new Proxy(value, { get(target, key) {
        if (key === "dev") return typeof target.dev === "bigint" ? BigInt(device) : device;
        const result = Reflect.get(target, key, target); return typeof result === "function" ? result.bind(target) : result;
      } });
    },
    statfs: async (...args: Parameters<typeof actual.statfs>) => {
      interception.beforeStatfs?.();
      const value = await actual.statfs(...args);
      return interception.diskAvailable === undefined && interception.diskUnit === undefined && interception.freeInodes === undefined ? value : { ...value, bsize: interception.diskUnit ?? 1n, bavail: interception.diskAvailable ?? 10n ** 15n, ...(interception.freeInodes === undefined ? {} : { ffree: interception.freeInodes }) };
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      await interception.beforeOpenDirectory?.(String(args[0]));
      return actual.opendir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, { get(target, key) {
        if (key === "sync") return async () => { await interception.beforeSync?.(String(args[0])); return target.sync(); };
        if (key === "writeFile") return async (bytes: Uint8Array) => {
          await interception.beforeWrite?.(String(args[0]), bytes, part => target.writeFile(part));
          return target.writeFile(bytes);
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    link: async (
      source: Parameters<typeof actual.link>[0],
      target: Parameters<typeof actual.link>[1],
    ) => {
      await interception.beforeLink?.(String(target));
      return actual.link(source, target);
    },
  };
});
afterEach(async () => {
  interception.beforeLink = undefined;
  interception.beforeWrite = undefined;
  interception.beforeSync = undefined;
  interception.diskAvailable = undefined;
  interception.diskUnit = undefined;
  interception.freeInodes = undefined;
  interception.workspaceDevices.clear();
  interception.beforeStatfs = undefined;
  interception.beforeOpenDirectory = undefined;

});
// Retained mock transactions stay on disk for this process-global ledger until suite teardown.
afterAll(async () => {
  await closeRuntimeMediaSnapshots();
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-source-return-")),
  );
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "game.js"), "original");
  return { directory, workspace, baseline: await projectFiles(workspace) };
}
const file = (name: string, text: string): TransferFile => ({
  path: name,
  data: Buffer.from(text).toString("base64"),
  sha256: createHash("sha256").update(text).digest("hex"),
  executable: false,
});
const context: PublicationContext = { namespace: "test", projectId: "5e849fb8-9236-4f0e-a58a-76cb223b8a74", generation: 2, snapshotId: "b".repeat(64) };
const binary = (name: string, bytes: Buffer): TransferFile => ({ ...file(name, ""), data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
const raster = (alpha = true, width = 24) => sharp({ create: { width, height: 24, channels: alpha ? 4 : 3, background: { r: 30, g: 90, b: 20, alpha: alpha ? 0.5 : 1 } } }).png().toBuffer();

it("returns a locally optimized registered raster with sprites and independent originals, without upgrading old generations", async () => {
  const { workspace, directory } = await fixture();
  await mkdir(path.join(workspace, "public"));
  const original = await raster(true, 48), after = await raster();
  await writeFile(path.join(workspace, "public/forest.png"), original);
  const media: RuntimeMedia[] = [], baseline = await projectFiles(workspace, media);
  const bound = media.find(item => item.path === "public/forest.png")!;
  const returned = [...baseline, { ...binary(bound.path, after), rasterBaseSha256: bound.sha256 }, binary("public/hunter.png", after)];
  await expect(applySourceChanges(workspace, baseline, returned, undefined, media, 0, context)).rejects.toThrow("Unapproved");
  expect(await readFile(path.join(workspace, bound.path))).toEqual(original);
  const result = await applySourceChanges(workspace, baseline, returned, undefined, media, 1, context);
  expect(result.changed).toEqual([bound.path, "public/hunter.png"]);
  expect(await retainedPublicationOriginal(workspace, context, bound.path, bound.sha256, returned[1]!.sha256)).toEqual(original);
  const receipt = JSON.parse(await readFile(path.join(directory, result.recovery!, "manifest.json"), "utf8"));
  expect(receipt).toMatchObject({ state: "committed", version: 3, context, spacePlan: { version: 1, limitBytes: RECOVERY_LIMIT_BYTES }, rasterReceipts: [
    { path: bound.path, beforeSha256: bound.sha256, width: 24, height: 24, hasAlpha: true }, { path: "public/hunter.png", width: 24 },
  ] });
  await writeFile(path.join(workspace, bound.path), "external later edit");
  expect(await readFile(path.join(directory, result.recovery!, "returned", bound.path))).toEqual(after);
  expect(await retainedPublicationOriginal(workspace, context, bound.path, bound.sha256, returned[1]!.sha256)).toEqual(original);
});

it("keeps a small exact original-media replacement on the verified-copy path and retains the replaced image", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  const transparent = await raster(), opaque = await raster(false);
  await writeFile(path.join(workspace, "public/target.png"), transparent);
  await writeFile(path.join(workspace, "public/original.png"), opaque);
  const media: RuntimeMedia[] = [], baseline = await projectFiles(workspace, media);
  const target = media.find(item => item.path === "public/target.png")!, source = media.find(item => item.path === "public/original.png")!;
  const copy = { ...source, path: target.path };
  const returned = [...baseline, source, copy];
  const result = await applySourceChanges(workspace, baseline, returned, undefined, media, 1, context);
  expect(result.changed).toEqual([target.path]);
  expect(await readFile(path.join(workspace, target.path))).toEqual(opaque);
  expect(await retainedPublicationOriginal(workspace, context, target.path, target.sha256, source.sha256)).toEqual(transparent);
});

it("fully decodes derivatives and rejects corrupt, trailing, oversized, renamed, animated and alpha-dropping rasters", async () => {
  const alpha = await raster(), opaque = await raster(false);
  const opaqueAlpha = await sharp(opaque).ensureAlpha().png().toBuffer();
  const corrupt = Buffer.from(alpha); corrupt[corrupt.length - 5] ^= 1;
  const apng = await sharp(alpha).png().toBuffer();
  // An unknown animation chunk must be rejected even if a decoder can read its first frame.
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write("acTL", 4);
  for (const [name, bytes, before] of [
    ["forest.png", alpha.subarray(0, -15), undefined], ["forest.png", corrupt, undefined],
    ["forest.png", Buffer.concat([alpha, Buffer.from("trailing")]), undefined],
    ["forest.png", Buffer.concat([apng.subarray(0, 33), chunk, apng.subarray(33)]), undefined],
    ["forest.png", Buffer.alloc(512 * 1024 + 1), undefined], ["forest.jpg", alpha, undefined],
    ["forest.png", opaque, alpha], ["forest.png", opaqueAlpha, alpha], ["forest.gif", alpha, undefined],
  ] as const) await expect(validateRasterReturn(name, bytes, before)).rejects.toMatchObject({ code: "RASTER_RETURN_REVIEW_REQUIRED" });
  for (const format of ["jpeg", "webp"] as const) {
    const bytes = await sharp(opaque)[format]().toBuffer();
    await expect(validateRasterReturn(`forest.${format}`, bytes)).resolves.toMatchObject({ format, width: 24 });
  }
});

it("can prepare a bounded transparent derivative without changing or publishing retained original bytes", async () => {
  const pixels = Buffer.alloc(768 * 768 * 4);
  let seed = 54721;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[offset + channel] = seed >>> 24;
    }
    pixels[offset + 3] = (offset / 4) % 7 === 0 ? 0 : 180;
  }
  const original = await sharp(pixels, { raw: { width: 768, height: 768, channels: 4 } }).png().toBuffer();
  const retained = Buffer.from(original);
  expect(original.length).toBeGreaterThan(512 * 1024);
  const derivative = await prepareWorkingImage(original, 256);
  expect(derivative.mediaType).toBe("image/png");
  expect(derivative.bytes.length).toBeLessThanOrEqual(512 * 1024);
  expect(derivative.hasTransparency).toBe(true);
  expect(original.equals(retained)).toBe(true);
  await expect(validateRasterReturn("public/derivative.png", derivative.bytes, original)).resolves.toMatchObject({ hasAlpha: true, width: 256, height: 256 });
  // This pure preparation cannot authorize a retained-generation publication or acknowledge its raw snapshot.
  await expect(validateRasterReturn("public/derivative.jpg", derivative.bytes, original)).rejects.toThrow();
});

it("does not trust a raster marker, unsupported media, invalid images or concurrent edits", async () => {
  const { workspace } = await fixture();
  await mkdir(path.join(workspace, "public"));
  const original = await raster(true, 48), after = await raster();
  await writeFile(path.join(workspace, "public/forest.png"), original);
  const media: RuntimeMedia[] = [], baseline = await projectFiles(workspace, media);
  const marker = media[0]!.sha256;
  for (const candidate of [binary("public/forest.png", after), { ...binary("public/forest.png", after), rasterBaseSha256: "f".repeat(64) },
    { ...binary("public/forest.png", after), rasterBaseSha256: marker, executable: true },
    { ...binary("public/forest.png", Buffer.from("invalid")), rasterBaseSha256: marker },
    { ...binary("public/unbound.png", after), rasterBaseSha256: marker }]) {
    await expect(applySourceChanges(workspace, baseline, [...baseline, candidate], undefined, media, 1, context)).rejects.toThrow();
    expect(await readFile(path.join(workspace, "public/forest.png"))).toEqual(original);
  }
  await writeFile(path.join(workspace, "public/forest.png"), await raster(true, 36));
  await expect(applySourceChanges(workspace, baseline, [...baseline, { ...binary("public/forest.png", after), rasterBaseSha256: marker }], undefined, media, 1, context)).rejects.toThrow();
});

async function interruptedPublication(approved = false) {
  const fixtureValue = await fixture();
  let review;
  if (approved) {
    review = await buildSourceReview(fixtureValue.workspace, "test", context.projectId, context.generation, { snapshotId: context.snapshotId,
      files: [file("game.js", "guest"), file("new.js", "added")], baselineFiles: fixtureValue.baseline });
    review.approvedAt = new Date().toISOString(); // A simulated trusted grant; API confirmation is tested at the route boundary.
    await saveSourceReview(review);
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/isolated-publication-crash.ts", fixtureValue.workspace], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
  expect(child.status, child.stderr).toBe(42);
  const [pending] = await pendingSourcePublications(fixtureValue.workspace);
  expect(pending.manifest.state).toBe("publishing");
  expect(await readFile(path.join(fixtureValue.workspace, "game.js"), "utf8")).toBe("guest");
  expect((await stat(path.join(fixtureValue.workspace, "game.js"))).nlink).toBe(2);
  return { ...fixtureValue, pending, review };
}

it("reopens a durable approval after a real process exit and reconciles only the approved batch", async () => {
  const { workspace, review } = await interruptedPublication(true);
  const reopened = await approvedSourceReview(workspace, context.projectId, "test", String(context.generation));
  expect(reopened!.review.reviewId).toBe(review!.review.reviewId);
  await assertReviewedHost(workspace, reopened!, "unchanged");
  await resumeSourcePublications(workspace, context);
  await assertReviewedHost(workspace, reopened!, "after");
  expect((await readSourceReview(workspace, context.projectId, "test", review!.review.reviewId)).approvedAt).toBeTruthy();
});

it("refuses recovery before resuming any partial publication when an unrelated host file changed after approval", async () => {
  const { workspace, review } = await interruptedPublication(true);
  await writeFile(path.join(workspace, "notes.md"), "later user save");
  await expect(assertReviewedHost(workspace, review!, "unchanged")).rejects.toThrow("host changed");
  expect((await stat(path.join(workspace, "game.js"))).nlink).toBe(2);
  await expect(readFile(path.join(workspace, "new.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(workspace, "notes.md"), "utf8")).toBe("later user save");
});

it("lists and blocks malformed images, unknown binaries, code permissions, deletions and incomplete code previews", async () => {
  const { workspace, baseline } = await fixture();
  for (const candidate of [file("public/fake.png", "not a PNG"), file("payload.exe", "MZ-untrusted"), { ...file("run.py", "print('untrusted')"), executable: true },
    file("run.py", "\0binary"), file("public/sprites.json", "invalid JSON"), file("large.js", "x".repeat(65537)), file("multibyte.js", "中".repeat(22000)), file("canvas/assets.json", "{}"), file("canvas/boards/invalid.json", "{}")]) {
    const review = await buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [...baseline, candidate] });
    expect(review.review.blockers).toContainEqual(expect.objectContaining({ path: candidate.path }));
  }
  const deleted = await buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [] });
  expect(deleted.review.blockers).toContainEqual(expect.objectContaining({ path: "game.js" }));
  await expect(buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [...baseline, file("../outside.py", "bad")] })).rejects.toThrow();
  registerSensitiveValue("legacy-review-protected-canary");
  await expect(buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [...baseline, file("legacy-review-protected-canary.txt", "untrusted")] })).rejects.toThrow(/Private|protected file identity/);
  await expect(buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [...baseline, file("leak.txt", "legacy-review-protected-canary")] })).rejects.toThrow("private");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("reports insufficient recovery space during review before requesting approval or touching live files", async () => {
  const { workspace, directory, baseline } = await fixture();
  const retained = path.join(directory, "isolated-changes", "old", "before/public");
  await mkdir(retained, { recursive: true });
  await writeFile(path.join(directory, "isolated-changes/old/manifest.json"), JSON.stringify({ changed: ["public/old.glb"], deleted: [] }));
  const handle = await open(path.join(retained, "old.glb"), "wx");
  try { await handle.truncate(RECOVERY_LIMIT_BYTES); } finally { await handle.close(); }
  const budget = await sourceRecoveryBudget(workspace, 100);
  expect(budget.fits).toBe(false);
  const review = await buildSourceReview(workspace, "test", context.projectId, 22, { snapshotId: context.snapshotId, baselineFiles: baseline, files: [file("game.js", "guest")] });
  expect(review.review.blockers).toContainEqual(expect.objectContaining({ path: "workspace", reason: expect.stringContaining("recovery") }));
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("reconciles an actual abrupt process exit, finishes the exact batch, and tolerates duplicate recovery", async () => {
  const { workspace, pending } = await interruptedPublication();
  await expect(assertSourcePublicationSettled(workspace)).rejects.toMatchObject({ code: "SOURCE_PUBLICATION_REVIEW_REQUIRED" });
  await expect(resumeSourcePublications(workspace, { ...context, generation: 3 })).rejects.toThrow("differ");
  const result = await resumeSourcePublications(workspace, context);
  expect(result.changed).toEqual(["game.js", "new.js"]);
  expect(await readFile(path.join(workspace, "new.js"), "utf8")).toBe("added");
  expect((await stat(path.join(workspace, "game.js"))).nlink).toBe(1);
  expect(await readFile(path.join(pending.directory, "original/game.js"), "utf8")).toBe("original");
  await expect(resumeSourcePublications(workspace, context)).resolves.toEqual({ changed: [] });
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
});

it.each(["delete", "edit", "chmod", "unknown-link", "corrupt-retained", "missing-original"])("retains an interrupted batch after a later %s without recreating or overwriting live files", async action => {
  const { workspace, pending } = await interruptedPublication();
  const target = path.join(workspace, "game.js");
  if (action === "delete") await rm(target);
  if (action === "edit") await writeFile(target, "later user edit");
  if (action === "chmod") await chmod(target, 0o700);
  if (action === "unknown-link") await link(target, path.join(workspace, "user-link.js"));
  if (action === "corrupt-retained") await writeFile(path.join(pending.directory, "returned/game.js"), "corrupt");
  if (action === "missing-original") await rm(path.join(pending.directory, "original/game.js"));
  await expect(resumeSourcePublications(workspace, context)).rejects.toThrow();
  if (action === "delete") await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  if (action === "edit") expect(await readFile(target, "utf8")).toBe("later user edit");
  await expect(readFile(path.join(workspace, "new.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await pendingSourcePublications(workspace)).toHaveLength(1);
});

it.each(["missing", "unknown-version", "private-path", "unknown-shape"])("blocks malformed %s transaction metadata without treating the publication as saved", async fault => {
  const { workspace, pending } = await interruptedPublication();
  const manifestPath = path.join(pending.directory, "manifest.json");
  if (fault === "missing") await rm(manifestPath);
  else {
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    if (fault === "unknown-version") value.version = 999;
    else if (fault === "private-path") value.versions[0].path = "../outside";
    await writeFile(manifestPath, JSON.stringify(fault === "unknown-shape" ? {} : value));
  }
  await expect(assertSourcePublicationSettled(workspace)).rejects.toThrow();
  await expect(resumeSourcePublications(workspace, context)).rejects.toThrow();
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("guest");
  await expect(readFile(path.join(workspace, "new.js"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns edits and additions while preserving recoverable originals", async () => {
  const { directory, workspace, baseline } = await fixture();
  const result = await applySourceChanges(workspace, baseline, [
    file("game.js", "changed"),
    { ...file("run.sh", "echo done"), executable: true },
  ]);
  expect(result.changed).toEqual(["game.js", "run.sh"]);
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe(
    "changed",
  );
  expect(
    await readFile(
      path.join(directory, result.recovery!, "before/game.js"),
      "utf8",
    ),
  ).toBe("original");
  expect((await stat(path.join(workspace, "game.js"))).nlink).toBe(1);
  expect((await stat(path.join(workspace, "run.sh"))).mode & 0o111).toBe(0o100);
});

it("publishes approved large media copies and small images through the guarded source transaction", async () => {
  const { workspace } = await fixture();
  const model = Buffer.alloc(3 * 1024 * 1024);
  model.write("glTF"); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
  await mkdir(path.join(workspace, "assets/generated"), { recursive: true });
  await writeFile(path.join(workspace, "assets/generated/hunter.glb"), model);
  await writeFile(path.join(workspace, "assets/generated/ground.png"), image);
  const media: RuntimeMedia[] = [];
  const baseline = await projectFiles(workspace, media);
  const copies = media.map(item => ({ ...item, path: item.path.replace("assets/generated/", "public/") }));
  const result = await applySourceChanges(workspace, baseline, [...baseline, ...copies], undefined, media);
  expect(result.changed).toEqual(copies.map(item => item.path));
  expect(await readFile(path.join(workspace, "public/hunter.glb"))).toEqual(model);
  expect(await readFile(path.join(workspace, "public/ground.png"))).toEqual(image);
  expect(await readFile(path.join(workspace, "assets/generated/hunter.glb"))).toEqual(model);
  expect((await stat(path.join(workspace, "public/hunter.glb"))).nlink).toBe(1);
  expect((await stat(path.join(workspace, "public/hunter.glb"))).mode & 0o111).toBe(0);
  const modelCopy = copies.find(item => item.path.endsWith(".glb"))!;
  for (const copy of [
    { ...modelCopy, path: "public/tampered.glb", sha256: "a".repeat(64) },
    { ...modelCopy, path: "public/wrong.png" },
    { ...modelCopy, path: "other/hunter.glb" },
    { ...modelCopy, path: "public/executable.glb", executable: true },
  ]) {
    const currentMedia: RuntimeMedia[] = [];
    const current = await projectFiles(workspace, currentMedia);
    await expect(applySourceChanges(workspace, current, [...current, copy], undefined, currentMedia)).rejects.toThrow(/media copy/);
  }
});

it("retains media copies when a concurrent destination save prevents publication", async () => {
  const { workspace, directory } = await fixture();
  const model = Buffer.alloc(3 * 1024 * 1024);
  model.write("glTF"); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  await mkdir(path.join(workspace, "assets/generated"), { recursive: true });
  await writeFile(path.join(workspace, "assets/generated/hunter.glb"), model);
  const media: RuntimeMedia[] = [];
  const baseline = await projectFiles(workspace, media);
  interception.beforeLink = async target => {
    if (target === path.join(workspace, "public/hunter.glb")) await writeFile(target, "concurrent save");
  };
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "guest"), { ...media[0]!, path: "public/hunter.glb" }], undefined, media)).rejects.toThrow("publication stopped");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  expect(await readFile(path.join(workspace, "public/hunter.glb"), "utf8")).toBe("concurrent save");
  const [saved] = await readdir(path.join(directory, "isolated-changes"));
  expect(await readFile(path.join(directory, "isolated-changes", saved!, "after/public/hunter.glb"))).toEqual(model);
});

it("refuses combined host media and ordinary source counts before publication", async () => {
  const { workspace, baseline } = await fixture();
  const media = Array.from({ length: 2000 }, (_, index) => ({ path: `public/${index}.png`, size: 12, sha256: "a".repeat(64) }));
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "guest")], undefined, media)).rejects.toThrow("file count exceeded");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("replaces only approved runtime media and keeps the original in the recovery transaction", async () => {
  const { workspace, directory } = await fixture();
  const model = Buffer.alloc(3 * 1024 * 1024);
  model.write("glTF"); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  const updated = Buffer.from(model); updated[100] = 1;
  await mkdir(path.join(workspace, "assets/files"), { recursive: true });
  await mkdir(path.join(workspace, "public"));
  await writeFile(path.join(workspace, "assets/files/updated.glb"), updated);
  await writeFile(path.join(workspace, "public/hunter.glb"), model);
  const media: RuntimeMedia[] = [];
  const baseline = await projectFiles(workspace, media);
  const source = media.find(file => file.path === "assets/files/updated.glb")!;
  const result = await applySourceChanges(workspace, baseline, [...baseline, { ...source, path: "public/hunter.glb" }], undefined, media);
  expect(result.changed).toEqual(["public/hunter.glb"]);
  expect(await readFile(path.join(workspace, "public/hunter.glb"))).toEqual(updated);
  expect(await readFile(path.join(directory, result.recovery!, "before/public/hunter.glb"))).toEqual(model);
  const currentMedia: RuntimeMedia[] = [];
  const current = await projectFiles(workspace, currentMedia);
  await expect(applySourceChanges(workspace, current, [...current, { ...source, path: "public/hunter.glb", sha256: "f".repeat(64) }], undefined, currentMedia)).rejects.toThrow("Unverified");
  expect(await readFile(path.join(workspace, "public/hunter.glb"))).toEqual(updated);
});

it("keeps the inspected original even when an external handle edits the moved inode later", async () => {
  const { workspace, directory, baseline } = await fixture();
  const handle = await open(path.join(workspace, "game.js"), "r+");
  try {
    const result = await applySourceChanges(workspace, baseline, [file("game.js", "guest")]);
    await handle.truncate(0);
    await handle.writeFile("external late edit");
    expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("guest");
    expect(await readFile(path.join(directory, result.recovery!, "before/game.js"), "utf8")).toBe("external late edit");
    expect(await readFile(path.join(directory, result.recovery!, "original/game.js"), "utf8")).toBe("original");
  } finally { await handle.close(); }
});

it("does not hide returned source inside excluded generated directories", async () => {
  const { workspace, baseline } = await fixture();
  for (const name of ["dist/hidden.js", "src/node_modules/hidden.js", "public/out/hidden.js"]) {
    await expect(applySourceChanges(workspace, baseline, [...baseline, file(name, "hidden")])).rejects.toThrow("Invalid source destination");
  }
  expect(await readdir(workspace)).toEqual(["game.js"]);
});

it("refuses the entire return when a host file or permission changed", async () => {
  const { workspace, baseline } = await fixture();
  await writeFile(path.join(workspace, "game.js"), "user edit");
  await expect(
    applySourceChanges(workspace, baseline, [
      file("game.js", "shell edit"),
      file("new.js", "new"),
    ]),
  ).rejects.toThrow("conflict");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe(
    "user edit",
  );
  expect(await readdir(workspace)).toEqual(["game.js"]);
});

it("never applies a source deletion, invalid path, secret or bad digest", async () => {
  const { workspace, baseline } = await fixture();
  await expect(applySourceChanges(workspace, baseline, [])).rejects.toThrow(
    "deletion requires review",
  );
  registerSensitiveValue("shell-source-secret-canary");
  for (const value of [
    file("../outside", "bad"),
    file(".env", "bad"),
    file("game.js", "shell-source-secret-canary"),
    { ...file("game.js", "bad"), sha256: "wrong" },
  ]) {
    await expect(
      applySourceChanges(workspace, baseline, [value]),
    ).rejects.toThrow();
    expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe(
      "original",
    );
  }
});

it("does not publish after cancellation and exposes only the explicit isolated tool", async () => {
  const { workspace, baseline } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    applySourceChanges(
      workspace,
      baseline,
      [file("game.js", "cancelled")],
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe(
    "original",
  );
  expect(activePiToolNames([], ["isolated_shell"])).toContain("isolated_shell");
  expect(activePiToolNames([], [])).not.toContain("isolated_shell");
  expect(planningPiToolNames()).not.toContain("isolated_shell");
  const tool = createIsolatedShellTool(async () => ({
    output: "ok",
    changed: ["game.js"],
  }));
  expect(tool.name).toBe("isolated_shell");
  const result = await tool.execute(
    "test",
    { command: "echo ok" },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("game.js"),
  });
});

it("counts raw, working, publication, review metadata and incoming transfers in the same recovery capacity", async () => {
  const { workspace } = await fixture();
  const storage = path.dirname(workspace), raw = path.join(storage, "isolated-review-artifacts/raw"), working = path.join(storage, "isolated-review-artifacts/working"), publication = path.join(storage, "isolated-changes");
  const transfers = path.join(storage, "isolated-source-transfers"), reviews = path.join(storage, "isolated-reviews");
  for (const directory of [raw, working, publication, transfers, reviews]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(raw, "raw"), Buffer.alloc(10)); await writeFile(path.join(working, "working"), Buffer.alloc(20)); await writeFile(path.join(publication, "publication"), Buffer.alloc(30));
  await writeFile(path.join(transfers, "incoming"), Buffer.alloc(40)); await writeFile(path.join(reviews, "review.json"), Buffer.alloc(50));
  const budget = await sourceRecoveryBudget(workspace, RECOVERY_LIMIT_BYTES - 150);
  expect(budget).toEqual({ used: 150, limit: RECOVERY_LIMIT_BYTES, fits: true });
  expect((await sourceRecoveryBudget(workspace, RECOVERY_LIMIT_BYTES - 149)).fits).toBe(false);
});

it("refuses a 2001st publication before touching live files when existing committed history is full", async () => {
  const { workspace, baseline } = await fixture(), root = path.join(path.dirname(workspace), "isolated-changes");
  await mkdir(root, { recursive: true });
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, async (_, offset) => {
    const directory = path.join(root, `00000000-0000-4000-8000-${String(start + offset).padStart(12, "0")}`); await mkdir(directory);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 2, state: "committed", versions: [], published: [], steps: {} }));
  }));
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "new source")])).rejects.toThrow("2000-transaction limit");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original"); expect(await readdir(root)).toHaveLength(2000);
});

it("does not replace a last-moment new save and restores moved originals", async () => {
  const { workspace, baseline } = await fixture();
  let saved = false;
  interception.beforeLink = async (target) => {
    if (!saved && target === path.join(workspace, "new.js")) {
      saved = true;
      await writeFile(target, "concurrent-user-save", { flag: "wx" });
    }
  };
  await expect(
    applySourceChanges(workspace, baseline, [
      file("game.js", "shell-edit"),
      file("new.js", "shell-new"),
    ]),
  ).rejects.toThrow("publication stopped");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe(
    "original",
  );
  expect(await readFile(path.join(workspace, "new.js"), "utf8")).toBe(
    "concurrent-user-save",
  );
});

it("removes only an empty uninitialized transaction after its first journal write fails", async () => {
  const { workspace, baseline, directory } = await fixture(); let failed = false;
  interception.beforeWrite = async name => { if (!failed && path.basename(name).startsWith(".manifest-")) { failed = true; throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" }); } };
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "replacement")])).rejects.toThrow("injected full disk");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  expect(await readdir(path.join(directory, "isolated-changes"))).toEqual([]);
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([]);
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
});

it("retains the exact reservation if the first journal rename succeeded but its directory fsync failed", async () => {
  const { workspace, baseline, directory } = await fixture(); let count = 0;
  interception.beforeSync = async file => { if (/\/isolated-changes\/[a-f0-9-]{36}$/.test(file) && ++count === 2) throw Object.assign(new Error("injected initial fsync"), { code: "EIO" }); };
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "replacement")], undefined, undefined, 0, context)).rejects.toThrow("injected initial fsync");
  interception.beforeSync = undefined;
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toHaveLength(1);
  const [pending] = await pendingSourcePublications(workspace); expect(pending.manifest.state).toBe("staging");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  await expect(resumeSourcePublications(workspace, context)).resolves.toMatchObject({ changed: [] });
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([]);
});

it("rechecks disk headroom after all payload bytes are staged and before moving a live source inode", async () => {
  const { workspace, baseline } = await fixture(); let links = 0;
  interception.beforeWrite = async name => { if (name.endsWith("/returned/game.js")) interception.diskAvailable = 0n; };
  interception.beforeLink = async () => { links++; };
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "replacement")])).rejects.toThrow("disk headroom changed");
  expect(links).toBe(0); expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
});

it("bounds failed manifest copies and removes only its own partial temporary metadata", async () => {
  const { directory } = await fixture(), journal = path.join(directory, "journal"); await mkdir(journal);
  const manifest = { version: 2 as const, state: "staging" as const, versions: [], published: [], steps: {} };
  await initializePublicationManifest(journal, manifest); let failed = false;
  interception.beforeWrite = async (name, bytes, partial) => {
    if (!failed && path.basename(name).startsWith(".manifest-")) { failed = true; await partial(bytes.subarray(0, 5)); throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" }); }
  };
  await expect(savePublicationManifest(journal, { ...manifest, state: "committed" })).rejects.toThrow("injected partial write");
  expect(await readdir(journal)).toEqual(["manifest.json"]);
  for (const suffix of ["a", "b"]) await writeFile(path.join(journal, `.manifest-${suffix}.tmp`), "unknown previous metadata");
  await expect(savePublicationManifest(journal, manifest)).rejects.toThrow("unfinished manifest copies");
  expect(await readdir(journal)).toHaveLength(3);
});

it.each([false, true])("keeps the original promise and journal when rollback cleanup is uncertain: rollback-link=%s", async brokenRollback => {
  const { workspace, baseline, directory } = await fixture(); let sticky = false;
  if (brokenRollback) interception.beforeLink = async target => { if (target === path.join(workspace, "game.js")) throw Object.assign(new Error("injected link ENOSPC"), { code: "ENOSPC" }); };
  else interception.beforeWrite = async (name, bytes) => {
    if (!path.basename(name).startsWith(".manifest-")) return;
    const manifest = JSON.parse(Buffer.from(bytes).toString());
    if (manifest.state === "committed") sticky = true;
    if (sticky) throw Object.assign(new Error("injected journal ENOSPC"), { code: "ENOSPC" });
  };
  await expect(applySourceChanges(workspace, baseline, [file("game.js", "new result")], undefined, undefined, 0, context)).rejects.toThrow("publication stopped");
  interception.beforeWrite = undefined; interception.beforeLink = undefined;
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toHaveLength(1);
  await expect(assertSourcePublicationSettled(workspace)).rejects.toThrow("interrupted host transaction");
  const [journal] = await pendingSourcePublications(workspace);
  expect(await readFile(path.join(journal.directory, "original/game.js"), "utf8")).toBe("original");
  expect(await readFile(path.join(journal.directory, "returned/game.js"), "utf8")).toBe("new result");
  if (brokenRollback) { expect(journal.manifest.state).toBe("needs-review"); expect(await readFile(path.join(journal.directory, "before/game.js"), "utf8")).toBe("original"); }
  else expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("keeps the old version-2 reader's 32 MiB payload bound independent of the new plan", async () => {
  const { workspace, directory } = await fixture(), journal = path.join(directory, "isolated-changes/legacy"); await mkdir(journal, { recursive: true });
  await savePublicationManifest(journal, { version: 2, state: "committed", versions: [{ path: "game.js", beforeSha256: "a".repeat(64), beforeSize: 9 * 1024 * 1024, afterSha256: "b".repeat(64), afterSize: 9 * 1024 * 1024, afterMode: 0o600 }], published: ["game.js"], steps: { "game.js": "published" } });
  await expect(pendingSourcePublications(workspace)).rejects.toThrow("payload exceeds");
});

it("publishes a legal large media copy with a versioned complete plan instead of the old 32 MiB quota", async () => {
  const { workspace, directory } = await fixture(), model = Buffer.alloc(16 * 1024 * 1024); model.write("glTF"); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  await mkdir(path.join(workspace, "public")); await writeFile(path.join(workspace, "public/original.glb"), model);
  const media: RuntimeMedia[] = [], baseline = await projectFiles(workspace, media);
  const result = await applySourceChanges(workspace, baseline, [...baseline, ...media, { ...media[0]!, path: "public/copy.glb" }], undefined, media, 0, context);
  expect(createHash("sha256").update(await readFile(path.join(workspace, "public/copy.glb"))).digest("hex")).toBe(media[0]!.sha256);
  const receipt = JSON.parse(await readFile(path.join(directory, result.recovery!, "manifest.json"), "utf8"));
  expect(receipt).toMatchObject({ version: 3, state: "committed", spacePlan: { version: 1, limitBytes: RECOVERY_LIMIT_BYTES, afterBytes: model.length } });
  expect(receipt.spacePlan.requiredBytes).toBeGreaterThan(32 * 1024 * 1024);
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
});

it("publishes a large raster only from a fresh private validated artifact, without base64 or verified-copy authority", async () => {
  const { workspace, baseline, directory } = await fixture(), bytes = referencePng({ width: 1024, height: 1024, noise: true, level: 0 });
  expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
  const sha256 = createHash("sha256").update(bytes).digest("hex"), root = path.join(directory, "isolated-review-artifacts"), raw = path.join(root, "raw");
  await mkdir(root, { mode: 0o700 }); await mkdir(raw, { mode: 0o700 }); await writeFile(path.join(raw, sha256), bytes, { mode: 0o600 });
  const artifact = await validateRasterArtifact(workspace, { path: "public/frame.png", artifactPath: path.join(raw, sha256), sha256, size: bytes.length });
  await expect(applySourceChanges(workspace, baseline, baseline, undefined, [], 2, context, { rasterArtifacts: [{ ...artifact }] })).rejects.toThrow("untrusted");
  const result = await applySourceChanges(workspace, baseline, baseline, undefined, [], 2, context, { rasterArtifacts: [artifact] });
  expect(result.changed).toEqual([artifact.path]);
  expect(createHash("sha256").update(await readFile(path.join(workspace, artifact.path))).digest("hex")).toBe(sha256);
  expect(createHash("sha256").update(await readFile(path.join(raw, sha256))).digest("hex")).toBe(sha256);
});

it("keeps source-data policy 1 bounded while validating a larger policy-2 new raster and refusing policy-2 baseline-marker forgery", async () => {
  const { workspace, baseline } = await fixture(), bytes = referencePng({ width: 512, height: 512, noise: true, level: 0 }), candidate = binary("public/frame.png", bytes);
  expect(bytes.length).toBeGreaterThan(512 * 1024);
  await expect(applySourceChanges(workspace, baseline, [...baseline, candidate], undefined, [], 1, context)).rejects.toThrow("512 KiB");
  await applySourceChanges(workspace, baseline, [...baseline, candidate], undefined, [], 2, context);
  const media: RuntimeMedia[] = [], current = await projectFiles(workspace, media), bound = media.find(file => file.path === candidate.path)!;
  await expect(applySourceChanges(workspace, current, [...current, { ...candidate, rasterBaseSha256: bound.sha256 }], undefined, media, 2, context)).rejects.toThrow("Unapproved runtime media change");
});

const freshSpace = async () => { vi.resetModules(); return import("../src/daemon/recovery-space.js"); };
const smallPlan = { rawBytes: 0, workingBytes: 0, beforeBytes: 100, afterBytes: 200, manifestBytes: 1024, additionalEntries: 16 };
const owner = { ownerKey: "a".repeat(32), namespace: "test" as const, projectId: context.projectId, generation: 22, rawSnapshotId: "b".repeat(64) };

it("derives the complete 470 MiB logical worst-case plan separately from its disk promise and 1 GiB floor", async () => {
  const space = await freshSpace(), MiB = 1024 * 1024;
  const plan = space.planRecoverySpace({ rawBytes: 72 * MiB, workingBytes: 64 * MiB, beforeBytes: 72 * MiB, afterBytes: 72 * MiB, manifestBytes: 2 * MiB, reviewBytes: 8 * MiB });
  expect(plan.requiredBytes).toBe(470 * MiB); expect(plan.diskBytes).toBe(444.25 * MiB); expect(plan.entryAllocationBytes).toBe(20032 * 4096); expect(plan.entryLimit).toBe(32768); expect(plan.additionalEntries).toBe(20032);
  expect(space.RECOVERY_DISK_FLOOR_BYTES).toBe(1024 * MiB); expect(space.validRecoverySpacePlan({ ...plan, limitBytes: 1024 * MiB })).toBe(false);
});

it("bounds four complete source trees plus raw/working hashes and old history within the versioned entry envelope", async () => {
  const space = await freshSpace(), paths = [...Array.from({ length: 1999 }, (_, i) => `public/f${i}/asset.txt`), "last.txt"], tree = new Set<string>();
  for (const name of paths) { const parts = name.split("/"); for (let n = 1; n <= parts.length; n++) tree.add(parts.slice(0, n).join("/")); }
  expect(tree.size).toBe(4000); expect(paths.length).toBe(2000);
  const fourCopies = 4 * tree.size, artifacts = 2 * paths.length + 2, oldHistory = 8000, metadata = 32;
  expect(fourCopies + artifacts + oldHistory + metadata).toBeLessThan(space.RECOVERY_ENTRY_LIMIT);
  expect(space.planRecoverySpace({ ...smallPlan, additionalEntries: undefined, rawBytes: 72 * 1024 * 1024, workingBytes: 64 * 1024 * 1024 }).additionalEntries).toBeGreaterThanOrEqual(fourCopies + artifacts + metadata - 2);
});

it("accounts concurrent projects against the same volume and releases only a real owner token", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture(), plan = space.planRecoverySpace(smallPlan);
  interception.diskAvailable = BigInt(space.RECOVERY_DISK_FLOOR_BYTES + 2 * plan.diskBytes - 1);
  const lease = await space.reserveRecoverySpace(first.workspace, smallPlan, owner);
  await expect(space.reserveRecoverySpace(second.workspace, smallPlan, { ...owner, ownerKey: "c".repeat(32) })).rejects.toThrow("unreserved disk");
  expect(() => space.withRecoverySpaceReservation({ ...lease }, async () => {})).toThrow("untrusted");
  await lease.release();
  const later = await space.reserveRecoverySpace(second.workspace, smallPlan, { ...owner, ownerKey: "c".repeat(32) }); await later.release();
});

it.each([0, -1])("checks bavail including the safety floor exactly at the boundary plus %i byte", async extra => {
  const space = await freshSpace(), { workspace } = await fixture(), plan = space.planRecoverySpace(smallPlan);
  interception.diskAvailable = BigInt(space.RECOVERY_DISK_FLOOR_BYTES + plan.diskBytes + extra);
  if (extra < 0) await expect(space.reserveRecoverySpace(workspace, smallPlan, owner)).rejects.toThrow("unreserved disk");
  else { const lease = await space.reserveRecoverySpace(workspace, smallPlan, owner); await lease.release(); }
});

it("rejects invalid huge filesystem allocation units before persisting a resource promise", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(); interception.diskUnit = 2n * 1024n * 1024n;
  await expect(space.reserveRecoverySpace(workspace, smallPlan, owner)).rejects.toThrow("unsupported filesystem allocation unit");
  await expect(stat(path.join(directory, "isolated-space-reservations"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("restores unknown intents without expiring, changing owner or silently upgrading the promised plan", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture();
  const lease = await space.reserveRecoverySpace(workspace, smallPlan, owner);
  const file = path.join(directory, "isolated-space-reservations", lease.id + ".json"); expect((await stat(file)).mode & 0o777).toBe(0o600);
  space = await freshSpace(); await space.restoreRecoverySpaceReservations([workspace]);
  await expect(space.reserveRecoverySpace(workspace, smallPlan, { ...owner, ownerKey: "c".repeat(32) })).rejects.toThrow("unresolved");
  await expect(space.reserveRecoverySpace(workspace, smallPlan, { ...owner, reuse: true, rawSnapshotId: "d".repeat(64) })).rejects.toThrow("unresolved");
  const restored = await space.reserveRecoverySpace(workspace, smallPlan, { ...owner, reuse: true });
  await expect(restored.bind({ generation: 23 })).rejects.toThrow("generation or raw snapshot changed");
  await restored.release(); expect(await readdir(path.dirname(file))).toEqual([]);
});

it.each([false, true])("inspects a missing external workspace without discarding an existing promise: %s", async retained => {
  let space = await freshSpace(); const missing = await fixture(), other = await fixture();
  const lease = retained ? await space.reserveRecoverySpace(missing.workspace, smallPlan, owner) : undefined;
  await rm(missing.workspace, { recursive: true });
  space = await freshSpace();
  const restore = space.restoreRecoverySpaceReservations([missing.workspace], [missing.workspace]);
  if (retained) {
    await expect(restore).rejects.toMatchObject({ code: "ENOENT" });
    await expect(space.reserveRecoverySpace(other.workspace, smallPlan, owner)).rejects.toThrow("startup");
    expect(await readFile(path.join(missing.directory, "isolated-space-reservations", lease!.id + ".json"), "utf8")).toContain(lease!.id);
  } else {
    await restore;
    const next = await space.reserveRecoverySpace(other.workspace, smallPlan, owner); await next.release();
    await space.releaseRetiredProjectRecoverySpace(missing.workspace, { namespace: "manual", projectId: owner.projectId, sourceRetired: false, allowMissingWorkspace: true });
  }
});

it("refuses a replacement link when inspecting a missing registered workspace", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture();
  await rm(workspace, { recursive: true }); await symlink(path.join(directory, "gone"), workspace);
  await expect(space.recoveryWorkspacePath(workspace, true)).rejects.toThrow("ancestry changed");
});

it("does not reuse a reservation after removing a verified artifact deduction", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), bytes = Buffer.alloc(1024, 65), sha256 = createHash("sha256").update(bytes).digest("hex"), raw = path.join(directory, "isolated-review-artifacts/raw");
  await mkdir(raw, { recursive: true, mode: 0o700 }); await writeFile(path.join(raw, sha256), bytes, { mode: 0o600 });
  const inputs = { ...smallPlan, rawBytes: bytes.length, existingArtifacts: [{ kind: "raw" as const, sha256, size: bytes.length }] };
  const lease = await space.reserveRecoverySpace(workspace, inputs, owner); expect(lease.plan.existingRawBytes).toBe(bytes.length);
  await expect(space.reserveRecoverySpace(workspace, { ...inputs, existingArtifacts: [] }, { ...owner, reuse: true })).rejects.toThrow("does not cover");
  await lease.release();
});

it("accounts the reservation's own entry and planned additional entries before writing an intent", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture();
  await expect(space.reserveRecoverySpace(workspace, { ...smallPlan, additionalEntries: 32768 }, owner)).rejects.toThrow("capacity");
  await expect(stat(path.join(directory, "isolated-space-reservations"))).rejects.toMatchObject({ code: "ENOENT" });
  const lease = await space.reserveRecoverySpace(workspace, { ...smallPlan, additionalEntries: 32766 }, owner); await lease.release();
});

it("latches a corrupt startup reservation across other projects while permitting read-only inspection", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture();
  const lease = await space.reserveRecoverySpace(first.workspace, smallPlan, owner), file = path.join(first.directory, "isolated-space-reservations", lease.id + ".json");
  await writeFile(file, "{}"); await expect(space.restoreRecoverySpaceReservations([first.workspace])).rejects.toThrow("invalid reservation");
  await expect(space.reserveRecoverySpace(second.workspace, smallPlan, { ...owner, ownerKey: "c".repeat(32) })).rejects.toThrow("startup");
  expect(await space.inspectRecoverySpace(second.workspace)).toMatchObject({ fits: true, used: 0 });
});

const retainedContext = () => {
  // Projection of the validated readonly guest header, never a tool/model argument.
  const header = { namespace: owner.namespace, projectId: owner.projectId, generation: owner.generation, snapshotId: owner.rawSnapshotId,
    originOperations: [{ operationId: owner.ownerKey, mode: "shell", phase: "released", snapshotId: owner.rawSnapshotId, acknowledged: false }] };
  return { namespace: header.namespace, projectId: header.projectId, generation: header.generation, rawSnapshotId: header.snapshotId, originOperations: header.originOperations };
};

it("reconnects only a cold retained command promise and reuses the exact verified tuple without creating a publication", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), original = await space.reserveRecoverySpace(workspace, smallPlan, owner);
  space = await freshSpace(); await space.restoreRecoverySpaceReservations([workspace]);
  const context = retainedContext(), connected = await space.reconnectRetainedRecoverySpace(workspace, context);
  expect(connected?.id).toBe(original.id);
  expect(await space.reconnectRetainedRecoverySpace(workspace, context)).toBe(connected);
  await space.withRecoverySpaceReservation(connected!, async () => { expect(space.currentRecoverySpaceReservation(workspace)).toBe(connected); });
  await expect(stat(path.join(directory, "isolated-changes"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  await connected!.release();
});

it("fills missing generation and snapshot only after the original command is proven released in that exact raw generation", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), original = await space.reserveRecoverySpace(workspace, smallPlan, { ownerKey: owner.ownerKey, namespace: owner.namespace, projectId: owner.projectId });
  space = await freshSpace(); const connected = await space.reconnectRetainedRecoverySpace(workspace, retainedContext());
  const intent = JSON.parse(await readFile(path.join(directory, "isolated-space-reservations", original.id + ".json"), "utf8"));
  expect(intent.owner).toEqual(owner); expect(connected!.id).toBe(original.id);
  await expect(connected!.bind({ rawSnapshotId: "e".repeat(64) })).rejects.toThrow("generation or raw snapshot changed");
  await connected!.release();
});

it("returns no retained promise when none exists and refuses to take a live host token even with matching guest metadata", async () => {
  const space = await freshSpace(), { workspace } = await fixture();
  expect(await space.reconnectRetainedRecoverySpace(workspace, retainedContext())).toBeUndefined();
  const live = await space.reserveRecoverySpace(workspace, smallPlan, owner);
  await expect(space.reconnectRetainedRecoverySpace(workspace, retainedContext())).rejects.toMatchObject({ code: "RECOVERY_SPACE_REQUIRED" });
  await live.release();
});

it.each(["namespace", "project", "generation", "snapshot", "unmapped", "unfinished", "recovery-mode", "duplicate", "preprepare-unknown"])("retains a cold promise after unverifiable %s origin metadata without new ownership or publication", async fault => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), original = await space.reserveRecoverySpace(workspace, smallPlan, owner), intentPath = path.join(directory, "isolated-space-reservations", original.id + ".json"), before = await readFile(intentPath, "utf8");
  space = await freshSpace(); const projection = retainedContext();
  if (fault === "namespace") projection.namespace = "manual" as never;
  if (fault === "project") projection.projectId = "another-project";
  if (fault === "generation") projection.generation++;
  if (fault === "snapshot") { projection.rawSnapshotId = "d".repeat(64); projection.originOperations[0]!.snapshotId = projection.rawSnapshotId; }
  if (fault === "unmapped") projection.originOperations[0]!.operationId = "c".repeat(32);
  if (fault === "unfinished") projection.originOperations[0]!.phase = "finished";
  if (fault === "recovery-mode") projection.originOperations[0]!.mode = "recovery";
  if (fault === "duplicate") projection.originOperations.push({ ...projection.originOperations[0]! });
  if (fault === "preprepare-unknown") projection.originOperations = [];
  await expect(space.reconnectRetainedRecoverySpace(workspace, projection)).rejects.toMatchObject({ code: "RECOVERY_SPACE_REQUIRED" });
  expect(await readFile(intentPath, "utf8")).toBe(before);
  await expect(stat(path.join(directory, "isolated-changes"))).rejects.toMatchObject({ code: "ENOENT" });
  // Only the exact original owner can explicitly release the fixture after its denied reconnection.
  const cleanup = await space.reserveRecoverySpace(workspace, smallPlan, { ...owner, reuse: true }); await cleanup.release();
});

it("brands only a real pre-intent capacity refusal with actionable integer storage diagnostics", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), raw = path.join(directory, "isolated-review-artifacts/raw"); await mkdir(raw, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(raw, "retained"), "wx"); try { await handle.truncate(RECOVERY_LIMIT_BYTES - 1); } finally { await handle.close(); }
  const failure = await space.reserveRecoverySpace(workspace, smallPlan, owner).catch(cause => cause);
  expect(space.isRecoverySpaceInputRefusal(failure)).toBe(true);
  expect(failure.message).toContain("quotaRemainingBytes=1"); expect(failure.message).toMatch(/quotaRequiredBytes=\d+, quotaRemainingBytes=\d+, quotaLimitBytes=\d+/);
  expect(failure.message).toMatch(/entriesRequired=\d+, entriesUsed=\d+, entryLimit=\d+/);
  expect(failure.message).toMatch(/bavailBytes=\d+, outstandingBytes=\d+, floorBytes=\d+/);
  expect(failure.message).not.toContain(directory); expect(failure.message).not.toContain(workspace);
  expect(space.isRecoverySpaceInputRefusal({ code: failure.code, message: failure.message, isRecoverySpaceInputRefusal: true })).toBe(false);
  expect(space.isRecoverySpaceInputRefusal(new Error(failure.message))).toBe(false);
  expect(space.isRecoverySpaceInputRefusal(JSON.parse(JSON.stringify(failure)))).toBe(false);
  await expect(stat(path.join(directory, "isolated-space-reservations"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("brands a real pre-intent disk refusal while preserving zero intent writes", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(); interception.diskAvailable = 0n;
  const failure = await space.reserveRecoverySpace(workspace, smallPlan, owner).catch(cause => cause);
  expect(space.isRecoverySpaceInputRefusal(failure)).toBe(true); expect(failure.message).toContain("bavailBytes=0"); expect(failure.message).toContain("floorBytes=1073741824");
  expect(failure.message).toMatch(/diskRequiredBytes=\d+/); expect(failure.message).not.toContain(directory);
  await expect(stat(path.join(directory, "isolated-space-reservations"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["unknown", "permission", "write", "fsync"])("does not brand %s reservation failure as a known unsubmitted storage-budget rejection", async fault => {
  let space = await freshSpace(); const { workspace, directory } = await fixture();
  let failure: unknown;
  if (fault === "unknown") {
    const lease = await space.reserveRecoverySpace(workspace, smallPlan, owner);
    await writeFile(path.join(directory, "isolated-space-reservations", lease.id + ".json"), "{}");
    space = await freshSpace(); failure = await space.reserveRecoverySpace(workspace, smallPlan, owner).catch(cause => cause);
  } else {
    if (fault === "fsync") interception.beforeSync = async name => { if (path.basename(name).startsWith(".intent-")) throw Object.assign(new Error("injected intent fsync"), { code: "EIO" }); };
    else interception.beforeWrite = async name => { if (path.basename(name).startsWith(".intent-")) throw Object.assign(new Error("injected intent write"), { code: fault === "permission" ? "EACCES" : "ENOSPC" }); };
    failure = await space.reserveRecoverySpace(workspace, smallPlan, owner).catch(cause => cause);
  }
  expect(failure).toBeInstanceOf(Error); expect(space.isRecoverySpaceInputRefusal(failure)).toBe(false);
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("inspects empty recovery capacity with real statfs without creating roots, changing files or granting admission", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), before = await readdir(directory), workspaceBefore = await stat(workspace), disk = await statfs(workspace, { bigint: true });
  interception.beforeWrite = async () => { throw new Error("readonly inspection attempted a write"); };
  const result = await space.inspectRecoveryCapacity(workspace);
  expect(result).toMatchObject({ version: 1, status: "complete", localImageStorage: "not-supplied", quota: { scope: "shared-history-and-active", limitBytes: RECOVERY_LIMIT_BYTES, usedBytes: 0, remainingBytes: RECOVERY_LIMIT_BYTES, entries: 0, transactions: 0 }, filesystem: { status: "complete", allocationUnitBytes: Math.max(4096, Number(disk.bsize)), floorBytes: space.RECOVERY_DISK_FLOOR_BYTES }, promises: { ledger: "known", own: { count: 0, logicalBytes: 0, diskBytes: 0 }, sameDevice: { count: 0, logicalBytes: 0, diskBytes: 0 } } });
  expect(result.filesystem.availableBytes).toBeGreaterThan(0);
  expect(result).not.toHaveProperty("fits"); expect(result).not.toHaveProperty("recoverable");
  expect(result.issues).toEqual([]); expect(await readdir(directory)).toEqual(before);
  const after = await stat(workspace); expect([after.ino, after.mode, after.mtimeMs, after.ctimeMs]).toEqual([workspaceBefore.ino, workspaceBefore.mode, workspaceBefore.mtimeMs, workspaceBefore.ctimeMs]);
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
});

it("counts source history, transfers and an unregistered local image anchor in one shared quota without registering it", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), anchor = { workspace, projectId: context.projectId, storage: path.join(directory, "data/image-recovery", context.projectId) };
  const rows = [
    ["isolated-changes/transaction/manifest.json", 11], ["isolated-review-artifacts/raw/original", 13], ["isolated-source-transfers/incoming/image", 17], ["isolated-reviews/review.json", 19],
  ] as const;
  for (const [name, size] of rows) { const target = path.join(directory, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, Buffer.alloc(size), { mode: 0o600 }); }
  for (const [name, size] of [["image-originals/raw.png", 23], ["image-preparations/working.png", 29], ["image-transactions/transaction/manifest.json", 31]] as const) { const target = path.join(anchor.storage, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, Buffer.alloc(size), { mode: 0o600 }); }
  const before = await readdir(directory), result = await space.inspectRecoveryCapacity(workspace, anchor);
  expect(result.status).toBe("complete"); expect(result.localImageStorage).toBe("included");
  expect(result.quota).toMatchObject({ usedBytes: 143, remainingBytes: RECOVERY_LIMIT_BYTES - 143, entries: 11, transactions: 2 });
  expect(result.breakdown["image-originals"]).toEqual({ status: "complete", logicalBytes: 23, entries: 1, transactions: 0 });
  expect(result.breakdown["isolated-source-transfers"]).toEqual({ status: "complete", logicalBytes: 17, entries: 2, transactions: 0 });
  expect(await readdir(directory)).toEqual(before);
  expect((await space.inspectRecoverySpace(workspace)).used).toBe(60);
  expect(JSON.stringify(result)).not.toContain(directory); expect(JSON.stringify(result)).not.toContain(context.projectId);
});

it("reports own durable promises and aggregate same-device promises without exposing another project's identity", async () => {
  let space = await freshSpace(); const first = await fixture(), second = await fixture(), plan = space.planRecoverySpace(smallPlan);
  const firstLease = await space.reserveRecoverySpace(first.workspace, smallPlan, owner), secondLease = await space.reserveRecoverySpace(second.workspace, smallPlan, { ...owner, projectId: "other-project", ownerKey: "c".repeat(32) });
  const before = await readFile(path.join(first.directory, "isolated-space-reservations", firstLease.id + ".json"), "utf8"), result = await space.inspectRecoveryCapacity(first.workspace);
  expect(result).toMatchObject({ status: "complete", promises: { ledger: "known", coverage: "known-ledger-and-inspected-project", own: { count: 1, logicalBytes: plan.requiredBytes, diskBytes: plan.diskBytes }, sameDevice: { count: 2, logicalBytes: 2 * plan.requiredBytes, diskBytes: 2 * plan.diskBytes } } });
  for (const hidden of [first.directory, second.directory, owner.projectId, "other-project", owner.ownerKey, firstLease.id, secondLease.id]) expect(JSON.stringify(result)).not.toContain(hidden);
  expect(await readFile(path.join(first.directory, "isolated-space-reservations", firstLease.id + ".json"), "utf8")).toBe(before);
  // A cold diagnostic reads the real private intent, without restoring or claiming it.
  space = await freshSpace(); const cold = await space.inspectRecoveryCapacity(first.workspace);
  expect(cold.promises).toMatchObject({ ledger: "known", own: { count: 1 }, sameDevice: { count: 1 } });
  const original = await space.reserveRecoverySpace(first.workspace, smallPlan, { ...owner, reuse: true }); await original.release();
});

it("reads an unregistered local image intent while keeping a diagnostic read separate from anchor registration", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), anchor = { workspace, projectId: context.projectId, storage: path.join(directory, "data/image-recovery", context.projectId) };
  await mkdir(path.join(directory, "data"), { mode: 0o700 });
  const lease = await space.reserveLocalImageRecoverySpace(anchor, smallPlan, { ownerKey: owner.ownerKey }), intent = path.join(anchor.storage, "space-reservations", lease.id + ".json"), before = await readFile(intent, "utf8");
  space = await freshSpace(); const result = await space.inspectRecoveryCapacity(workspace, anchor);
  expect(result).toMatchObject({ status: "complete", localImageStorage: "included", promises: { ledger: "known", own: { count: 1 }, sameDevice: { count: 1 } } });
  expect(result.quota.usedBytes).toBe(Buffer.byteLength(before));
  expect((await space.inspectRecoverySpace(workspace)).used).toBe(0);
  expect(await readFile(intent, "utf8")).toBe(before);
});

it("reports corrupt own metadata as uncertain rather than zero and does not repair or latch a diagnostic read", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), lease = await space.reserveRecoverySpace(workspace, smallPlan, owner), target = path.join(directory, "isolated-space-reservations", lease.id + ".json"); await writeFile(target, "{}");
  space = await freshSpace(); const result = await space.inspectRecoveryCapacity(workspace);
  expect(result).toMatchObject({ status: "incomplete", quota: { usedBytes: 2 }, promises: { ledger: "uncertain", own: { count: null, logicalBytes: null, diskBytes: null }, sameDevice: { count: null, logicalBytes: null, diskBytes: null } } });
  expect(result.issues).toContainEqual({ code: "invalid-intent", scope: "isolated-space-reservations" });
  expect(await readFile(target, "utf8")).toBe("{}"); expect(await readdir(path.dirname(target))).toEqual([lease.id + ".json"]);
});

it("preserves a globally uncertain ledger in a clean project's readonly capacity result", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture(), lease = await space.reserveRecoverySpace(first.workspace, smallPlan, owner); await writeFile(path.join(first.directory, "isolated-space-reservations", lease.id + ".json"), "{}");
  await expect(space.restoreRecoverySpaceReservations([first.workspace])).rejects.toThrow();
  const result = await space.inspectRecoveryCapacity(second.workspace);
  expect(result).toMatchObject({ status: "incomplete", quota: { usedBytes: 0 }, promises: { ledger: "uncertain", sameDevice: { count: null, logicalBytes: null, diskBytes: null } } });
  expect(result.issues).toContainEqual({ code: "ledger-uncertain", scope: "ledger" });
});

it("does not label another project's memory-only failed intent as a known durable promise", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture();
  interception.beforeWrite = async target => { if (path.basename(target).startsWith(".intent-")) throw Object.assign(new Error("injected write failure"), { code: "ENOSPC" }); };
  await expect(space.reserveRecoverySpace(first.workspace, smallPlan, owner)).rejects.toMatchObject({ code: "ENOSPC" });
  interception.beforeWrite = undefined;
  const result = await space.inspectRecoveryCapacity(second.workspace);
  expect(result).toMatchObject({ status: "incomplete", quota: { usedBytes: 0 }, promises: { ledger: "uncertain", sameDevice: { count: null, logicalBytes: null, diskBytes: null } } });
  expect(JSON.stringify(result)).not.toContain(first.directory);
});

it.each(["symbolic", "hard"])("does not follow or count a %s linked artifact as complete storage", async kind => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), root = path.join(directory, "isolated-review-artifacts"); await mkdir(root, { mode: 0o700 });
  if (kind === "symbolic") await symlink(path.join(workspace, "game.js"), path.join(root, "linked")); else await link(path.join(workspace, "game.js"), path.join(root, "linked"));
  const result = await space.inspectRecoveryCapacity(workspace);
  expect(result).toMatchObject({ status: "incomplete", quota: { usedBytes: null, remainingBytes: null, entries: null }, breakdown: { "isolated-review-artifacts": { status: "incomplete", logicalBytes: null } } });
  expect(result.issues).toContainEqual({ code: "unsafe-storage", scope: "isolated-review-artifacts" });
  expect(JSON.stringify(result)).not.toContain(directory);
});

it("marks a changing scan incomplete instead of publishing a mixed-age capacity total", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), root = path.join(directory, "isolated-reviews"); await mkdir(root, { mode: 0o700 }); await writeFile(path.join(root, "before"), "before");
  interception.beforeOpenDirectory = async target => { if (target === root) { interception.beforeOpenDirectory = undefined; await writeFile(path.join(root, "during"), "during"); } };
  const result = await space.inspectRecoveryCapacity(workspace);
  expect(result.status).toBe("incomplete"); expect(result.quota.usedBytes).toBeNull(); expect(result.promises.ledger).toBe("uncertain");
  expect(result.issues.some(issue => issue.code === "changed")).toBe(true);
});

it.each(["already", "during"])("cancels a %s readonly capacity inspection without creating promises or storage", async when => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), before = await readdir(directory), controller = new AbortController();
  if (when === "already") controller.abort(); else interception.beforeStatfs = () => controller.abort();
  await expect(space.inspectRecoveryCapacity(workspace, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(directory)).toEqual(before);
});

it.each(["unavailable", "invalid-unit"])("keeps %s filesystem capacity unknown without leaking the original error", async fault => {
  const space = await freshSpace(), { workspace, directory } = await fixture();
  if (fault === "unavailable") interception.beforeStatfs = () => { throw new Error("private-path-canary " + directory); }; else interception.diskUnit = 2n * 1024n * 1024n;
  const result = await space.inspectRecoveryCapacity(workspace);
  expect(result).toMatchObject({ status: "incomplete", quota: { usedBytes: 0 }, filesystem: { status: "incomplete", availableBytes: null, allocationUnitBytes: null } });
  expect(JSON.stringify(result)).not.toContain(directory); expect(JSON.stringify(result)).not.toContain("private-path-canary");
});

const manifestEntry = (name: string, values: Partial<SourceManifestEntryV1> = {}): SourceManifestEntryV1 => ({ path: name, kind: "source", size: 1, sha256: "a".repeat(64), executable: false, ...values });
const unicodeManifestEntries = () => [
  manifestEntry("src/雪😀.js", { size: 0 }),
  manifestEntry("public/é.png", { kind: "media", size: 7, sha256: "b".repeat(64) }),
  manifestEntry("src/\uE000.js", { size: 3, sha256: "c".repeat(64), executable: true }),
  manifestEntry("src/😀.js", { size: 5, sha256: "d".repeat(64) }),
];

it("matches the cross-language ASCII manifest and delta fixture including Unicode code-point ordering", () => {
  const entries = unicodeManifestEntries(), before = createSourceManifest(entries), after = createSourceManifest([entries[0]!, { ...entries[1]!, size: 1, sha256: "e".repeat(64) }, { ...entries[2]!, executable: false }, { ...entries[3]!, path: "src/copy.js" }]);
  expect(before.files.map(file => file.path)).toEqual(["public/é.png", "src/雪😀.js", "src/\uE000.js", "src/😀.js"]);
  expect(canonicalSourceManifestRows(before.files)).toMatch(/^[\x00-\x7f]*$/);
  expect(canonicalSourceManifestRows(before.files)).toContain("\\ud83d\\ude00");
  expect(before.manifestId).toBe("d853f7b0eebe50837f1f8cc6a1ae6269f6e8000b481edfba8d7447f5607ac404");
  expect(after.manifestId).toBe("d02fa4bc695f72e1a1cfdd7ac409370f7dd4b4365680cc6794ae11c5281b15bd");
  const delta = planSourceDelta(before, after);
  expect(delta.summary).toEqual({ version: 1, beforeManifestId: before.manifestId, afterManifestId: after.manifestId, addedFiles: 1, modifiedFiles: 2, removedFiles: 1, unchangedFiles: 1, beforeSourceBytes: 8, beforeMediaBytes: 7, afterSourceBytes: 8, afterMediaBytes: 1, beforeBytes: 15, afterBytes: 9 });
  expect(() => assertSourceDeltaSummary(delta.summary, before, after)).not.toThrow();
  expect(parseSourceManifest(JSON.parse(JSON.stringify(before)))).toEqual(before);
  expect(Object.isFrozen(before.files)).toBe(true); expect(Object.isFrozen(before.files[0])).toBe(true);
});

it.each(["extra", "id", "version", "profile", "permissions", "entry-extra", "duplicate", "ancestor", "private", "generated", "media-codepath", "unpaired", "nonboolean", "fractional", "negative", "media-zero", "media-executable"])("rejects a %s malformed manifest before it can become a delta or publication", fault => {
  const value = JSON.parse(JSON.stringify(createSourceManifest([manifestEntry("game.js")]))) as Record<string, any>;
  if (fault === "extra") value.untrusted = true;
  if (fault === "id") value.manifestId = "b".repeat(64);
  if (fault === "version") value.version = 2;
  if (fault === "profile") value.profile = "future-256";
  if (fault === "permissions") value.permissionSemantics = "full-mode";
  if (fault === "entry-extra") value.files[0].data = "";
  if (fault === "duplicate") value.files.push(value.files[0]);
  if (fault === "ancestor") value.files.push(manifestEntry("game.js/child"));
  if (fault === "private") value.files[0].path = ".env";
  if (fault === "generated") value.files[0].path = "src/node_modules/untrusted.js";
  if (fault === "media-codepath") Object.assign(value.files[0], { kind: "media", path: "src/untrusted.js" });
  if (fault === "unpaired") value.files[0].path = "src/\uD800.js";
  if (fault === "nonboolean") value.files[0].executable = 1;
  if (fault === "fractional") value.files[0].size = 0.5;
  if (fault === "negative") value.files[0].size = -1;
  if (fault === "media-zero") Object.assign(value.files[0], { kind: "media", size: 0 });
  if (fault === "media-executable") Object.assign(value.files[0], { kind: "media", executable: true });
  expect(() => parseSourceManifest(value)).toThrow("Invalid versioned");
});

it("keeps the current manifest count and separate 2/8 and 32/64 MiB budgets exact without enabling future profiles", () => {
  const MiB = 1024 * 1024, sources = Array.from({ length: 4 }, (_, i) => manifestEntry(`s${i}`, { size: 2 * MiB })), media = Array.from({ length: 2 }, (_, i) => manifestEntry(`public/m${i}.png`, { kind: "media", size: 32 * MiB }));
  expect(createSourceManifest([...sources, ...media]).profile).toBe("current-64");
  expect(() => createSourceManifest([...sources, manifestEntry("extra")])).toThrow();
  expect(() => createSourceManifest([manifestEntry("large", { size: 2 * MiB + 1 })])).toThrow();
  expect(() => createSourceManifest([...media, manifestEntry("public/extra.png", { kind: "media" })])).toThrow();
  expect(() => createSourceManifest([manifestEntry("public/large.png", { kind: "media", size: 32 * MiB + 1 })])).toThrow();
  expect(createSourceManifest(Array.from({ length: 2000 }, (_, i) => manifestEntry(`p${i}`, { size: 0 }))).files).toHaveLength(2000);
  expect(() => createSourceManifest(Array.from({ length: 2001 }, (_, i) => manifestEntry(`p${i}`, { size: 0 })))).toThrow();
});

it("counts a large before independently of a tiny after, and counts same-digest new paths as physical additions", () => {
  const original = manifestEntry("public/large.png", { kind: "media", size: 32 * 1024 * 1024 }), before = createSourceManifest([original]), after = createSourceManifest([{ ...original, size: 1, sha256: "b".repeat(64) }, { ...original, path: "public/copy.png" }]);
  const delta = planSourceDelta(before, after);
  expect(delta.summary).toMatchObject({ modifiedFiles: 1, addedFiles: 1, beforeBytes: 32 * 1024 * 1024, afterBytes: 32 * 1024 * 1024 + 1 });
  expect(() => assertSourceDeltaSummary({ ...delta.summary, beforeBytes: 1 }, before, after)).toThrow();
  expect(() => assertSourceDeltaSummary({ ...delta.summary, addedFiles: 0 }, before, after)).toThrow();
  expect(() => assertSourceDeltaSummary({ ...delta.summary, paths: [] }, before, after)).toThrow();
});

it("describes removals and executable-only changes without authorizing deletion or changing whole-manifest identity", () => {
  const entry = manifestEntry("code.js"), before = createSourceManifest([entry]), after = createSourceManifest([{ ...entry, executable: true }]);
  expect(planSourceDelta(before, after).summary).toMatchObject({ modifiedFiles: 1, beforeBytes: 1, afterBytes: 1 });
  expect(planSourceDelta(before, createSourceManifest([])).summary).toMatchObject({ removedFiles: 1, beforeBytes: 1, afterBytes: 0 });
  expect(() => parseSourceContract({ version: 1, baseManifestId: before.manifestId, rawManifestId: after.manifestId, extra: true })).toThrow();
  expect(() => parseSourceContract({ version: 1, baseManifestId: before.manifestId, rawManifestId: after.manifestId, preparedManifestId: undefined })).toThrow();
});

const sourceOnlyManifest = (files: readonly TransferFile[]) => createSourceManifest(files.map(file => ({ path: file.path, kind: "source", size: Buffer.byteLength(file.data, "base64"), sha256: file.sha256, executable: file.executable === true })));
const sourceContext = (base: readonly TransferFile[], raw: readonly TransferFile[]): PublicationContext => ({ ...context, sourceContract: { version: 1, baseManifestId: sourceOnlyManifest(base).manifestId, rawManifestId: sourceOnlyManifest(raw).manifestId, preparedManifestId: sourceOnlyManifest(raw).manifestId } });

it("journals the real host-to-merged publication delta separately from guest base/raw/prepared identity", async () => {
  const { workspace, directory } = await fixture();
  await writeFile(path.join(workspace, "game.js"), "x".repeat(2 * 1024 * 1024));
  await writeFile(path.join(workspace, "notes.txt"), "current host edit");
  const baseline = await projectFiles(workspace), returned = [file("game.js", "y"), baseline.find(file => file.path === "notes.txt")!], guestBase = [baseline.find(file => file.path === "game.js")!, file("notes.txt", "old guest baseline")], guestRaw = [file("game.js", "y"), guestBase[1]!], bound = sourceContext(guestBase, guestRaw);
  const result = await applySourceChanges(workspace, baseline, returned, undefined, [], 0, bound), journal = JSON.parse(await readFile(path.join(directory, result.recovery!, "manifest.json"), "utf8"));
  expect(journal.version).toBe(4); expect(journal.context.sourceContract).toEqual(bound.sourceContract);
  expect(journal.publicationBefore.manifestId).not.toBe(bound.sourceContract!.baseManifestId);
  expect(journal.publicationAfter.manifestId).not.toBe(bound.sourceContract!.preparedManifestId);
  expect(journal.publicationDelta).toMatchObject({ addedFiles: 0, modifiedFiles: 1, removedFiles: 0, unchangedFiles: 1, beforeBytes: 2 * 1024 * 1024, afterBytes: 1 });
  expect(journal.spacePlan.beforeBytes).toBe(2 * 1024 * 1024); expect(journal.spacePlan.afterBytes).toBe(1);
  expect(journal.versions.map((file: { path: string }) => file.path)).toEqual(["game.js"]);
  expect(await readFile(path.join(directory, result.recovery!, "original/game.js"), "utf8")).toBe("x".repeat(2 * 1024 * 1024));
  await expect(readFile(path.join(directory, result.recovery!, "original/notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("current host edit");
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
  expect(await retainedPublicationOriginal(workspace, bound, "game.js", baseline.find(file => file.path === "game.js")!.sha256, returned[0]!.sha256)).toHaveLength(2 * 1024 * 1024);
  await expect(retainedPublicationOriginal(workspace, context, "game.js", baseline[0]!.sha256, returned[0]!.sha256)).rejects.toThrow("no matching committed receipt");
});

async function pendingContractPublication() {
  const fixtureValue = await fixture(), returned = [file("game.js", "new result")], bound = sourceContext(fixtureValue.baseline, returned); let sticky = false;
  interception.beforeWrite = async (name, bytes) => { if (!path.basename(name).startsWith(".manifest-")) return; const value = JSON.parse(Buffer.from(bytes).toString()); if (value.state === "committed") sticky = true; if (sticky) throw Object.assign(new Error("injected host journal ENOSPC"), { code: "ENOSPC" }); };
  await expect(applySourceChanges(fixtureValue.workspace, fixtureValue.baseline, returned, undefined, [], 0, bound)).rejects.toThrow("publication stopped");
  interception.beforeWrite = undefined;
  const [pending] = await pendingSourcePublications(fixtureValue.workspace);
  expect(pending.manifest.version).toBe(4);
  return { ...fixtureValue, bound, returned, pending };
}

async function crashedContractPublication() {
  const fixtureValue = await fixture(), returned = [file("game.js", "guest"), file("new.js", "added")], bound = sourceContext(fixtureValue.baseline, returned);
  const child = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/isolated-publication-crash.ts", fixtureValue.workspace, JSON.stringify(bound)], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
  expect(child.status, child.stderr).toBe(42);
  const [pending] = await pendingSourcePublications(fixtureValue.workspace);
  expect(pending.manifest.version).toBe(4);
  return { ...fixtureValue, bound, returned, pending };
}

it("resumes a v4 pending publication only with its exact source contract and original reservation", async () => {
  const { workspace, directory, bound, pending } = await crashedContractPublication(), intentBefore = await readdir(path.join(directory, "isolated-space-reservations"));
  expect(intentBefore).toEqual([pending.manifest.reservationId + ".json"]);
  for (const key of ["baseManifestId", "rawManifestId", "preparedManifestId"] as const) {
    const mismatched = { ...bound, sourceContract: { ...bound.sourceContract!, [key]: "f".repeat(64) } };
    expect(samePublicationContext(bound, mismatched)).toBe(false);
    await expect(resumeSourcePublications(workspace, mismatched)).rejects.toThrow("differ");
  }
  await expect(resumeSourcePublications(workspace, context)).rejects.toThrow("differ");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual(intentBefore);
  expect(await readFile(path.join(pending.directory, "original/game.js"), "utf8")).toBe("original");
  await expect(resumeSourcePublications(workspace, bound)).resolves.toMatchObject({ changed: ["game.js", "new.js"] });
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("guest");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([]);
});

it.each(["before-id", "after-id", "delta-before", "delta-count", "delta-extra", "version-size", "version-hash", "downgrade", "contract-extra"])("retains a v4 publication after %s metadata corruption instead of accepting its claimed delta", async fault => {
  const { workspace, directory, bound, pending } = await pendingContractPublication(), target = path.join(pending.directory, "manifest.json"), value = JSON.parse(await readFile(target, "utf8"));
  if (fault === "before-id") value.publicationBefore.manifestId = "f".repeat(64);
  if (fault === "after-id") value.publicationAfter.manifestId = "f".repeat(64);
  if (fault === "delta-before") value.publicationDelta.beforeBytes = 0;
  if (fault === "delta-count") value.publicationDelta.modifiedFiles = 0;
  if (fault === "delta-extra") value.publicationDelta.paths = [];
  if (fault === "version-size") value.versions[0].beforeSize = 0;
  if (fault === "version-hash") value.versions[0].beforeSha256 = "f".repeat(64);
  if (fault === "downgrade") value.version = 3;
  if (fault === "contract-extra") value.context.sourceContract.extra = true;
  await writeFile(target, JSON.stringify(value));
  await expect(resumeSourcePublications(workspace, bound)).rejects.toThrow();
  await expect(assertSourcePublicationSettled(workspace)).rejects.toThrow();
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toHaveLength(1);
  expect(await readFile(path.join(pending.directory, "original/game.js"), "utf8")).toBe("original");
  expect(await readFile(path.join(pending.directory, "returned/game.js"), "utf8")).toBe("new result");
});

it("rejects full v4 publication metadata beyond 2 MiB before creating any journal or changing a live file", async () => {
  const { workspace, directory, baseline } = await fixture(), prefix = Array.from({ length: 9 }, () => "a".repeat(90)).join("/"), returned = [...baseline, ...Array.from({ length: 1300 }, (_, index) => file(prefix + `/f${index}.js`, ""))];
  await expect(applySourceChanges(workspace, baseline, returned, undefined, [], 0, sourceContext(baseline, returned))).rejects.toThrow("metadata exceeds its bound");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  await expect(stat(path.join(directory, "isolated-changes"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(directory, "isolated-space-reservations"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps v4 originals and a known pending receipt after a simulated host-full/rollback-unknown failure", async () => {
  const { workspace, directory, bound, pending } = await pendingContractPublication();
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  expect(await readFile(path.join(pending.directory, "returned/game.js"), "utf8")).toBe("new result");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toHaveLength(1);
  await expect(assertSourcePublicationSettled(workspace)).rejects.toThrow("interrupted host transaction");
  await expect(resumeSourcePublications(workspace, bound)).rejects.toThrow("uncertain");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toHaveLength(1);
});

it("reconstructs compact legacy baseline sizes only in canonical Unicode order with exact media sizes", () => {
  const entries = unicodeManifestEntries(), legacy = entries.map(entry => ({ path: entry.path, sha256: entry.sha256, executable: entry.executable, ...(entry.kind === "media" ? { size: entry.size } : {}) })), expected = createSourceManifest(entries), sizes = expected.files.map(file => file.size);
  expect(sourceManifestFromLegacyBaseline(legacy, sizes)).toEqual(expected);
  expect(() => sourceManifestFromLegacyBaseline(legacy, sizes.slice(1))).toThrow();
  expect(() => sourceManifestFromLegacyBaseline(legacy, [...sizes, 1])).toThrow();
  expect(() => sourceManifestFromLegacyBaseline(legacy, [8, ...sizes.slice(1)])).toThrow();
  expect(() => sourceManifestFromLegacyBaseline(legacy, [sizes[0]!, sizes[1]!, 5, 3])).not.toThrow(); // Positional source sizes require the caller's trusted stored commitment.
  const shifted = sourceManifestFromLegacyBaseline(legacy, [sizes[0]!, sizes[1]!, 5, 3]);
  expect(shifted.manifestId).not.toBe(expected.manifestId);
  expect(() => sourceManifestFromLegacyBaseline(legacy, sizes.map((size, index) => index === 1 ? -1 : size))).toThrow();
});

const manifestOwner = () => ({ ...owner, sourceManifestVersion: 1 as const, sourceBaseManifestId: "c".repeat(64), sourceResultManifestId: "d".repeat(64) });

it("writes V1 source promises as intent version 2 and binds the captured result only once", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), { sourceResultManifestId, ...unsettled } = manifestOwner(), lease = await space.reserveRecoverySpace(workspace, smallPlan, unsettled), target = path.join(directory, "isolated-space-reservations", lease.id + ".json");
  expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({ version: 2, owner: unsettled });
  await lease.bind({ sourceResultManifestId });
  const before = await readFile(target, "utf8");
  expect(JSON.parse(before).owner).toEqual(manifestOwner());
  for (const binding of [{ sourceManifestVersion: undefined }, { sourceBaseManifestId: "e".repeat(64) }, { sourceResultManifestId: "e".repeat(64) }, { projectId: "foreign-project" }]) await expect(lease.bind(binding as never)).rejects.toThrow("changed");
  expect(await readFile(target, "utf8")).toBe(before);
  expect((await space.inspectRecoveryCapacity(workspace)).promises.own.count).toBe(1);
  await lease.release();
});

it("does not bind a result manifest before its source operation generation/raw snapshot is bound", async () => {
  const space = await freshSpace(), { workspace } = await fixture(), lease = await space.reserveRecoverySpace(workspace, smallPlan, { ownerKey: owner.ownerKey, namespace: owner.namespace, projectId: owner.projectId, sourceManifestVersion: 1, sourceBaseManifestId: "c".repeat(64) });
  await expect(lease.bind({ sourceResultManifestId: "d".repeat(64) })).rejects.toThrow("changed");
  await lease.bind({ generation: owner.generation, rawSnapshotId: owner.rawSnapshotId, sourceResultManifestId: "d".repeat(64) });
  await lease.release();
});

it("never upgrades a legacy promise to the new source identity or reuses a V1 promise under a legacy owner", async () => {
  const space = await freshSpace(), first = await fixture(), legacy = await space.reserveRecoverySpace(first.workspace, smallPlan, owner);
  await expect(legacy.bind({ sourceManifestVersion: 1, sourceBaseManifestId: "c".repeat(64) })).rejects.toThrow("changed");
  await expect(space.reserveRecoverySpace(first.workspace, smallPlan, { ...manifestOwner(), reuse: true })).rejects.toThrow("unresolved");
  await legacy.release();
  const v1 = await space.reserveRecoverySpace(first.workspace, smallPlan, manifestOwner());
  await expect(space.reserveRecoverySpace(first.workspace, smallPlan, { ...owner, reuse: true })).rejects.toThrow("unresolved");
  await v1.release();
});

it("reconnects a cold V1 promise only through the original released operation and its exact manifest tuple", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), lease = await space.reserveRecoverySpace(workspace, smallPlan, manifestOwner()), before = await readFile(path.join(directory, "isolated-space-reservations", lease.id + ".json"), "utf8");
  space = await freshSpace(); await space.restoreRecoverySpaceReservations([workspace]);
  for (const fields of [{}, { sourceManifestVersion: 1, sourceBaseManifestId: "e".repeat(64), sourceResultManifestId: "d".repeat(64) }, { sourceManifestVersion: 1, sourceBaseManifestId: "c".repeat(64), sourceResultManifestId: "e".repeat(64) }]) await expect(space.reconnectRetainedRecoverySpace(workspace, { ...retainedContext(), ...fields } as never)).rejects.toThrow();
  expect(await readFile(path.join(directory, "isolated-space-reservations", lease.id + ".json"), "utf8")).toBe(before);
  const tuple = { sourceManifestVersion: 1 as const, sourceBaseManifestId: "c".repeat(64), sourceResultManifestId: "d".repeat(64) }, connected = await space.reconnectRetainedRecoverySpace(workspace, { ...retainedContext(), ...tuple });
  expect(connected!.id).toBe(lease.id);
  expect(await space.reconnectRetainedRecoverySpace(workspace, { ...retainedContext(), ...tuple })).toBe(connected);
  await connected!.release();
});

it("keeps a cold V1 promise with an unbound result unknown rather than guessing from later guest metadata", async () => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), { sourceResultManifestId: ignored, ...unsettled } = manifestOwner(), lease = await space.reserveRecoverySpace(workspace, smallPlan, unsettled), target = path.join(directory, "isolated-space-reservations", lease.id + ".json"), before = await readFile(target, "utf8");
  space = await freshSpace();
  await expect(space.reconnectRetainedRecoverySpace(workspace, { ...retainedContext(), sourceManifestVersion: 1, sourceBaseManifestId: "c".repeat(64), sourceResultManifestId: "d".repeat(64) })).rejects.toThrow("does not establish");
  expect(await readFile(target, "utf8")).toBe(before);
});

it.each(["legacy-as-v2", "v1-as-v1"])("rejects an intent %s format downgrade without discarding its promise", async fault => {
  let space = await freshSpace(); const { workspace, directory } = await fixture(), lease = await space.reserveRecoverySpace(workspace, smallPlan, fault === "legacy-as-v2" ? owner : manifestOwner()), target = path.join(directory, "isolated-space-reservations", lease.id + ".json"), value = JSON.parse(await readFile(target, "utf8"));
  value.version = fault === "legacy-as-v2" ? 2 : 1; await writeFile(target, JSON.stringify(value));
  space = await freshSpace(); await expect(space.restoreRecoverySpaceReservations([workspace])).rejects.toThrow("invalid reservation");
  expect((await space.inspectRecoveryCapacity(workspace)).promises.ledger).toBe("uncertain");
});

it("requires the exact V1 base/result identity when reconnecting a publication's original disk promise", async () => {
  const space = await freshSpace(), { workspace } = await fixture(), lease = await space.reserveRecoverySpace(workspace, smallPlan, manifestOwner()), bound = { ...context, generation: owner.generation, sourceContract: { version: 1 as const, baseManifestId: "c".repeat(64), rawManifestId: "d".repeat(64) } };
  await expect(space.reservationForPublication(workspace, lease.id, { ...context, generation: owner.generation })).rejects.toThrow("exactly bound");
  await expect(space.reservationForPublication(workspace, lease.id, { ...bound, sourceContract: { ...bound.sourceContract, rawManifestId: "e".repeat(64) } })).rejects.toThrow("exactly bound");
  expect((await space.reservationForPublication(workspace, lease.id, bound)).id).toBe(lease.id);
  await lease.release();
});

it("records an exact versioned no-op target without claiming a file write or omitting the full publication manifests", async () => {
  const space = await freshSpace(), { workspace, directory, baseline } = await fixture(), bound = sourceContext(baseline, baseline), snapshot = sourceOnlyManifest(baseline), metadata = sourcePublicationMetadata(bound, snapshot, snapshot), plan = { ...smallPlan, beforeBytes: 0, afterBytes: 0, manifestBytes: 16384 }, lease = await space.reserveRecoverySpace(workspace, plan, { ...owner, generation: context.generation, sourceManifestVersion: 1, sourceBaseManifestId: bound.sourceContract!.baseManifestId, sourceResultManifestId: bound.sourceContract!.rawManifestId });
  const root = path.join(directory, "isolated-changes/no-op"); await mkdir(root, { recursive: true, mode: 0o700 });
  await savePublicationManifest(root, { ...metadata, state: "committed", versions: [], steps: {}, published: [], spacePlan: lease.plan, reservationId: lease.id });
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
  const stored = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  expect(stored.version).toBe(4); expect(stored.publicationDelta).toMatchObject({ unchangedFiles: 1, beforeBytes: 0, afterBytes: 0 });
  expect(stored.publicationBefore.manifestId).toBe(snapshot.manifestId); expect(stored.publicationAfter.manifestId).toBe(snapshot.manifestId);
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  await lease.release();
});

it.each(["headroom", "partial-payload", "cancel-staged"])("retains originals and records a bounded v4 rollback after a post-preflight %s failure", async fault => {
  const { workspace, directory, baseline } = await fixture(), returned = [file("game.js", "new result")], controller = new AbortController(); let injected = false;
  interception.beforeWrite = async (name, bytes, partial) => {
    if (fault === "partial-payload" && name.endsWith("/after/game.js")) { injected = true; await partial(bytes.subarray(0, 2)); throw Object.assign(new Error("simulated host ENOSPC"), { code: "ENOSPC" }); }
    if (name.endsWith("/returned/game.js")) { injected = true; if (fault === "headroom") interception.diskAvailable = 0n; if (fault === "cancel-staged") controller.abort(); }
  };
  await expect(applySourceChanges(workspace, baseline, returned, controller.signal, [], 0, sourceContext(baseline, returned))).rejects.toThrow("publication stopped");
  expect(injected).toBe(true); expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  const [entry] = await readdir(path.join(directory, "isolated-changes")), journal = path.join(directory, "isolated-changes", entry!), stored = JSON.parse(await readFile(path.join(journal, "manifest.json"), "utf8"));
  expect(stored).toMatchObject({ version: 4, state: "rolled-back", publicationDelta: { beforeBytes: 8, afterBytes: 10 } });
  expect(await readFile(path.join(journal, "original/game.js"), "utf8")).toBe("original");
  if (fault === "partial-payload") expect(await readFile(path.join(journal, "after/game.js"), "utf8")).toBe("ne");
  else expect(await readFile(path.join(journal, "returned/game.js"), "utf8")).toBe("new result");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([]);
  await expect(assertSourcePublicationSettled(workspace)).resolves.toBeUndefined();
});

it("does not replace another V1 reservation or confuse its conflict with a host-full publication", async () => {
  const { workspace, directory, baseline } = await fixture(), returned = [file("game.js", "new result")], lease = await reserveRecoverySpace(workspace, smallPlan, manifestOwner()), target = path.join(directory, "isolated-space-reservations", lease.id + ".json"), before = await readFile(target, "utf8");
  await expect(applySourceChanges(workspace, baseline, returned, undefined, [], 0, sourceContext(baseline, returned))).rejects.toThrow("another operation has an unresolved reservation");
  expect(await readFile(target, "utf8")).toBe(before); expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  const transactions = await readdir(path.join(directory, "isolated-changes")); expect(transactions).toEqual([]);
  await lease.release();
});

it("serializes simultaneous V1 device promises so only one can consume the remaining unreserved disk", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture(), plan = space.planRecoverySpace(smallPlan);
  interception.diskAvailable = BigInt(space.RECOVERY_DISK_FLOOR_BYTES + plan.diskBytes);
  const outcomes = await Promise.allSettled([space.reserveRecoverySpace(first.workspace, smallPlan, manifestOwner()), space.reserveRecoverySpace(second.workspace, smallPlan, { ...manifestOwner(), ownerKey: "e".repeat(32) })]);
  expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
  const refused = outcomes.find(value => value.status === "rejected") as PromiseRejectedResult;
  expect(space.isRecoverySpaceInputRefusal(refused.reason)).toBe(true); expect(refused.reason.message).toContain("unreserved disk");
  const winner = outcomes.find(value => value.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof space.reserveRecoverySpace>>>;
  await winner.value.release();
});

it.each(["partial-write", "file-fsync"])("keeps an uncertain initial V1 intent %s failure distinct from an ordinary capacity refusal", async fault => {
  const space = await freshSpace(), { workspace, directory } = await fixture();
  if (fault === "partial-write") interception.beforeWrite = async (name, bytes, partial) => { if (path.basename(name).startsWith(".intent-")) { await partial(bytes.subarray(0, 5)); throw Object.assign(new Error("simulated initial intent ENOSPC"), { code: "ENOSPC" }); } };
  else interception.beforeSync = async name => { if (path.basename(name).startsWith(".intent-")) throw Object.assign(new Error("simulated initial intent fsync"), { code: "EIO" }); };
  const failure = await space.reserveRecoverySpace(workspace, smallPlan, manifestOwner()).catch(cause => cause);
  interception.beforeWrite = undefined; interception.beforeSync = undefined;
  expect(failure).toBeInstanceOf(Error); expect(space.isRecoverySpaceInputRefusal(failure)).toBe(false);
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([]);
  const diagnostic = await space.inspectRecoveryCapacity(workspace);
  expect(diagnostic).toMatchObject({ status: "incomplete", promises: { ledger: "uncertain", own: { count: null, logicalBytes: null, diskBytes: null } } });
  await expect(space.reserveRecoverySpace(workspace, smallPlan, { ...manifestOwner(), ownerKey: "e".repeat(32) })).rejects.toThrow("active reservation intent disappeared");
});

it("does not publish a V1 target using an otherwise large enough ALS promise bound to a different source identity", async () => {
  // The preceding fault-injection cases intentionally retain their module's uncertain ledger.
  const space = await freshSpace(), { workspace, directory, baseline } = await fixture(), returned = [file("game.js", "new result")], bound = sourceContext(baseline, returned), lease = await space.reserveRecoverySpace(workspace, { ...smallPlan, manifestBytes: 16384 }, { ...owner, generation: context.generation, sourceManifestVersion: 1, sourceBaseManifestId: bound.sourceContract!.baseManifestId, sourceResultManifestId: "f".repeat(64) });
  // This dynamic module owns this scope; use its publisher so both share the same ALS instance.
  const publisher = await import("../src/daemon/isolated-source-changes.js");
  await expect(space.withRecoverySpaceReservation(lease, () => publisher.applySourceChanges(workspace, baseline, returned, undefined, [], 0, bound))).rejects.toThrow("exactly bound");
  expect(await readFile(path.join(workspace, "game.js"), "utf8")).toBe("original");
  expect(await readdir(path.join(directory, "isolated-changes"))).toEqual([]);
  expect(await readdir(path.join(directory, "isolated-space-reservations"))).toEqual([lease.id + ".json"]);
  await lease.release();
});

const profileOwner = () => ({ ...owner, sourceManifestVersion: 2 as const, sourceProfileId: "capacity-128-v2" as const,
  sourceBaseManifestId: "c".repeat(64), sourceResultManifestId: "d".repeat(64) });
const volumeOwner = () => ({ namespace: "test" as const, projectId: "6e849fb8-9236-4f0e-a58a-76cb223b8a74", profileId: "capacity-128-v2" as const,
  planId: "11111111-1111-4111-8111-111111111111", purpose: "migration" as const });
const profilePlan = () => ({ profileId: "capacity-128-v2" as const, rawBytes: 72 * 1024 ** 2, workingBytes: 64 * 1024 ** 2,
  beforeBytes: 136 * 1024 ** 2, afterBytes: 72 * 1024 ** 2, manifestBytes: 2 * 1024 ** 2, reviewBytes: 8 * 1024 ** 2 });

it("shared profile ledger separates the 598 MiB logical envelope from 1020.25 MiB of physical promises", async () => {
  const space = await freshSpace(), MiB = 1024 ** 2, plan = space.planRecoverySpace(profilePlan());
  expect(plan).toMatchObject({ version: 2, profileId: "capacity-128-v2", limitBytes: 1024 * MiB, guestVolumeGrowthBytes: 512 * MiB });
  expect(plan.requiredBytes).toBe(598 * MiB); expect(plan.diskBytes).toBe(1020.25 * MiB);
  expect(plan.entryAllocationBytes).toBe(20032 * 4096);
  expect(space.validRecoverySpacePlan(plan)).toBe(true);
  expect(space.validRecoverySpacePlan({ ...plan, version: 1 })).toBe(false);
  expect(space.validRecoverySpacePlan({ ...plan, guestVolumeGrowthBytes: 0 })).toBe(false);
  const { profileId: _profile, ...legacy } = profilePlan();
  expect(() => space.planRecoverySpace(legacy)).toThrow("invalid complete transaction plan");
  expect(space.RECOVERY_LIMIT_BYTES).toBe(512 * MiB);
});

it.each(["disk-source-first", "disk-volume-first", "inodes-source-first", "inodes-volume-first"])("shared profile ledger serializes source and physical-only reservations against the same remaining budget: %s", async order => {
  const space = await freshSpace(), source = await fixture(), volume = await fixture(), device = (await stat(source.workspace)).dev;
  expect((await stat(volume.workspace)).dev).toBe(device);
  const sourceInput = { ...smallPlan, profileId: "capacity-128-v2" as const, backingDevice: device }, sourcePlan = space.planRecoverySpace(sourceInput);
  const physicalInput = { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, physicalNeed = physicalInput.physicalBytes + 3 * 4096;
  interception.diskAvailable = BigInt(order.startsWith("disk") ? space.RECOVERY_DISK_FLOOR_BYTES + Math.max(sourcePlan.diskBytes, physicalNeed) : 8 * 1024 ** 3);
  interception.freeInodes = BigInt(order.startsWith("inodes") ? Math.max(sourcePlan.additionalEntries + 2, physicalInput.hostInodes) : 1000000);
  const operations = {
    source: () => space.reserveRecoverySpace(source.workspace, sourceInput, profileOwner()),
    volume: () => space.reserveVolumeMigrationSpace(volume.workspace, physicalInput, volumeOwner()),
  };
  const names = order.endsWith("source-first") ? ["source", "volume"] as const : ["volume", "source"] as const;
  const results = await Promise.allSettled(names.map(name => operations[name]()));
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  const refused = results.find(value => value.status === "rejected") as PromiseRejectedResult;
  expect(refused.reason.message).toMatch(order.startsWith("inodes") ? /inodes/ : /unreserved (?:disk|physical)/);
  for (const [index, result] of results.entries()) if (result.status === "fulfilled") {
    if (names[index] === "source") await (result.value as Awaited<ReturnType<typeof space.reserveRecoverySpace>>).release();
    else {
      const lease = result.value as Awaited<ReturnType<typeof space.reserveVolumeMigrationSpace>>;
      await lease.release(space.createVolumeMigrationSpaceTerminalProof(lease, "revoked-not-started"));
    }
  }
  expect(await readFile(path.join(source.workspace, "game.js"), "utf8")).toBe("original");
  expect(await readFile(path.join(volume.workspace, "game.js"), "utf8")).toBe("original");
});

it("shared profile ledger refuses an unverified backing device before reserving source or volume space", async () => {
  const space = await freshSpace(), { workspace, directory } = await fixture(), device = (await stat(workspace)).dev;
  await expect(space.reserveRecoverySpace(workspace, { ...smallPlan, profileId: "capacity-128-v2", backingDevice: device + 1 }, profileOwner())).rejects.toThrow("backing device");
  await expect(space.reserveVolumeMigrationSpace(workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device + 1 }, volumeOwner())).rejects.toThrow("different devices");
  expect((await space.inspectVolumeMigrationSpaces(workspace)).reservations).toEqual([]);
  expect(await readdir(directory)).toEqual(["workspace"]);
});

it.each(["disk", "inodes"])("shared profile ledger keeps %s promises on different synthetic backing devices separate", async budget => {
  const space = await freshSpace(), source = await fixture(), volume = await fixture(), sourceDevice = (await stat(source.workspace)).dev, volumeDevice = sourceDevice + 1;
  // Only this private fixture's metadata is synthetic; no second filesystem or migration is exercised.
  interception.workspaceDevices.set(volume.workspace, volumeDevice);
  const sourceInput = { ...smallPlan, profileId: "capacity-128-v2" as const, backingDevice: sourceDevice }, plan = space.planRecoverySpace(sourceInput);
  const volumeInput = { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: volumeDevice };
  interception.diskAvailable = BigInt(budget === "disk" ? space.RECOVERY_DISK_FLOOR_BYTES + Math.max(plan.diskBytes, volumeInput.physicalBytes + 3 * 4096) : 8 * 1024 ** 3);
  interception.freeInodes = BigInt(budget === "inodes" ? Math.max(plan.additionalEntries + 2, volumeInput.hostInodes) : 1000000);
  const [sourceLease, volumeLease] = await Promise.all([
    space.reserveRecoverySpace(source.workspace, sourceInput, profileOwner()),
    space.reserveVolumeMigrationSpace(volume.workspace, volumeInput, volumeOwner()),
  ]);
  expect(await space.inspectVolumeMigrationHeadroom(source.workspace)).toMatchObject({ status: "complete", physicalOutstandingBytes: sourceLease.plan.diskBytes, inodeOutstanding: sourceLease.plan.additionalEntries + 2 });
  expect(await space.inspectVolumeMigrationHeadroom(volume.workspace)).toMatchObject({ status: "complete", physicalOutstandingBytes: volumeLease.physicalBytes, inodeOutstanding: volumeLease.hostInodes });
  await sourceLease.release();
  await volumeLease.release(space.createVolumeMigrationSpaceTerminalProof(volumeLease, "revoked-not-started"));
});

it("shared profile ledger restores both kinds of physical promise without re-allocating or inferring completion", async () => {
  let space = await freshSpace(); const source = await fixture(), volume = await fixture(), device = (await stat(source.workspace)).dev;
  interception.diskAvailable = BigInt(8 * 1024 ** 3); interception.freeInodes = 1000000n;
  const sourceInput = { ...smallPlan, profileId: "capacity-128-v2" as const, backingDevice: device }, sourceLease = await space.reserveRecoverySpace(source.workspace, sourceInput, profileOwner());
  const volumeLease = await space.reserveVolumeMigrationSpace(volume.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner());
  const oldProof = space.createVolumeMigrationSpaceTerminalProof(volumeLease, "revoked-not-started");
  const before = await space.inspectVolumeMigrationHeadroom(source.workspace);
  expect(before).toMatchObject({ status: "complete", physicalOutstandingBytes: sourceLease.plan.diskBytes + volumeLease.physicalBytes,
    inodeOutstanding: sourceLease.plan.additionalEntries + 2 + volumeLease.hostInodes });
  space = await freshSpace(); await space.restoreRecoverySpaceReservations([source.workspace, volume.workspace]);
  expect(await space.inspectVolumeMigrationHeadroom(source.workspace)).toEqual(before);
  const reconnected = await space.reconnectVolumeMigrationSpace(volume.workspace, volumeOwner(), device); expect(reconnected!.id).toBe(volumeLease.id);
  await expect(reconnected!.release(oldProof)).rejects.toThrow("exact volume terminal proof");
  await expect(space.reconnectVolumeMigrationSpace(volume.workspace, { ...volumeOwner(), planId: "22222222-2222-4222-8222-222222222222" }, device)).rejects.toThrow("another exact owner");
  expect((await space.inspectVolumeMigrationSpaces(volume.workspace)).reservations).toHaveLength(1);
  await reconnected!.release(space.createVolumeMigrationSpaceTerminalProof(reconnected!, "revoked-not-started"));
  const original = await space.reservationForPublication(source.workspace, sourceLease.id, { ...context, generation: owner.generation,
    sourceContract: { version: 2, profileId: "capacity-128-v2", baseManifestId: "c".repeat(64), rawManifestId: "d".repeat(64) } });
  await original.release();
});

it("shared profile ledger never releases an unknown physical promise from JSON properties or another owner's proof", async () => {
  const space = await freshSpace(), first = await fixture(), second = await fixture(), device = (await stat(first.workspace)).dev;
  const input = { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device };
  const firstLease = await space.reserveVolumeMigrationSpace(first.workspace, input, volumeOwner());
  const secondLease = await space.reserveVolumeMigrationSpace(second.workspace, input, { ...volumeOwner(), planId: "22222222-2222-4222-8222-222222222222" });
  const proof = space.createVolumeMigrationSpaceTerminalProof(secondLease, "revoked-not-started");
  expect(() => space.createVolumeMigrationSpaceTerminalProof(firstLease, "unknown" as never)).toThrow("unverified volume terminal");
  await expect(firstLease.release({ kind: "volume-space-terminal" })).rejects.toThrow("exact volume terminal proof");
  await expect(firstLease.release(JSON.parse(JSON.stringify(proof)))).rejects.toThrow("exact volume terminal proof");
  await expect(firstLease.release(proof)).rejects.toThrow("exact volume terminal proof");
  expect((await space.inspectVolumeMigrationSpaces(first.workspace)).reservations).toMatchObject([{ id: firstLease.id, physicalBytes: firstLease.physicalBytes }]);
  expect((await space.inspectRecoverySpace(first.workspace)).used).toBeLessThan(16384);
  await firstLease.release(space.createVolumeMigrationSpaceTerminalProof(firstLease, "revoked-not-started")); await secondLease.release(proof);
});

it("shared profile ledger latches a damaged restarted physical intent without deleting it or admitting replacement work", async () => {
  let space = await freshSpace(); const first = await fixture(), second = await fixture(), device = (await stat(first.workspace)).dev;
  const lease = await space.reserveVolumeMigrationSpace(first.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner());
  const target = path.join(first.directory, "isolated-space-reservations", "volume-" + lease.id + ".json"), value = JSON.parse(await readFile(target, "utf8"));
  value.owner.planId = "untrusted"; await writeFile(target, JSON.stringify(value)); const retained = await readFile(target, "utf8");
  space = await freshSpace(); await expect(space.restoreRecoverySpaceReservations([first.workspace])).rejects.toThrow();
  expect(await space.inspectVolumeMigrationSpaces(first.workspace)).toEqual({ state: "uncertain", reservations: null });
  expect((await space.inspectVolumeMigrationHeadroom(first.workspace)).status).toBe("unknown");
  await expect(space.reserveRecoverySpace(second.workspace, smallPlan, owner)).rejects.toThrow("startup could not establish all outstanding disk reservations");
  await expect(space.reserveVolumeMigrationSpace(second.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner())).rejects.toThrow("unknown");
  expect(await readFile(target, "utf8")).toBe(retained); expect(await readFile(path.join(first.workspace, "game.js"), "utf8")).toBe("original");
});

it.each(["source", "volume"])("shared profile ledger blocks after the original %s reservation root disappears", async kind => {
  const space = await freshSpace(), first = await fixture(), second = await fixture(), device = (await stat(first.workspace)).dev;
  if (kind === "source") await space.reserveRecoverySpace(first.workspace, { ...smallPlan, profileId: "capacity-128-v2", backingDevice: device }, profileOwner());
  else await space.reserveVolumeMigrationSpace(first.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner());
  await rm(path.join(first.directory, "isolated-space-reservations"), { recursive: true });
  expect((await space.inspectVolumeMigrationHeadroom(first.workspace)).status).toBe("unknown");
  expect(await space.inspectVolumeMigrationSpaces(first.workspace)).toEqual({ state: "uncertain", reservations: null });
  await expect(space.reserveRecoverySpace(second.workspace, smallPlan, owner)).rejects.toThrow("startup could not establish all outstanding disk reservations");
  await expect(space.reserveVolumeMigrationSpace(second.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner())).rejects.toThrow("unknown");
  expect(await readdir(first.directory)).toEqual(["workspace"]);
  expect(await readFile(path.join(first.workspace, "game.js"), "utf8")).toBe("original");
});

it("shared profile ledger latches corruption first discovered by a direct reservation before any restore or inspection", async () => {
  let space = await freshSpace(); const first = await fixture(), second = await fixture(), device = (await stat(first.workspace)).dev;
  const lease = await space.reserveVolumeMigrationSpace(first.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner());
  const target = path.join(first.directory, "isolated-space-reservations", "volume-" + lease.id + ".json"), value = JSON.parse(await readFile(target, "utf8"));
  value.owner.planId = "untrusted"; await writeFile(target, JSON.stringify(value)); const retained = await readFile(target, "utf8");
  space = await freshSpace();
  await expect(space.reserveRecoverySpace(first.workspace, smallPlan, owner)).rejects.toThrow("invalid volume physical promise binding");
  await expect(space.reserveRecoverySpace(second.workspace, smallPlan, owner)).rejects.toThrow("startup could not establish all outstanding disk reservations");
  await expect(space.reserveVolumeMigrationSpace(second.workspace, { physicalBytes: 512 * 1024 ** 2, hostInodes: 8, backingDevice: device }, volumeOwner())).rejects.toThrow("unknown");
  expect(await readFile(target, "utf8")).toBe(retained); expect(await readdir(second.directory)).toEqual(["workspace"]);
  expect(await readFile(path.join(first.workspace, "game.js"), "utf8")).toBe("original");
});

async function media64PublicationFixture() {
  const value = await fixture(), profile = "capacity-128-media64-v3" as const, size = 64 * 1024 ** 2;
  await mkdir(path.join(value.workspace, "public"));
  for (const [index, name] of ["target.wav", "source.wav"].entries()) { const target = path.join(value.workspace, "public", name), handle = await open(target, "wx", 0o600), header = Buffer.alloc(44); header.write("RIFF"); header.write("WAVE", 8); header[42] = index; try { await handle.writeFile(header); await handle.truncate(size); } finally { await handle.close(); } }
  const media: RuntimeMedia[] = [], baseline = await projectFiles(value.workspace, media, undefined, { profile });
  const target = media.find(file => file.path.endsWith("target.wav"))!, source = media.find(file => file.path.endsWith("source.wav"))!, returned = [...baseline, source, { ...source, path: target.path }];
  const typed = (files: readonly (TransferFile | RuntimeMedia)[]) => createSourceManifestV2(profile, files.map(file => ({ path: file.path, kind: "data" in file ? "source" : "media", size: "data" in file ? Buffer.byteLength(file.data, "base64") : file.size, sha256: file.sha256, executable: "executable" in file && file.executable === true })));
  const base = typed([...baseline, ...media]), raw = typed(returned), bound: PublicationContext = { ...context, sourceContract: { version: 2, profileId: profile, baseManifestId: base.manifestId, rawManifestId: raw.manifestId } };
  return { ...value, baseline, media, target, source, returned, bound, profile, size, backingDevice: (await stat(value.workspace)).dev };
}
it("media64 retains exact originals and safely rolls back a known failed publication without whole-payload allocation", async () => {
  const f = await media64PublicationFixture(), allocated: number[] = [], originalAlloc = Buffer.alloc;
  const spy = vi.spyOn(Buffer, "alloc").mockImplementation(((size: number, ...args: any[]) => { allocated.push(size); return (originalAlloc as any)(size, ...args); }) as typeof Buffer.alloc);
  let fail = true; interception.beforeLink = async target => { if (fail && target === path.join(f.workspace, f.target.path)) { fail = false; throw new Error("synthetic link refusal"); } };
  await expect(applySourceChanges(f.workspace, f.baseline, f.returned, undefined, f.media, 2, f.bound, { backingDevice: f.backingDevice })).rejects.toThrow("publication stopped"); spy.mockRestore();
  expect(Math.max(...allocated)).toBeLessThan(32 * 1024 ** 2);
  expect(await inspectSafeProjectMedia(f.workspace, path.join(f.workspace, f.target.path), f.size)).toMatchObject({ size: f.size, sha256: f.target.sha256 });
  const root = path.join(f.directory, "isolated-changes"), [id] = await readdir(root), journal = JSON.parse(await readFile(path.join(root, id!, "manifest.json"), "utf8"));
  expect(journal.state).toBe("rolled-back");
  expect(await inspectSafeProjectMedia(path.join(root, id!), path.join(root, id!, "original", f.target.path), f.size)).toMatchObject({ sha256: f.target.sha256 });
  expect(await inspectSafeProjectMedia(path.join(root, id!), path.join(root, id!, "returned", f.target.path), f.size)).toMatchObject({ sha256: f.source.sha256 });
}, 30_000);
it("media64 refuses two changed 64 MiB paths before any journal or host replacement", async () => {
  const f = await media64PublicationFixture(), returned = [...f.baseline, { ...f.target, path: f.source.path }, { ...f.source, path: f.target.path }];
  const after = createSourceManifestV2(f.profile, returned.map(file => ({ path: file.path, kind: "data" in file ? "source" : "media", size: "data" in file ? Buffer.byteLength(file.data, "base64") : file.size, sha256: file.sha256, executable: false })));
  const bound = { ...f.bound, sourceContract: { ...f.bound.sourceContract!, rawManifestId: after.manifestId } };
  await expect(applySourceChanges(f.workspace, f.baseline, returned, undefined, f.media, 2, bound, { backingDevice: f.backingDevice })).rejects.toThrow("64 MiB media return window");
  await expect(stat(path.join(f.directory, "isolated-changes"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await inspectSafeProjectMedia(f.workspace, path.join(f.workspace, f.target.path), f.size)).toMatchObject({ sha256: f.target.sha256 });
}, 30_000);
it("media64 cold disk resume reconstructs a missing staged version from a checked 64 MiB returned original", async () => {
  const f = await media64PublicationFixture(), applied = await applySourceChanges(f.workspace, f.baseline, f.returned, undefined, f.media, 2, f.bound, { backingDevice: f.backingDevice }), directory = path.join(f.directory, applied.recovery!), journal = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  // Represent abrupt death at the durable moved barrier; all payloads were produced by the real publisher above.
  await rm(path.join(f.workspace, f.target.path)); journal.state = "publishing"; journal.published = []; journal.steps[f.target.path] = "moved";
  vi.resetModules(); const coldSpace = await import("../src/daemon/recovery-space.js"), coldJournal = await import("../src/daemon/isolated-publication-journal.js");
  const lease = await coldSpace.reserveRecoverySpace(f.workspace, { profileId: f.profile, backingDevice: f.backingDevice, rawBytes: 0, workingBytes: 0, beforeBytes: f.size, afterBytes: f.size, manifestBytes: 64 * 1024, additionalEntries: 100 }, { ownerKey: "9".repeat(32), namespace: "test", projectId: context.projectId, generation: context.generation, rawSnapshotId: context.snapshotId, sourceManifestVersion: 2, sourceProfileId: f.profile, sourceBaseManifestId: f.bound.sourceContract!.baseManifestId, sourceResultManifestId: f.bound.sourceContract!.rawManifestId });
  journal.spacePlan = lease.plan; journal.reservationId = lease.id; await coldJournal.savePublicationManifest(directory, journal);
  await expect(coldJournal.resumeSourcePublications(f.workspace, f.bound)).resolves.toMatchObject({ changed: [f.target.path] });
  expect(await inspectSafeProjectMedia(f.workspace, path.join(f.workspace, f.target.path), f.size)).toMatchObject({ size: f.size, sha256: f.source.sha256 });
  await expect(coldJournal.verifyRetainedPublicationOriginal(f.workspace, f.bound, f.target.path, f.target.sha256, f.source.sha256)).resolves.toBeUndefined();
  expect(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")).state).toBe("committed");
}, 30_000);
