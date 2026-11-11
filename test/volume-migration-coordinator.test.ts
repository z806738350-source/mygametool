import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeCapacityProfile } from "../src/shared/execution-capacity-profiles.js";
import { inspectVolumeMigrationSpaces } from "../src/daemon/recovery-space.js";
import {
  VolumeMigrationCoordinator,
  type AskVolumeMigration,
  type CapacityMigrationBackend,
  type CapacityMigrationRawPlan,
  type CapacityMigrationScope,
} from "../src/daemon/volume-migration-coordinator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const MiB = 1024 * 1024;
async function fixture(
  options: {
    absent?: boolean;
    planLost?: boolean;
    registerLost?: boolean;
    executeLost?: boolean;
    backingMismatch?: boolean;
    firstPlanBlocked?: boolean;
    secondPlanSourceChanged?: boolean;
    profile?: "capacity-128-v2" | "capacity-128-media64-v3";
    overview?: "current" | "unknown" | "old512" | "new512";
  } = {},
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "native-volume-coordinator-")),
  );
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  const project = { id: randomUUID(), workspacePath };
  const profile = getRuntimeCapacityProfile(options.profile ?? "capacity-128-v2");
  let plan: CapacityMigrationRawPlan | undefined,
    planCalls = 0,
    verifiedReady = true,
    phase = "planned",
    authorizationId: string | undefined,
    result: unknown;
  const initial = options.absent
    ? ({
        absent: true,
        generation: 0,
        imageId: null,
        imageSha256: null,
        sourceSnapshotId: null,
        sourceManifestVersion: null,
        sourceBaseManifestId: null,
        volumeBytes: 0,
      } as const)
    : {
        absent: false,
        generation: 7,
        imageId: "legacy",
        imageSha256: "a".repeat(64),
        sourceSnapshotId: "b".repeat(64),
        sourceManifestVersion: 1 as const,
        sourceBaseManifestId: "c".repeat(64),
        volumeBytes: 256 * MiB,
      };
  const backend: CapacityMigrationBackend = {
    planCapacityMigration: vi.fn(async (_project, request) => {
      planCalls++;
      const blocked = options.firstPlanBlocked && planCalls === 1;
      const freshSource =
        options.secondPlanSourceChanged && planCalls > 1 && !initial.absent
          ? {
              ...initial,
              generation: initial.generation + 1,
              imageSha256: "f".repeat(64),
            }
          : initial;
      plan = {
        version: 1,
        planId: request.planId,
        namespace: request.namespace,
        projectId: request.projectId,
        sourceProfileId: profile.id,
        kind: initial.absent ? "create" : "enlarge",
        status: blocked ? "blocked" : "ready",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        source: freshSource,
        target: {
          sourceProfileId: profile.id,
          volumeId: "d".repeat(32),
          limits: profile,
          targetBaseManifestId: "e".repeat(64),
        },
        budget: {
          logicalBeforeBytes: initial.volumeBytes,
          logicalAfterBytes: initial.volumeBytes + 512 * MiB,
          residentBefore: initial.absent ? 0 : 1,
          residentDuring: initial.absent ? 1 : 2,
          availableBytes: 16 * 1024 * MiB,
          availableInodes: 100_000,
          requiredGrowthBytes: 512 * MiB,
          reserveBytes: 1024 * MiB,
        },
        blockers: blocked ? ["GUEST_STORAGE_FULL"] : [],
      };
      if (options.planLost) throw new Error("plan reply lost");
      return structuredClone(plan);
    }),
    inspectCapacityPlan: vi.fn(async (_project, request) => {
      if (!plan || plan.planId !== request.planId)
        throw new Error("unknown plan");
      return {
        ...structuredClone(plan),
        phase,
        expired: false,
        verified: phase === "committed" && verifiedReady,
        ...(authorizationId ? { authorizationId } : {}),
        ...(result ? { result } : {}),
      };
    }),
    registerCapacityAuthorization: vi.fn(async (_project, request) => {
      authorizationId = request.authorizationId;
      phase = "authorized";
      if (options.registerLost) throw new Error("register reply lost");
      return { registered: true, planId: request.planId, authorizationId };
    }),
    executeCapacityPlan: vi.fn(async (_project, request) => {
      phase = "committed";
      result = makeResult(request);
      if (options.executeLost) throw new Error("execute reply lost");
      return result;
    }),
    ...(options.profile === "capacity-128-media64-v3" ? { supportsCapacityProfile: vi.fn(async () => true), storageOverview: vi.fn(async () => ({
      dataStatus: options.overview === "unknown" ? "stale" : "current",
      snapshot: { capacityOverviewVersion: 1, countsTrusted: true, capacityReservations: [], projects: options.absent ? [] : [{ namespace: "test", projectId: project.id, volumeProfileVersion: options.overview === "old512" ? 2 : options.overview === "new512" ? 3 : 0, sourceProfileId: options.overview === "old512" ? "capacity-128-v2" : options.overview === "new512" ? "capacity-128-media64-v3" : null, volumeBytes: options.overview === "old512" || options.overview === "new512" ? 512 * MiB : 256 * MiB }] },
      unallocatedProjects: options.absent ? [{ projectId: project.id, projectName: "" }] : [],
    } as unknown as import("../src/shared/execution-storage.js").ExecutionStorageOverview)) } : {}),
  };
  function makeResult(
    request: CapacityMigrationScope & { authorizationId: string },
  ) {
    return {
      migrated: true,
      planId: request.planId,
      authorizationId: request.authorizationId,
      kind: plan!.kind,
      namespace: request.namespace,
      projectId: request.projectId,
      generation: plan!.source.absent ? 1 : plan!.source.generation + 1,
      volumeId: plan!.target.volumeId,
      volumeBytes: 512 * MiB,
      sourceProfileId: plan!.sourceProfileId,
      sourceManifestVersion: 2,
      sourceBaseManifestId: plan!.target.targetBaseManifestId,
      originalRetained: !plan!.source.absent,
    };
  }
  const coordinator = new VolumeMigrationCoordinator({
    namespace: "test",
    backend,
    localImageAnchor: async (p) => ({
      projectId: p.id,
      workspace: p.workspacePath,
      storage: path.join(root, "image-recovery", p.id),
    }),
    backingDevice: async () =>
      (await lstat(workspacePath)).dev + (options.backingMismatch ? 1 : 0),
  });
  const approve = vi.fn<AskVolumeMigration>(async (review) => ({
    decision: "allow",
    volumeMigrationConfirmation: {
      planId: review.planId,
      generation: review.generation,
      sourceImageSha256: review.source.imageSha256,
      targetProfileId: review.target.profileId,
      capacityReviewed: true,
      oldVolumeRetained: true,
    },
  }));
  const finishMock = () => {
    if (!plan || !authorizationId) throw new Error("no original auth");
    phase = "committed";
    result = makeResult({
      namespace: plan.namespace,
      projectId: plan.projectId,
      planId: plan.planId,
      authorizationId,
    });
  };
  return {
    root,
    project,
    backend,
    coordinator,
    approve,
    finishMock,
    setVerified: (value: boolean) => {
      verifiedReady = value;
    },
    getPlan: () => plan,
    setGuestPhase: (next: string, nextAuthorizationId?: string) => {
      phase = next;
      authorizationId = nextAuthorizationId;
    },
  };
}

it.each([false, true])(
  "requires exact native approval and verifies a fresh committed %s plan before release",
  async (absent) => {
    const f = await fixture({ absent });
    const result = await f.coordinator.requestUpgrade(f.project, f.approve);
    expect(result.status).toBe("committed");
    expect(result.review.resources.recoveryRequiredBytes).toBe(598 * MiB);
    expect(result.review.source.volumeBytes).toBe(absent ? 0 : 256 * MiB);
    expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.backend.planCapacityMigration).mock.calls[0]![1]).toEqual({ namespace: "test", projectId: f.project.id, planId: f.getPlan()!.planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" });
    expect(f.backend.registerCapacityAuthorization).toHaveBeenCalledTimes(1);
    expect(f.backend.executeCapacityPlan).toHaveBeenCalledTimes(1);
    expect(
      (await inspectVolumeMigrationSpaces(f.project.workspacePath))
        .reservations,
    ).toEqual([]);
    expect(await f.coordinator.inspectUpgrade(f.project)).toMatchObject({
      committed: true,
      guestPhase: "committed",
    });
    await expect(
      f.coordinator.requestUpgrade(f.project, f.approve),
    ).rejects.toThrow();
    expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])("requests the exact v3 profile with native approval and preserves its receipt (create=%s)", async (absent) => {
  const f = await fixture({ absent, profile: "capacity-128-media64-v3" });
  const result = await f.coordinator.requestUpgrade(f.project, f.approve, undefined, "capacity-128-media64-v3");
  expect(result.status).toBe("committed");
  expect(result.review.target).toMatchObject({ profileId: "capacity-128-media64-v3", mediaFileBytes: 32 * MiB, largeMediaFileBytes: 64 * MiB, mediaWindowBytes: 64 * MiB, largeMediaFilePolicy: "video-audio-glb-v1" });
  expect(f.backend.planCapacityMigration).toHaveBeenCalledWith(f.project, expect.objectContaining({ capacityProfileVersion: 3, sourceProfileId: "capacity-128-media64-v3" }), undefined);
  const request = vi.mocked(f.backend.planCapacityMigration).mock.calls[0]![1];
  expect(Object.hasOwn(request, "targetProfileId")).toBe(false);
  expect((await f.coordinator.inspectUpgrade(f.project)).committed).toBe(true);
});

it.each(["old512", "new512", "unknown"] as const)("refuses v3 planning before any receipt for %s storage", async (overview) => {
  const f = await fixture({ profile: "capacity-128-media64-v3", overview });
  await expect(f.coordinator.requestUpgrade(f.project, f.approve, undefined, "capacity-128-media64-v3")).rejects.toThrow(overview === "unknown" ? "unknown" : "512 MiB");
  expect(f.backend.planCapacityMigration).not.toHaveBeenCalled();
  expect(f.approve).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["workspace"]);
});

it("retains the v3 target in the original receipt when the plan reply is lost", async () => {
  const f = await fixture({ profile: "capacity-128-media64-v3", planLost: true });
  await expect(f.coordinator.requestUpgrade(f.project, f.approve, undefined, "capacity-128-media64-v3")).rejects.toThrow("plan reply lost");
  const inspected = await f.coordinator.inspectUpgrade(f.project);
  expect(inspected.guestPhase).toBe("planned");
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.approve).not.toHaveBeenCalled();
});

it("does not create a v3 planning receipt when the guest capability is absent or unknown", async () => {
  const f = await fixture({ profile: "capacity-128-media64-v3" });
  vi.mocked(f.backend.supportsCapacityProfile!).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline"));
  for (const reason of ["unavailable", "unknown"]) {
    await expect(f.coordinator.requestUpgrade(f.project, f.approve, undefined, "capacity-128-media64-v3")).rejects.toThrow(reason);
    expect(await readdir(f.root)).toEqual(["workspace"]);
  }
  expect(f.backend.planCapacityMigration).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
});

it("never interprets a lost v3 plan as a legacy receipt", async () => {
  const f = await fixture({ profile: "capacity-128-media64-v3", planLost: true });
  await expect(f.coordinator.requestUpgrade(f.project, f.approve, undefined, "capacity-128-media64-v3")).rejects.toThrow("plan reply lost");
  const file = path.join(f.root, "isolated-volume-migrations", `test-${f.project.id}.json`);
  const receipt = JSON.parse(await readFile(file, "utf8"));
  expect(receipt.targetProfileId).toBe("capacity-128-media64-v3");
  delete receipt.targetProfileId; await writeFile(file, JSON.stringify(receipt));
  await expect(f.coordinator.inspectUpgrade(f.project)).rejects.toThrow("recorded target profile");
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("never treats session allowance or a mismatched confirmation as migration consent", async () => {
  const f = await fixture();
  const ask: AskVolumeMigration = async (review) => ({
    decision: "allow-session",
    volumeMigrationConfirmation: {
      planId: review.planId,
      generation: review.generation,
      sourceImageSha256: review.source.imageSha256,
      targetProfileId: "capacity-128-v2",
      capacityReviewed: true,
      oldVolumeRetained: true,
    },
  });
  expect((await f.coordinator.requestUpgrade(f.project, ask)).status).toBe(
    "declined",
  );
  expect(f.backend.registerCapacityAuthorization).not.toHaveBeenCalled();
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("keeps a lost plan reply inspect-only under the original durable plan ID", async () => {
  const f = await fixture({ planLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("plan reply lost");
  const inspection = await f.coordinator.inspectUpgrade(f.project);
  expect(inspection).toMatchObject({
    planId: f.getPlan()!.planId,
    phase: "planning",
    guestPhase: "planned",
    committed: false,
  });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow();
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("keeps a lost registration response under the original authorization and never executes automatically", async () => {
  const f = await fixture({ registerLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("register reply lost");
  expect(await f.coordinator.inspectUpgrade(f.project)).toMatchObject({
    phase: "registering",
    guestPhase: "authorized",
    committed: false,
  });
  expect(f.backend.registerCapacityAuthorization).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toHaveLength(1);
  f.finishMock();
  expect(await f.coordinator.inspectUpgrade(f.project)).toMatchObject({
    committed: true,
  });
});

it("reconciles a lost execution response only by fresh exact committed inspection", async () => {
  const f = await fixture({ executeLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("execute reply lost");
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toHaveLength(1);
  expect(await f.coordinator.inspectUpgrade(f.project)).toMatchObject({
    committed: true,
    guestPhase: "committed",
  });
  expect(f.backend.executeCapacityPlan).toHaveBeenCalledTimes(1);
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toEqual([]);
});

it("does not release a committed record until fresh physical verification succeeds", async () => {
  const f = await fixture({ executeLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("execute reply lost");
  f.setVerified(false);
  await expect(f.coordinator.inspectUpgrade(f.project)).rejects.toThrow();
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toHaveLength(1);
  f.setVerified(true);
  expect(await f.coordinator.inspectUpgrade(f.project)).toMatchObject({
    committed: true,
  });
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toEqual([]);
});

it("prevents concurrent request and inspection while the native approval is pending", async () => {
  const f = await fixture();
  let proceed!: () => void, shown!: () => void;
  const ready = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const ask: AskVolumeMigration = async () => {
    shown();
    await gate;
    return { decision: "deny" };
  };
  const pending = f.coordinator.requestUpgrade(f.project, ask);
  await ready;
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("already in progress");
  await expect(f.coordinator.inspectUpgrade(f.project)).rejects.toThrow(
    "already in progress",
  );
  proceed();
  expect((await pending).status).toBe("declined");
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("blocks cross-device uncertainty before showing an approval or creating a promise", async () => {
  const f = await fixture({ backingMismatch: true });
  const result = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(result.status).toBe("blocked");
  expect(result.review.status).toBe("unknown");
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.backend.registerCapacityAuthorization).not.toHaveBeenCalled();
  expect(
    (await inspectVolumeMigrationSpaces(f.project.workspacePath)).reservations,
  ).toEqual([]);
});

it("persists a private scoped original receipt without putting files in the workspace", async () => {
  const f = await fixture({ planLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow();
  const receipt = path.join(
    f.root,
    "isolated-volume-migrations",
    `test-${f.project.id}.json`,
  );
  expect((await lstat(receipt)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
    planId: f.getPlan()!.planId,
    phase: "planning",
    authorizationId: null,
  });
});

it("allows a fresh explicit request after a declined plan only after inspecting and archiving the original", async () => {
  const f = await fixture();
  expect(
    (
      await f.coordinator.requestUpgrade(f.project, async () => ({
        decision: "deny",
      }))
    ).status,
  ).toBe("declined");
  const oldPlan = f.getPlan()!.planId;
  const directory = path.join(f.root, "isolated-volume-migrations"),
    current = path.join(directory, `test-${f.project.id}.json`);
  const original = await readFile(current);
  const result = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(result.status).toBe("committed");
  expect(result.review.planId).not.toBe(oldPlan);
  const archive = path.join(
    directory,
    `test-${f.project.id}.plan-${oldPlan}.json`,
  );
  expect(await readFile(archive)).toEqual(original);
  expect((await lstat(archive)).nlink).toBe(1);
  expect((await lstat(archive)).mode & 0o777).toBe(0o600);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(2);
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(f.backend.registerCapacityAuthorization).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).toHaveBeenCalledTimes(1);
});

it("permits explicit replanning after a known blocked plan, with a fresh native approval", async () => {
  const f = await fixture({ firstPlanBlocked: true });
  const first = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(first.status).toBe("blocked");
  expect(f.approve).not.toHaveBeenCalled();
  const second = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(second.status).toBe("committed");
  expect(second.review.planId).not.toBe(first.review.planId);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(2);
  expect(f.approve).toHaveBeenCalledTimes(1);
});

it("does not replan when the original guest plan gained an authorization", async () => {
  const f = await fixture();
  await f.coordinator.requestUpgrade(f.project, async () => ({
    decision: "deny",
  }));
  const originalPlan = f.getPlan()!.planId;
  f.setGuestPhase("authorized", "a".repeat(32));
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow(originalPlan);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("stops on a linked uncertain original receipt without exposing the host path", async () => {
  const f = await fixture();
  await f.coordinator.requestUpgrade(f.project, async () => ({
    decision: "deny",
  }));
  const planId = f.getPlan()!.planId,
    directory = path.join(f.root, "isolated-volume-migrations");
  const current = path.join(directory, `test-${f.project.id}.json`),
    archive = path.join(directory, `test-${f.project.id}.plan-${planId}.json`);
  await link(current, archive);
  let message = "";
  try {
    await f.coordinator.requestUpgrade(f.project, f.approve);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/original plan.*inspection/);
  expect(message).not.toContain(f.root);
  expect((await lstat(current)).nlink).toBe(2);
  expect(await readFile(archive)).toEqual(await readFile(current));
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("does not replan a blocked review whose capacity evidence is partly unknown", async () => {
  const f = await fixture({ firstPlanBlocked: true, backingMismatch: true });
  const result = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(result.status).toBe("blocked");
  expect(result.review.status).toBe("blocked");
  expect(result.review.resources.hostAvailableBytes).toBeNull();
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow(result.review.planId);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.approve).not.toHaveBeenCalled();
});

it("stops rather than recreating a plan if a crash left only its original archive", async () => {
  const f = await fixture();
  await f.coordinator.requestUpgrade(f.project, async () => ({
    decision: "deny",
  }));
  const planId = f.getPlan()!.planId,
    directory = path.join(f.root, "isolated-volume-migrations");
  const current = path.join(directory, `test-${f.project.id}.json`),
    archive = path.join(directory, `test-${f.project.id}.plan-${planId}.json`);
  await link(current, archive);
  await unlink(current);
  let message = "";
  try {
    await f.coordinator.requestUpgrade(f.project, f.approve);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/original plan/);
  expect(message).not.toContain(f.root);
  expect((await lstat(archive)).nlink).toBe(1);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
});

it("does not replace an uncertain registered authorization with another plan", async () => {
  const f = await fixture({ registerLost: true });
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow("register reply lost");
  const planId = f.getPlan()!.planId;
  await expect(
    f.coordinator.requestUpgrade(f.project, f.approve),
  ).rejects.toThrow(planId);
  expect(f.backend.planCapacityMigration).toHaveBeenCalledTimes(1);
  expect(f.backend.registerCapacityAuthorization).toHaveBeenCalledTimes(1);
  expect(f.backend.executeCapacityPlan).not.toHaveBeenCalled();
  f.finishMock();
  await f.coordinator.inspectUpgrade(f.project);
});

it("replans from a fresh source identity and asks approval for that changed source", async () => {
  const f = await fixture({ secondPlanSourceChanged: true });
  const first = await f.coordinator.requestUpgrade(f.project, async () => ({
    decision: "deny",
  }));
  expect(first.review.generation).toBe(7);
  expect(first.review.source.imageSha256).toBe("a".repeat(64));
  const second = await f.coordinator.requestUpgrade(f.project, f.approve);
  expect(second.status).toBe("committed");
  expect(second.review.generation).toBe(8);
  expect(second.review.source.imageSha256).toBe("f".repeat(64));
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(f.backend.registerCapacityAuthorization).toHaveBeenCalledTimes(1);
});
