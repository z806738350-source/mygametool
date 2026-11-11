import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeCapacityProfile,
  runtimeLargeMediaSupported,
  runtimeMediaFileLimit,
} from "../src/shared/execution-capacity-profiles.js";
import {
  canonicalSourceManifestRows,
  createSourceManifest,
  createSourceManifestV2,
  parseSourceContract,
  parseSourceManifest,
  planSourceDelta,
  sourceManifestFromLegacyBaseline,
  type SourceManifestEntryV1,
} from "../src/daemon/isolated-source-manifest.js";

const MiB = 1024 ** 2;
const legacy = "capacity-128-v2" as const,
  media64 = "capacity-128-media64-v3" as const;
const extensions = ["mp4", "mov", "webm", "m4a", "mp3", "wav", "ogg", "glb"];
const oldDescriptor = {
  version: 2,
  id: legacy,
  volumeBytes: 512 * MiB,
  mediaBytes: 128 * MiB,
  inodeCount: 16384,
  sourceFileBytes: 2 * MiB,
  sourceBytes: 8 * MiB,
  mediaFileBytes: 32 * MiB,
  mediaWindowBytes: 64 * MiB,
  fileCount: 2000,
  entryCount: 4000,
  requestHeaderBytes: 24 * MiB,
  responseHeaderBytes: 16 * MiB,
  recoveryBytes: 1024 * MiB,
  globalVolumeBytes: 4096 * MiB,
  residentVolumes: 8,
  globalOperations: 2,
  reserveBytes: 1024 * MiB,
  runtimeEnabled: true,
  simulationOnly: false,
};
const entry = (
  name: string,
  size: number,
  sha256 = "a".repeat(64),
): SourceManifestEntryV1 => ({
  path: name,
  kind: "media",
  size,
  sha256,
  executable: false,
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const disk = vi.hoisted(() => ({ available: 8n * 1024n ** 3n }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (...args: Parameters<typeof actual.statfs>) => ({
      ...(await actual.statfs(...args)),
      bsize: 4096n,
      bavail: disk.available / 4096n,
      ffree: 1_000_000n,
    }),
  };
});

describe("versioned media-file identity", () => {
  it("keeps the old descriptor bytes and canonical identity unchanged", () => {
    const old = getRuntimeCapacityProfile(legacy),
      current = getRuntimeCapacityProfile(media64);
    expect(JSON.stringify(old)).toBe(JSON.stringify(oldDescriptor));
    expect(Object.hasOwn(old, "largeMediaFileBytes")).toBe(false);
    expect(current).toEqual({
      ...oldDescriptor,
      version: 3,
      id: media64,
      largeMediaFileBytes: 64 * MiB,
      largeMediaFilePolicy: "video-audio-glb-v1",
    });
    expect(Object.isFrozen(current)).toBe(true);
    const files = [entry("public/old.mp4", 32 * MiB)];
    const canonical = JSON.stringify([
      oldDescriptor,
      JSON.parse(canonicalSourceManifestRows(files)),
    ]);
    expect(createSourceManifestV2(legacy, files).manifestId).toBe(
      createHash("sha256")
        .update("ohmygame-source-manifest-v2\n" + canonical, "ascii")
        .digest("hex"),
    );
    expect(createSourceManifestV2(media64, files).manifestId).not.toBe(
      createSourceManifestV2(legacy, files).manifestId,
    );
  });

  it.each(extensions)(
    "admits one 64 MiB .%s seed only under the new exact profile",
    (extension) => {
      const filename = `public/intro.${extension.toUpperCase()}`;
      expect(runtimeLargeMediaSupported(filename)).toBe(true);
      expect(runtimeMediaFileLimit(filename)).toBe(32 * MiB);
      expect(runtimeMediaFileLimit(filename, legacy)).toBe(32 * MiB);
      expect(runtimeMediaFileLimit(filename, media64)).toBe(64 * MiB);
      expect(() =>
        createSourceManifest([entry(filename, 32 * MiB + 1)]),
      ).toThrow();
      expect(() =>
        createSourceManifestV2(legacy, [entry(filename, 32 * MiB + 1)]),
      ).toThrow();
      const manifest = createSourceManifestV2(media64, [
        entry(filename, 64 * MiB),
      ]);
      expect(parseSourceManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
        manifest,
      );
      expect(() =>
        createSourceManifestV2(media64, [entry(filename, 64 * MiB + 1)]),
      ).toThrow();
    },
  );

  it.each(["png", "jpg", "jpeg", "webp", "gif", "avif"])(
    "keeps the .%s raster encoded-byte bound outside the large-file allowance",
    (extension) => {
      const filename = `public/texture.${extension}`;
      expect(runtimeLargeMediaSupported(filename)).toBe(false);
      expect(runtimeMediaFileLimit(filename, media64)).toBe(32 * MiB);
      expect(
        createSourceManifestV2(media64, [entry(filename, 32 * MiB)]).files[0]
          ?.size,
      ).toBe(32 * MiB);
      expect(() =>
        createSourceManifestV2(media64, [entry(filename, 32 * MiB + 1)]),
      ).toThrow();
    },
  );

  it("retains the cumulative, source, path and execution constraints independently of single-file size", () => {
    const twoCopies = createSourceManifestV2(media64, [
      entry("public/a.mp4", 64 * MiB),
      entry("public/b.glb", 64 * MiB),
    ]);
    expect(
      planSourceDelta(createSourceManifestV2(media64, []), twoCopies).summary
        .afterMediaBytes,
    ).toBe(128 * MiB);
    expect(
      createSourceManifestV2(media64, [
        entry("public/a.mp4", 64 * MiB),
        entry("public/b.glb", 64 * MiB),
      ]).files,
    ).toHaveLength(2);
    expect(() =>
      createSourceManifestV2(media64, [
        entry("public/a.mp4", 64 * MiB),
        entry("public/b.glb", 64 * MiB),
        entry("public/c.wav", 1),
      ]),
    ).toThrow();
    expect(() =>
      createSourceManifestV2(media64, [
        { ...entry("src/main.js", 2 * MiB + 1), kind: "source" },
      ]),
    ).toThrow();
    expect(() =>
      createSourceManifestV2(media64, [
        { ...entry("public/a.mp4", 1), executable: true },
      ]),
    ).toThrow();
    for (const filename of [
      "public/unsafe.fbx",
      "public/unsafe.svg",
      "outside.mp4",
      "public/parent/../a.mp4",
      "public/.secret/a.mp4",
      "node_modules/public/a.mp4",
    ]) {
      expect(() =>
        createSourceManifestV2(media64, [entry(filename, 1)]),
      ).toThrow();
    }
    expect(runtimeLargeMediaSupported("public/video.mp4.txt")).toBe(false);
    expect(runtimeLargeMediaSupported("public/video.mp4?download=true")).toBe(
      false,
    );
  });

  it("binds every descriptor field instead of accepting a claimed caller limit", () => {
    const manifest = createSourceManifestV2(media64, [
      entry("public/a.mp4", 64 * MiB),
    ]);
    const withoutPolicy = JSON.parse(JSON.stringify(manifest));
    delete withoutPolicy.limits.largeMediaFilePolicy;
    expect(() => parseSourceManifest(withoutPolicy)).toThrow();
    const old = createSourceManifestV2(legacy, []);
    expect(() =>
      parseSourceManifest({
        ...old,
        limits: {
          ...old.limits,
          largeMediaFileBytes: 64 * MiB,
          largeMediaFilePolicy: "video-audio-glb-v1",
        },
      }),
    ).toThrow();
    for (const [key, value] of [
      ["largeMediaFileBytes", 128 * MiB],
      ["mediaFileBytes", 64 * MiB],
      ["largeMediaFilePolicy", "all-files"],
      ["version", 2],
      ["runtimeEnabled", false],
    ]) {
      expect(() =>
        parseSourceManifest({
          ...manifest,
          limits: { ...manifest.limits, [key as string]: value },
        }),
      ).toThrow();
    }
    expect(() =>
      parseSourceManifest({ ...manifest, profile: legacy }),
    ).toThrow();
    expect(() =>
      createSourceManifestV2("capacity-128-media64-v2" as never, []),
    ).toThrow();
    expect(() =>
      runtimeMediaFileLimit("public/a.mp4", "unreviewed-profile" as never),
    ).toThrow();
  });

  it("matches the cross-language ASCII fixture and refuses cross-profile deltas", () => {
    const files: SourceManifestEntryV1[] = [
      entry("public/intro.mp4", 64 * MiB),
      {
        path: "src/游戏.js",
        kind: "source",
        size: 0,
        sha256: "b".repeat(64),
        executable: false,
      },
    ];
    expect(createSourceManifestV2(media64, files).manifestId).toBe(
      "f26394dbca9cbc4dd3d06497d8552f7527e78e8a93df930b496135ad0eff6121",
    );
    const old = createSourceManifestV2(legacy, []),
      current = createSourceManifestV2(media64, []);
    expect(() => planSourceDelta(old, current)).toThrow();
    expect(
      parseSourceContract({
        version: 2,
        profileId: media64,
        baseManifestId: old.manifestId,
        rawManifestId: current.manifestId,
      }),
    ).toEqual({
      version: 2,
      profileId: media64,
      baseManifestId: old.manifestId,
      rawManifestId: current.manifestId,
    });
    expect(() =>
      parseSourceContract({
        version: 2,
        profileId: "capacity-128-media64-v2",
        baseManifestId: old.manifestId,
        rawManifestId: current.manifestId,
      }),
    ).toThrow();
  });

  it("reconstructs compact sizes under the exact profile without authorizing a new copy", () => {
    const baseline = [
        { path: "public/a.mp4", size: 64 * MiB, sha256: "a".repeat(64) },
      ],
      scope = { sourceManifestVersion: 2 as const, sourceProfileId: media64 };
    expect(
      sourceManifestFromLegacyBaseline(baseline, [64 * MiB], scope),
    ).toEqual(
      createSourceManifestV2(media64, [entry("public/a.mp4", 64 * MiB)]),
    );
    expect(() =>
      sourceManifestFromLegacyBaseline(baseline, [64 * MiB], {
        ...scope,
        sourceProfileId: legacy,
      }),
    ).toThrow();
    expect(() =>
      sourceManifestFromLegacyBaseline(baseline, [64 * MiB - 1], scope),
    ).toThrow();
    expect(() =>
      sourceManifestFromLegacyBaseline(baseline, [], scope),
    ).toThrow();
  });
});

const freshSpace = async () => {
  vi.resetModules();
  return import("../src/daemon/recovery-space.js");
};
async function workspace() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-media64-identity-")),
  );
  directories.push(directory);
  const root = path.join(directory, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "main.js"), "original");
  return { directory, root, device: (await stat(root)).dev };
}
const owner = {
  ownerKey: "e".repeat(32),
  namespace: "test" as const,
  projectId: "11111111-1111-4111-8111-111111111111",
  generation: 3,
  rawSnapshotId: "d".repeat(64),
  sourceManifestVersion: 2 as const,
  sourceProfileId: media64,
  sourceBaseManifestId: "a".repeat(64),
  sourceResultManifestId: "b".repeat(64),
};
const input = {
  profileId: media64,
  rawBytes: 0,
  workingBytes: 0,
  beforeBytes: 0,
  afterBytes: 64 * MiB,
  manifestBytes: 16384,
  additionalEntries: 16,
};

describe("media64 recovery identity", () => {
  it("retains the complete conservative 598 MiB envelope and fixed physical backing promise", async () => {
    const space = await freshSpace(),
      plan = space.planRecoverySpace({
        profileId: media64,
        rawBytes: 72 * MiB,
        workingBytes: 64 * MiB,
        beforeBytes: 136 * MiB,
        afterBytes: 72 * MiB,
        manifestBytes: 2 * MiB,
        reviewBytes: 8 * MiB,
      });
    expect(plan).toMatchObject({
      version: 2,
      profileId: media64,
      limitBytes: 1024 * MiB,
      requiredBytes: 598 * MiB,
      diskBytes: 1020.25 * MiB,
      guestVolumeGrowthBytes: 512 * MiB,
    });
    expect(space.validRecoverySpacePlan(plan)).toBe(true);
    expect(
      space.validRecoverySpacePlan({ ...plan, guestVolumeGrowthBytes: 0 }),
    ).toBe(false);
    expect(space.validRecoverySpacePlan({ ...plan, version: 1 })).toBe(false);
    expect(() =>
      space.planRecoverySpace({ ...input, afterBytes: 72 * MiB + 1 }),
    ).toThrow();
    expect(() =>
      space.planRecoverySpace({ ...input, beforeBytes: 136 * MiB + 1 }),
    ).toThrow();
    expect(() =>
      space.planRecoverySpace({ ...input, rawBytes: 72 * MiB + 1 }),
    ).toThrow();
    expect(space.RECOVERY_LIMIT_BYTES).toBe(512 * MiB);
  });

  it("restores intent3 by the same exact identity and cannot borrow or rebind an old profile", async () => {
    let space = await freshSpace();
    const fixture = await workspace();
    const lease = await space.reserveRecoverySpace(
      fixture.root,
      { ...input, backingDevice: fixture.device },
      owner,
    );
    const filename = path.join(
        fixture.directory,
        "isolated-space-reservations",
        lease.id + ".json",
      ),
      saved = await readFile(filename, "utf8");
    expect(JSON.parse(saved)).toMatchObject({
      version: 3,
      owner,
      plan: { version: 2, profileId: media64 },
    });
    await expect(lease.bind({ sourceProfileId: legacy })).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(saved);
    space = await freshSpace();
    await space.restoreRecoverySpaceReservations([fixture.root]);
    const context = {
      namespace: owner.namespace,
      projectId: owner.projectId,
      generation: owner.generation,
      snapshotId: owner.rawSnapshotId,
      sourceContract: {
        version: 2 as const,
        profileId: media64,
        baseManifestId: owner.sourceBaseManifestId,
        rawManifestId: owner.sourceResultManifestId,
      },
    };
    await expect(
      space.reservationForPublication(fixture.root, lease.id, {
        ...context,
        sourceContract: { ...context.sourceContract, profileId: legacy },
      }),
    ).rejects.toThrow("not exactly bound");
    const restored = await space.reservationForPublication(
      fixture.root,
      lease.id,
      context,
    );
    expect(restored.id).toBe(lease.id);
    expect(await readFile(filename, "utf8")).toBe(saved);
    await restored.release();
    expect(await readdir(path.dirname(filename))).toEqual([]);
    expect(await readFile(path.join(fixture.root, "main.js"), "utf8")).toBe(
      "original",
    );
  });

  it("counts and restores physical-only promises under the same new profile without JSON completion", async () => {
    let space = await freshSpace();
    const source = await workspace(),
      volume = await workspace();
    const sourceLease = await space.reserveRecoverySpace(
      source.root,
      { ...input, backingDevice: source.device },
      owner,
    );
    const volumeOwner = {
      namespace: "test" as const,
      projectId: "22222222-2222-4222-8222-222222222222",
      profileId: media64,
      planId: "33333333-3333-4333-8333-333333333333",
      purpose: "migration" as const,
    };
    const volumeLease = await space.reserveVolumeMigrationSpace(
      volume.root,
      { physicalBytes: 512 * MiB, hostInodes: 8, backingDevice: volume.device },
      volumeOwner,
    );
    const before = await space.inspectVolumeMigrationHeadroom(source.root);
    expect(before).toMatchObject({
      status: "complete",
      physicalOutstandingBytes:
        sourceLease.plan.diskBytes + volumeLease.physicalBytes,
      inodeOutstanding:
        sourceLease.plan.additionalEntries + 2 + volumeLease.hostInodes,
    });
    space = await freshSpace();
    await space.restoreRecoverySpaceReservations([source.root, volume.root]);
    expect(await space.inspectVolumeMigrationHeadroom(source.root)).toEqual(
      before,
    );
    await expect(
      space.reconnectVolumeMigrationSpace(
        volume.root,
        { ...volumeOwner, profileId: legacy },
        volume.device,
      ),
    ).rejects.toThrow("another exact owner");
    const restored = (await space.reconnectVolumeMigrationSpace(
      volume.root,
      volumeOwner,
      volume.device,
    ))!;
    await expect(
      restored.release({ committed: true } as never),
    ).rejects.toThrow("exact volume terminal proof");
    await restored.release(
      space.createVolumeMigrationSpaceTerminalProof(
        restored,
        "revoked-not-started",
      ),
    );
    const sourceRestored = await space.reservationForPublication(
      source.root,
      sourceLease.id,
      {
        namespace: owner.namespace,
        projectId: owner.projectId,
        generation: owner.generation,
        snapshotId: owner.rawSnapshotId,
        sourceContract: {
          version: 2,
          profileId: media64,
          baseManifestId: owner.sourceBaseManifestId,
          rawManifestId: owner.sourceResultManifestId,
        },
      },
    );
    await sourceRestored.release();
  });

  it("rejects a mismatched or unknown profile before creating a new intent", async () => {
    const space = await freshSpace(),
      fixture = await workspace();
    await expect(
      space.reserveRecoverySpace(
        fixture.root,
        { ...input, profileId: legacy, backingDevice: fixture.device },
        owner,
      ),
    ).rejects.toThrow("differs from its original operation");
    await expect(
      space.reserveRecoverySpace(
        fixture.root,
        { ...input, backingDevice: fixture.device },
        { ...owner, sourceProfileId: "unknown-profile" as never },
      ),
    ).rejects.toThrow("invalid host reservation owner");
    expect(await readdir(fixture.directory)).toEqual(["workspace"]);
  });
});
