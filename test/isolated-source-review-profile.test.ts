import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const budgetProfiles = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock("../src/daemon/isolated-source-changes.js", async (original) => {
  const actual =
    await original<typeof import("../src/daemon/isolated-source-changes.js")>();
  return {
    ...actual,
    sourceRecoveryBudget: async (
      ...args: Parameters<typeof actual.sourceRecoveryBudget>
    ) => {
      budgetProfiles.push(args[2]);
      return actual.sourceRecoveryBudget(...args);
    },
  };
});
import { validSourceConfirmation } from "../src/shared/execution-storage.js";
import {
  projectFiles,
  sourceManifestEntries,
  type RuntimeMedia,
} from "../src/daemon/isolated-project-files.js";
import {
  createSourceManifestV2,
  planSourceDelta,
} from "../src/daemon/isolated-source-manifest.js";
import {
  assertRetainedReviewArtifacts,
  buildRetainedSourceReview,
  readSourceReview,
  reviewSnapshotDigest,
  reviewSourceManifests,
  saveSourceReview,
  type RetainedReviewSnapshot,
} from "../src/daemon/isolated-source-review.js";

const roots: string[] = [];
afterEach(async () => {
  budgetProfiles.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "source-review-profile-")),
  );
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await mkdir(path.join(workspace, "public"));
  await writeFile(path.join(workspace, "game.js"), "before");
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  for (const [name, size] of [
    ["a.png", 32 * 1024 * 1024],
    ["b.png", 32 * 1024 * 1024],
    ["c.png", 16],
  ] as const) {
    const target = path.join(workspace, "public", name);
    await writeFile(target, header);
    await truncate(target, size);
  }
  const media: RuntimeMedia[] = [];
  const beforeFiles = await projectFiles(workspace, media, undefined, {
    profile: "capacity-128-v2",
  });
  const source = Buffer.from("after");
  const files = beforeFiles.map((file) =>
    file.path === "game.js"
      ? { ...file, data: source.toString("base64"), sha256: sha(source) }
      : file,
  );
  const baseline = [
    ...beforeFiles.map(({ path, sha256, executable }) => ({
      path,
      sha256,
      executable,
    })),
    ...media.map((item) => ({ ...item, executable: false })),
  ];
  const baseManifest = createSourceManifestV2(
    "capacity-128-v2",
    sourceManifestEntries([...beforeFiles, ...media], {
      profile: "capacity-128-v2",
    }).files,
  );
  const rawManifest = createSourceManifestV2(
    "capacity-128-v2",
    sourceManifestEntries([...files, ...media], { profile: "capacity-128-v2" })
      .files,
  );
  const snapshotId = reviewSnapshotDigest([...files, ...media]);
  const snapshot: RetainedReviewSnapshot = {
    reviewVersion: 2,
    rasterReturnVersion: 2,
    files: [...files, ...media],
    retainedRasters: [],
    baselineFiles: baseline,
    snapshotId,
    sourceManifestVersion: 2,
    sourceProfileId: "capacity-128-v2",
    sourceBaselineManifest: baseManifest,
    sourceManifest: rawManifest,
    sourceResultManifestId: rawManifest.manifestId,
    sourceDelta: planSourceDelta(baseManifest, rawManifest).summary,
    originOperations: [
      {
        operationId: "a".repeat(32),
        mode: "shell",
        phase: "released",
        snapshotId,
        acknowledged: false,
        sourceManifestVersion: 2,
        sourceProfileId: "capacity-128-v2",
        sourceBaseManifestId: baseManifest.manifestId,
        sourceResultManifestId: rawManifest.manifestId,
      },
    ],
  };
  return { root, workspace, snapshot, baseManifest, rawManifest };
}

it("round-trips V2 review identities for a complete media baseline above 64 MiB", async () => {
  const f = await fixture();
  const review = await buildRetainedSourceReview(
    f.workspace,
    "test",
    "profile-test",
    1,
    f.snapshot,
    new Map(),
  );
  expect(review.review.blockers).toEqual([]);
  expect(review.retained?.sourceContract).toMatchObject({
    version: 2,
    profileId: "capacity-128-v2",
    baseManifestId: f.baseManifest.manifestId,
    rawManifestId: f.rawManifest.manifestId,
    preparedManifestId: f.rawManifest.manifestId,
  });
  expect(review.review).toMatchObject({
    sourceManifestVersion: 2,
    sourceProfileId: "capacity-128-v2",
    sourceRawDelta: { afterMediaBytes: 0 },
    sourcePreparedDelta: { afterMediaBytes: 0 },
  });
  const confirmation = {
    reviewId: review.review.reviewId,
    filesReviewed: true,
    codeReviewed: true,
  };
  expect(validSourceConfirmation(review.review, confirmation)).toBe(true);
  expect(
    validSourceConfirmation(
      { ...review.review, sourceProfileId: undefined },
      confirmation,
    ),
  ).toBe(false);
  expect(
    validSourceConfirmation(
      { ...review.review, sourcePreparedDelta: undefined },
      confirmation,
    ),
  ).toBe(false);
  await saveSourceReview(review);
  const saved = await readSourceReview(
    f.workspace,
    "profile-test",
    "test",
    review.review.reviewId,
  );
  expect(reviewSourceManifests(saved).base.manifestId).toBe(
    f.baseManifest.manifestId,
  );
  await assertRetainedReviewArtifacts(saved);
  expect(budgetProfiles.length).toBeGreaterThan(0);
  expect(budgetProfiles.every((profile) => profile === "capacity-128-v2")).toBe(
    true,
  );
});

it("rejects missing or mismatched V2 profile bindings before retaining source", async () => {
  const f = await fixture();
  for (const snapshot of [
    { ...f.snapshot, sourceProfileId: undefined },
    { ...f.snapshot, sourceManifestVersion: 1 as const },
    {
      ...f.snapshot,
      originOperations: [
        { ...f.snapshot.originOperations[0]!, sourceProfileId: undefined },
      ],
    },
  ])
    await expect(
      buildRetainedSourceReview(
        f.workspace,
        "test",
        "profile-test",
        1,
        snapshot,
        new Map(),
      ),
    ).rejects.toThrow();
});

it("rejects an over-64 MiB changed-media delta even when no binary frame is declared", async () => {
  const f = await fixture();
  const files = f.snapshot.files.map((file, index) =>
    "size" in file ? { ...file, sha256: String(index % 10).repeat(64) } : file,
  );
  const raw = createSourceManifestV2(
    "capacity-128-v2",
    sourceManifestEntries(files, { profile: "capacity-128-v2" }).files,
  );
  const snapshotId = reviewSnapshotDigest(files);
  const snapshot: RetainedReviewSnapshot = {
    ...f.snapshot,
    files,
    snapshotId,
    sourceManifest: raw,
    sourceResultManifestId: raw.manifestId,
    sourceDelta: planSourceDelta(f.baseManifest, raw).summary,
    originOperations: f.snapshot.originOperations.map((origin) => ({
      ...origin,
      snapshotId,
      sourceResultManifestId: raw.manifestId,
    })),
  };
  expect(snapshot.sourceDelta?.afterMediaBytes).toBe(64 * 1024 * 1024 + 16);
  await expect(
    buildRetainedSourceReview(
      f.workspace,
      "test",
      "profile-test",
      1,
      snapshot,
      new Map(),
    ),
  ).rejects.toThrow("changed runtime media");
});

it("keeps a failed raster preparation blocked with no prepared V2 identity", async () => {
  const f = await fixture();
  const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const raster = {
    path: "public/invalid.png",
    size: bytes.length,
    sha256: sha(bytes),
    executable: false as const,
  };
  const raw = createSourceManifestV2(
    "capacity-128-v2",
    sourceManifestEntries(
      [
        ...f.snapshot.files,
        { path: raster.path, size: raster.size, sha256: raster.sha256 },
      ],
      { profile: "capacity-128-v2" },
    ).files,
  );
  const snapshotId = reviewSnapshotDigest([...f.snapshot.files, raster]);
  const snapshot: RetainedReviewSnapshot = {
    ...f.snapshot,
    retainedRasters: [raster],
    snapshotId,
    sourceManifest: raw,
    sourceResultManifestId: raw.manifestId,
    sourceDelta: planSourceDelta(f.baseManifest, raw).summary,
    originOperations: f.snapshot.originOperations.map((origin) => ({
      ...origin,
      snapshotId,
      sourceResultManifestId: raw.manifestId,
    })),
  };
  const record = await buildRetainedSourceReview(
    f.workspace,
    "test",
    "profile-test",
    1,
    snapshot,
    new Map([[raster.path, bytes]]),
  );
  expect(record.review.blockers.length).toBeGreaterThan(0);
  expect(record.retained?.sourceContract).not.toHaveProperty(
    "preparedManifestId",
  );
  expect(record.review.sourcePreparedDelta).toBeUndefined();
  await saveSourceReview(record);
  const saved = await readSourceReview(
    f.workspace,
    "profile-test",
    "test",
    record.review.reviewId,
  );
  await expect(assertRetainedReviewArtifacts(saved)).rejects.toThrow();
});

it("rejects returned binary payload above 64 MiB even when its manifest delta is small", async () => {
  const f = await fixture();
  const files = f.snapshot.files.filter((file) => "data" in file);
  const retainedRasters = f.snapshot.files
    .filter((file): file is RuntimeMedia => !("data" in file))
    .map((file) => ({ ...file, executable: false as const }));
  const snapshot: RetainedReviewSnapshot = {
    ...f.snapshot,
    files,
    retainedRasters,
  };
  expect(snapshot.sourceDelta?.afterMediaBytes).toBe(0);
  await expect(
    buildRetainedSourceReview(
      f.workspace,
      "test",
      "profile-test",
      1,
      snapshot,
      new Map(),
    ),
  ).rejects.toThrow("returned raster payload");
});
