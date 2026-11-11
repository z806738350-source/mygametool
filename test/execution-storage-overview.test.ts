import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectExecutionCapacity,
  planInitialExecutionCapacity,
  proposeExecutionCapacity,
} from "../src/daemon/execution-capacity.js";
import { afterEach, expect, it, vi } from "vitest";
import { executionStorageSnapshot } from "../src/daemon/execution-storage-overview.js";
import { IsolatedProjectExecution } from "../src/daemon/isolated-project-execution.js";
import {
  CAPACITY_PROFILES,
  getCapacityProfile,
  planExecutionCapacityProposal,
  type CapacityProfileObservation,
} from "../src/shared/execution-capacity-profiles.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
afterEach(() => {
  spawn.mockReset();
  vi.useRealTimers();
});

const a = "5e849fb8-9236-4f0e-a58a-76cb223b8a74";
const b = "3f6af027-a321-4511-9804-164bc0ae7590";
const c = "fd61d4ab-23f4-4d0e-9812-9c937b01b4f4";
const observedAt = "2026-11-04T10:00:00.000Z";

const MiB = 1024 ** 2;
function observedCapacity(): CapacityProfileObservation {
  return {
    content: {
      complete: true,
      sourceBytes: 4 * MiB,
      mediaBytes: 64 * MiB,
      files: 100,
      entries: 200,
    },
    currentVolume: {
      bytes: 256 * MiB,
      allocatedBytes: 128 * MiB,
      usedBytes: 100 * MiB,
      usedInodes: 1000,
      clean: true,
      active: false,
      pending: false,
    },
    guest: {
      availableBytes: 4096 * MiB,
      availableInodes: 10000,
      reservedPhysicalBytes: 0,
      unallocatedOtherVolumeBytes: 0,
      reservedInodes: 0,
      logicalVolumeBytes: 256 * MiB,
      residentVolumes: 1,
      activeOperations: 0,
    },
    host: {
      availableBytes: 4096 * MiB,
      availableInodes: 10000,
      reservedBytes: 0,
      reservedInodes: 0,
    },
    workload: {
      dependencyBytes: 16 * MiB,
      cacheBytes: 8 * MiB,
      buildBytes: 16 * MiB,
      stagingBytes: 32 * MiB,
      additionalInodes: 2000,
    },
    recovery: { usedBytes: 0, transactionBytes: 470 * MiB },
  };
}

it("keeps three immutable candidate profiles separate from production activation and authorization", () => {
  expect(
    CAPACITY_PROFILES.map((p) => [
      p.mediaBytes / MiB,
      p.volumeBytes / MiB,
      p.inodeCount,
    ]),
  ).toEqual([
    [64, 256, 8192],
    [128, 512, 16384],
    [256, 1024, 32768],
  ]);
  expect(Object.isFrozen(CAPACITY_PROFILES)).toBe(true);
  for (const profile of CAPACITY_PROFILES) {
    expect(Object.isFrozen(profile)).toBe(true);
    expect(profile).toMatchObject({
      runtimeEnabled: false,
      simulationOnly: true,
      recoveryBytes: 512 * MiB,
      mediaWindowBytes: 64 * MiB,
      mediaFileBytes: 32 * MiB,
    });
    expect(
      planExecutionCapacityProposal({
        profileId: profile.id,
        observed: observedCapacity(),
      }),
    ).toMatchObject({
      assessment: "fits-observed-budgets",
      runtimeEnabled: false,
      readyForMigration: false,
      authorization: "none",
    });
  }
  expect(() => getCapacityProfile("current-64")).toThrow("Unknown");
  expect(() => getCapacityProfile({ id: "capacity-256-v1" })).toThrow(
    "Unknown",
  );
});

it("does not turn incomplete content, unknown peaks or missing inode evidence into a fitting profile", () => {
  expect(
    planExecutionCapacityProposal({ profileId: "capacity-128-v1" }),
  ).toMatchObject({
    assessment: "unknown",
    contentOnlySmallestProfileId: null,
  });
  const observed = observedCapacity();
  observed.content!.complete = false;
  observed.workload = undefined;
  observed.host!.availableInodes = null;
  const result = planExecutionCapacityProposal({
    profileId: "capacity-128-v1",
    observed,
  });
  expect(result.assessment).toBe("unknown");
  expect(result.contentOnlySmallestProfileId).toBeNull();
  for (const code of [
    "inventory-incomplete",
    "volume-peak-bytes",
    "volume-peak-inodes",
    "host-filesystem-inodes",
  ])
    expect(result.constraints.find((item) => item.code === code)?.status).toBe(
      "unknown",
    );
});

it.each(["clean", "active", "pending"] as const)(
  "blocks migration of a volume whose %s state is unsuitable without repairing it",
  (key) => {
    const observed = observedCapacity();
    observed.currentVolume![key] = key === "clean" ? false : true;
    expect(
      planExecutionCapacityProposal({
        profileId: "capacity-128-v1",
        observed,
      }).constraints.find((item) => item.code === `volume-${key}`)?.status,
    ).toBe("blocked");
  },
);

it("charges the old ledger and full target together, including outstanding backup images", () => {
  const observed = observedCapacity();
  observed.guest!.logicalVolumeBytes = 3 * 1024 * MiB;
  expect(
    planExecutionCapacityProposal({
      profileId: "capacity-256-v1",
      observed,
    }).constraints.find((item) => item.code === "global-volume-logical"),
  ).toMatchObject({ status: "pass", required: 4096 * MiB });
  observed.guest!.logicalVolumeBytes! += 1;
  expect(
    planExecutionCapacityProposal({
      profileId: "capacity-256-v1",
      observed,
    }).constraints.find((item) => item.code === "global-volume-logical")
      ?.status,
  ).toBe("blocked");
});

it("separates byte-rich inode exhaustion, dependency/build peaks and concurrent operation slots", () => {
  const observed = observedCapacity();
  observed.workload!.additionalInodes = 9000;
  const small = planExecutionCapacityProposal({
    profileId: "capacity-64-v1",
    observed,
  });
  expect(
    small.constraints.find((item) => item.code === "volume-peak-bytes")?.status,
  ).toBe("pass");
  expect(
    small.constraints.find((item) => item.code === "volume-peak-inodes")
      ?.status,
  ).toBe("blocked");
  expect(
    planExecutionCapacityProposal({
      profileId: "capacity-128-v1",
      observed,
    }).constraints.find((item) => item.code === "volume-peak-inodes")?.status,
  ).toBe("pass");
  observed.workload!.buildBytes = 512 * MiB;
  observed.guest!.activeOperations = 2;
  const blocked = planExecutionCapacityProposal({
    profileId: "capacity-128-v1",
    observed,
  });
  for (const code of ["volume-peak-bytes", "global-operations"])
    expect(blocked.constraints.find((item) => item.code === code)?.status).toBe(
      "blocked",
    );
});

it.each([
  [64, 470, "pass"],
  [128, 854, "blocked"],
  [256, 1622, "blocked"],
] as const)(
  "never treats cumulative %i MiB as permission for a %i MiB recovery envelope",
  (media, envelope, status) => {
    const observed = observedCapacity();
    observed.content!.mediaBytes = media * MiB;
    observed.recovery!.transactionBytes = envelope * MiB;
    const result = planExecutionCapacityProposal({
      profileId: `capacity-${media}-v1`,
      observed,
    });
    expect(
      result.constraints.find((item) => item.code === "recovery-envelope")
        ?.status,
    ).toBe(status);
    expect(result.readyForMigration).toBe(false);
  },
);

it("keeps current promises and physical free space separate from the logical volume quota", () => {
  const observed = observedCapacity();
  observed.guest!.availableBytes = 1600 * MiB;
  expect(
    planExecutionCapacityProposal({
      profileId: "capacity-128-v1",
      observed,
    }).constraints.find((item) => item.code === "guest-physical-headroom")
      ?.status,
  ).toBe("blocked");
  observed.guest!.availableBytes = 4096 * MiB;
  observed.host!.reservedBytes = 4096 * MiB;
  expect(
    planExecutionCapacityProposal({
      profileId: "capacity-128-v1",
      observed,
    }).constraints.find((item) => item.code === "host-physical-headroom")
      ?.status,
  ).toBe("blocked");
});

it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid capacity quantities %s instead of treating them as unknown or unlimited",
  (value) => {
    const observed = observedCapacity();
    observed.guest!.availableBytes = value;
    expect(() =>
      planExecutionCapacityProposal({ profileId: "capacity-128-v1", observed }),
    ).toThrow("Invalid capacity");
  },
);
function project(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "manual",
    projectId: a,
    generation: 3,
    residency: "resident",
    transition: null,
    dirty: false,
    pinned: false,
    syncPending: false,
    tasks: [],
    ...overrides,
  };
}
function payload(projects: ReturnType<typeof project>[] = []) {
  const residentReserved = projects.filter(
    (p) =>
      p.residency !== "archived" ||
      (p.transition as { to?: string } | null)?.to === "resident",
  ).length;
  const countsTrusted = !projects.some(
    (p) =>
      p.transition ||
      p.syncPending ||
      ["creating", "recovery"].includes(p.residency as string) ||
      (p.tasks as { phase: string }[]).some(
        (t) => t.phase === "expired-uncertain",
      ),
  );
  return {
    protocolVersion: 2,
    scope: "global",
    ready: true,
    limits: {
      residentVolumes: 8,
      volumeBytes: 256 * 1024 * 1024,
      totalLogicalBytes: 4 * 1024 ** 3,
      reserveBytes: 1024 ** 3,
      globalOperations: 2,
      identityRange: [5000, 5095],
      operationHistory: 8192,
    },
    countsTrusted,
    counts: {
      allocatedProjects: projects.length,
      residentReserved,
      freeSlots: countsTrusted ? 8 - residentReserved : null,
      resident: projects.filter(
        (p) => p.residency === "resident" && !p.transition,
      ).length,
      sleeping: projects.filter(
        (p) => p.residency === "archived" && !p.transition,
      ).length,
    },
    projects,
  };
}
function fixture(namespace = "manual") {
  const vm = { ready: vi.fn(), close: vi.fn() };
  const execution = Reflect.construct(IsolatedProjectExecution, [
    "/unused-fixture",
    vm,
    namespace,
  ]) as IsolatedProjectExecution;
  const state = {
    status: "Running",
    value: payload(),
    failStatus: false,
    failGuest: false,
  };
  const calls: string[][] = [];
  spawn.mockImplementation((_binary: string, args: string[]) => {
    calls.push(args);
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (args[0] === "list") {
      queueMicrotask(() => {
        (child.stdout as PassThrough).end(
          JSON.stringify({ name: "omg", status: state.status }),
        );
        child.emit("close", state.failStatus ? 1 : 0);
      });
    } else {
      child.stdin.on("finish", () => {
        (child.stdout as PassThrough).end(
          JSON.stringify(
            state.failGuest
              ? {
                  error: {
                    code: "CONTROL_FAILED",
                    message: "/private/fixture-path",
                    changed: false,
                  },
                }
              : state.value,
          ),
        );
        queueMicrotask(() => child.emit("close", state.failGuest ? 1 : 0));
      });
    }
    return child;
  });
  return { execution, vm, state, calls };
}

it("counts global reservations rather than the folded busy/dirty display state", () => {
  const raw = payload([
    project({
      dirty: true,
      tasks: [
        { phase: "finished-awaiting-ack", mode: "shell", leaseExpiresAt: 2000 },
      ],
    }),
    project({
      namespace: "test",
      projectId: b,
      residency: "archived",
      dirty: true,
    }),
    project({
      projectId: c,
      residency: "archived",
      transition: { from: "archived", to: "resident" },
    }),
  ]);
  const result = executionStorageSnapshot(raw, observedAt);
  expect(result).toMatchObject({
    allocatedProjects: 3,
    residentReserved: 2,
    resident: 1,
    sleeping: 1,
    countsTrusted: false,
    freeResidentSlots: null,
  });
  expect(result.projects[0]).toMatchObject({
    residency: "resident",
    dirty: true,
    taskPhase: "finished-awaiting-ack",
  });
  expect(result.projects[1]).toMatchObject({
    residency: "archived",
    residentReserved: false,
    dirty: true,
  });
  expect(result.projects[2]).toMatchObject({
    residency: "archived",
    residentReserved: true,
  });
});

it.each(["creating", "recovery"])(
  "retains an unfinished %s deletion reservation without claiming a free slot",
  (residency) => {
    const result = executionStorageSnapshot(
      payload([
        project({ residency, transition: { from: residency, to: "deleted" } }),
      ]),
      observedAt,
    );
    expect(result).toMatchObject({
      residentReserved: 1,
      countsTrusted: false,
      freeResidentSlots: null,
    });
  },
);

it.each([
  "prepared",
  "running",
  "finished-awaiting-ack",
  "finished",
  "cancel-requested",
  "expired-uncertain",
])(
  "preserves task phase %s without equating every active lease to running",
  (phase) => {
    const result = executionStorageSnapshot(
      payload([
        project({ tasks: [{ phase, mode: "preview", leaseExpiresAt: 100 }] }),
      ]),
      observedAt,
    );
    expect(result.projects[0]).toMatchObject({
      taskPhase: phase,
      expiredTask: phase === "expired-uncertain",
    });
    expect(result.freeResidentSlots).toBe(
      phase === "expired-uncertain" ? null : 7,
    );
  },
);

it.each([
  (p: any) => {
    p.ready = false;
  },
  (p: any) => {
    p.scope = "manual";
  },
  (p: any) => {
    p.limits.residentVolumes = 9;
  },
  (p: any) => {
    p.limits.identityRange = [5000, 5094];
  },
  (p: any) => {
    p.counts.freeSlots = 8;
  },
  (p: any) => {
    p.counts.residentReserved = 0;
  },
  (p: any) => {
    p.projects[0].syncPending = true;
  },
  (p: any) => {
    p.projects[0].namespace = ["manual"];
  },
  (p: any) => {
    p.projects[0].leaseToken = "private-fixture-token";
  },
  (p: any) => {
    p.projects[0].residency = "unknown";
  },
  (p: any) => {
    p.projects.push(p.projects[0]);
  },
  (p: any) => {
    p.projects[0].tasks = [
      { phase: "running", mode: "host", leaseExpiresAt: 100 },
    ];
  },
  (p: any) => {
    p.projects[0].transition = { from: "archived", to: "resident" };
  },
  (p: any) => {
    p.projects[0].residency = "creating";
    p.projects[0].transition = { from: "creating", to: "archived" };
  },
])(
  "refuses malformed or contradictory guest data rather than returning empty capacity (%#)",
  (mutate) => {
    const raw = payload([project()]);
    mutate(raw);
    expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
  },
);

it("retains sync-pending data while withholding trusted capacity", () => {
  expect(
    executionStorageSnapshot(
      payload([project({ syncPending: true })]),
      observedAt,
    ),
  ).toMatchObject({
    countsTrusted: false,
    residentReserved: 1,
    freeResidentSlots: null,
  });
});

it("keeps a stable dirty sleeping volume legal and separate from resident capacity", () => {
  expect(
    executionStorageSnapshot(
      payload([project({ residency: "archived", dirty: true })]),
      observedAt,
    ),
  ).toMatchObject({
    countsTrusted: true,
    residentReserved: 0,
    sleeping: 1,
    freeResidentSlots: 8,
    projects: [
      expect.objectContaining({
        residency: "archived",
        dirty: true,
        taskPhase: "idle",
      }),
    ],
  });
});

it.each([
  { residency: "archived", transition: null },
  { residency: "resident", transition: { from: "resident", to: "archived" } },
])("rejects a task outside a stable resident volume (%#)", (location) => {
  const raw = payload([
    project({
      ...location,
      tasks: [{ phase: "running", mode: "shell", leaseExpiresAt: 100 }],
    }),
  ]);
  expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
});

it("rejects multiple active task records for one project", () => {
  const raw = payload([
    project({
      tasks: [
        { phase: "running", mode: "shell", leaseExpiresAt: 100 },
        { phase: "finished", mode: "shell", leaseExpiresAt: 100 },
      ],
    }),
  ]);
  expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
});

it.each([
  { count: 9, residency: "resident" },
  { count: 17, residency: "archived" },
])(
  "rejects an over-budget inventory even when counts are untrusted (%#)",
  ({ count, residency }) => {
    const raw = payload(
      Array.from({ length: count }, (_, index) =>
        project({
          projectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          residency,
        }),
      ),
    );
    raw.countsTrusted = false;
    raw.counts.freeSlots = null;
    expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
  },
);

it("queries only VM status when stopped, with no ownership, startup or guest commands", async () => {
  const { execution, state, vm, calls } = fixture();
  state.status = "Stopped";
  const result = await execution.storageOverview([
    { id: a, name: "Host project" },
  ]);
  expect(result).toMatchObject({
    supported: true,
    vmState: "stopped",
    dataStatus: "unavailable",
    reason: "vm-stopped",
    snapshot: null,
    unallocatedProjects: null,
  });
  expect(calls).toEqual([["list", "--json", "omg"]]);
  expect(vm.ready).not.toHaveBeenCalled();
  expect(vm.close).not.toHaveBeenCalled();
});

it("treats an unrecognized or transitional VM state as unknown without probing the guest", async () => {
  const { execution, state, calls, vm } = fixture();
  state.status = "Starting";
  expect(await execution.storageOverview([])).toMatchObject({
    vmState: "unknown",
    dataStatus: "unavailable",
    reason: "vm-unavailable",
    snapshot: null,
    unallocatedProjects: null,
  });
  expect(calls).toEqual([["list", "--json", "omg"]]);
  expect(vm.ready).not.toHaveBeenCalled();
});

it("reads both namespaces once and associates names only inside this host store", async () => {
  const { execution, state, calls, vm } = fixture();
  state.value = payload([
    project(),
    project({ namespace: "test" }),
    project({ projectId: b }),
  ]);
  const hosts = [
    { id: a, name: "Real name" },
    { id: c, name: "Never allocated" },
  ];
  const [result, simultaneous] = await Promise.all([
    execution.storageOverview(hosts),
    execution.storageOverview(hosts),
  ]);
  expect(calls.map((args) => (args[0] === "list" ? "list" : args[8]))).toEqual([
    "list",
    "overview",
  ]);
  expect(result).toEqual(simultaneous);
  expect(result.snapshot?.projects).toEqual([
    expect.objectContaining({
      namespace: "manual",
      projectName: "Real name",
      currentStore: true,
    }),
    expect.objectContaining({
      namespace: "test",
      projectName: null,
      currentStore: false,
    }),
    expect.objectContaining({
      projectId: b,
      projectName: null,
      currentStore: true,
    }),
  ]);
  expect(result.unallocatedProjects).toEqual([
    { projectId: c, projectName: "Never allocated" },
  ]);
  expect(vm.ready).not.toHaveBeenCalled();
});

it("maps the test store without borrowing a manual project's same UUID", async () => {
  const { execution, state } = fixture("test");
  state.value = payload([project(), project({ namespace: "test" })]);
  const result = await execution.storageOverview([
    { id: a, name: "Test name" },
  ]);
  expect(result.snapshot?.projects.map((p) => p.projectName)).toEqual([
    null,
    "Test name",
  ]);
});

it("retains an immutable timestamped process cache after stopped, failed and unknown VM reads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(observedAt));
  const { execution, state, calls } = fixture();
  state.value = payload([project()]);
  const first = await execution.storageOverview([]);
  first.snapshot!.limits.residentVolumes = 99;
  vi.setSystemTime(new Date("2026-11-04T10:05:00.000Z"));
  state.status = "Stopped";
  const stopped = await execution.storageOverview([
    { id: b, name: "Host only" },
  ]);
  expect(stopped).toMatchObject({
    dataStatus: "stale",
    vmState: "stopped",
    checkedAt: "2026-11-04T10:05:00.000Z",
    snapshot: {
      observedAt,
      limits: { residentVolumes: 8 },
      residentReserved: 1,
    },
    unallocatedProjects: null,
  });
  state.status = "Running";
  state.failGuest = true;
  const failed = await execution.storageOverview([]);
  expect(failed).toMatchObject({
    dataStatus: "stale",
    reason: "snapshot-unavailable",
    snapshot: { observedAt, residentReserved: 1 },
  });
  expect(JSON.stringify(failed)).not.toContain("/private/");
  state.failStatus = true;
  expect(await execution.storageOverview([])).toMatchObject({
    vmState: "unknown",
    dataStatus: "stale",
    reason: "vm-unavailable",
  });
  expect(calls.filter((args) => args[0] === "shell")).toHaveLength(2);
});

it("does not claim unallocated projects from an incomplete or unsupported overview", async () => {
  const { execution, state } = fixture();
  state.value = payload([project({ residency: "creating" })]);
  expect(
    await execution.storageOverview([{ id: b, name: "Host only" }]),
  ).toMatchObject({
    dataStatus: "current",
    reason: "review-required",
    unallocatedProjects: null,
    snapshot: {
      countsTrusted: false,
      residentReserved: 1,
      freeResidentSlots: null,
    },
  });
  state.value = { ...payload(), ready: false };
  expect(await execution.storageOverview([])).toMatchObject({
    dataStatus: "stale",
    snapshot: { residentReserved: 1 },
  });
  const fresh = fixture();
  fresh.state.failGuest = true;
  expect(await fresh.execution.storageOverview([])).toMatchObject({
    dataStatus: "unavailable",
    snapshot: null,
    unallocatedProjects: null,
  });
});

it("validates versioned mixed-volume totals and counts a staging target as an additional resident slot", () => {
  const MiB = 1024 * 1024;
  const active = project({
    volumeProfileVersion: 2,
    sourceProfileId: "capacity-128-v2",
    volumeId: "a".repeat(32),
    volumeBytes: 512 * MiB,
    retainedVolumeBytes: 256 * MiB,
    stagingVolumeBytes: 0,
    logicalBytes: 768 * MiB,
  });
  const moving = project({
    namespace: "test",
    projectId: b,
    volumeProfileVersion: 0,
    sourceProfileId: null,
    volumeId: "legacy",
    volumeBytes: 256 * MiB,
    retainedVolumeBytes: 0,
    stagingVolumeBytes: 512 * MiB,
    logicalBytes: 768 * MiB,
  });
  const raw = {
    ...payload([active, moving]),
    capacityOverviewVersion: 1,
    capacityReservations: [],
  };
  Object.assign(raw.counts, {
    residentReserved: 3,
    freeSlots: null,
    allocatedLogicalBytes: 1536 * MiB,
    retainedBackupBytes: 256 * MiB,
    stagingLogicalBytes: 512 * MiB,
  });
  raw.countsTrusted = false;
  const result = executionStorageSnapshot(raw, observedAt);
  expect(result).toMatchObject({
    capacityOverviewVersion: 1,
    residentReserved: 3,
    freeResidentSlots: null,
    allocatedLogicalBytes: 1536 * MiB,
    retainedBackupBytes: 256 * MiB,
    stagingLogicalBytes: 512 * MiB,
  });
  expect(result.projects[0]).toMatchObject({
    volumeProfileVersion: 2,
    sourceProfileId: "capacity-128-v2",
    volumeBytes: 512 * MiB,
    retainedVolumeBytes: 256 * MiB,
    residentReservationCount: 1,
  });
  expect(result.projects[1]).toMatchObject({
    volumeProfileVersion: 0,
    sourceProfileId: null,
    residentReservationCount: 2,
  });
  expect(result.limits.volumeBytes).toBe(256 * MiB);
});

it("validates a v3 media64 volume without relabeling legacy or v2 records", () => {
  const MiB = 1024 * 1024;
  const current = project({ volumeProfileVersion: 3, sourceProfileId: "capacity-128-media64-v3", volumeId: "a".repeat(32), volumeBytes: 512 * MiB, retainedVolumeBytes: 256 * MiB, stagingVolumeBytes: 0, logicalBytes: 768 * MiB });
  const raw = { ...payload([current]), capacityOverviewVersion: 1, capacityReservations: [] };
  Object.assign(raw.counts, { allocatedLogicalBytes: 768 * MiB, retainedBackupBytes: 256 * MiB, stagingLogicalBytes: 0 });
  expect(executionStorageSnapshot(raw, observedAt).projects[0]).toMatchObject({ volumeProfileVersion: 3, sourceProfileId: "capacity-128-media64-v3", volumeBytes: 512 * MiB });
  for (const invalid of ["capacity-128-v2", "capacity-128-media64-v4", null]) {
    expect(() => executionStorageSnapshot({ ...raw, projects: [{ ...current, sourceProfileId: invalid }] }, observedAt)).toThrow();
  }
  expect(() => executionStorageSnapshot({ ...raw, projects: [{ ...current, volumeProfileVersion: 2 }] }, observedAt)).toThrow();
});

it("counts an archived original with a pending target as one reserved slot", () => {
  const MiB = 1024 * 1024;
  const archived = project({
    residency: "archived",
    volumeProfileVersion: 0,
    sourceProfileId: null,
    volumeId: "legacy",
    volumeBytes: 256 * MiB,
    retainedVolumeBytes: 0,
    stagingVolumeBytes: 512 * MiB,
    logicalBytes: 768 * MiB,
  });
  const raw = {
    ...payload([archived]),
    capacityOverviewVersion: 1,
    capacityReservations: [],
    countsTrusted: false,
  };
  Object.assign(raw.counts, {
    residentReserved: 1,
    freeSlots: null,
    allocatedLogicalBytes: 768 * MiB,
    retainedBackupBytes: 0,
    stagingLogicalBytes: 512 * MiB,
  });
  expect(executionStorageSnapshot(raw, observedAt)).toMatchObject({
    residentReserved: 1,
    projects: [{ residentReserved: true, residentReservationCount: 1 }],
  });
});

it("rejects incomplete, mixed-version and inconsistent volume accounting", () => {
  const MiB = 1024 * 1024;
  const current = project({
    volumeProfileVersion: 2,
    sourceProfileId: "capacity-128-v2",
    volumeId: "a".repeat(32),
    volumeBytes: 512 * MiB,
    retainedVolumeBytes: 0,
    stagingVolumeBytes: 0,
    logicalBytes: 512 * MiB,
  });
  const base = {
    ...payload([current]),
    capacityOverviewVersion: 1,
    capacityReservations: [],
  };
  Object.assign(base.counts, {
    allocatedLogicalBytes: 512 * MiB,
    retainedBackupBytes: 0,
    stagingLogicalBytes: 0,
  });
  for (const mutate of [
    (raw: any) => {
      delete raw.projects[0].volumeBytes;
    },
    (raw: any) => {
      raw.projects[0].sourceProfileId = null;
    },
    (raw: any) => {
      raw.projects[0].logicalBytes++;
    },
    (raw: any) => {
      raw.counts.allocatedLogicalBytes++;
    },
    (raw: any) => {
      raw.capacityOverviewVersion = 2;
    },
    (raw: any) => {
      delete raw.capacityOverviewVersion;
    },
    (raw: any) => {
      raw.projects[0].stagingVolumeBytes = 512 * MiB;
      raw.projects[0].logicalBytes += 512 * MiB;
      raw.counts.allocatedLogicalBytes += 512 * MiB;
      raw.counts.stagingLogicalBytes = 512 * MiB;
      raw.counts.residentReserved++;
      raw.counts.freeSlots--;
    },
  ]) {
    const raw = structuredClone(base);
    mutate(raw);
    expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
  }
});

it("compares actual first-allocation envelopes from complete metadata without allocating a volume", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "first-capacity-plan-")));
  try {
    const workspace = path.join(root, "workspace"), media = path.join(workspace, "public");
    await mkdir(media, { recursive: true });
    const audio = path.join(media, "clip.wav"), raster = path.join(media, "atlas.png");
    await writeFile(audio, "");
    await truncate(audio, 40 * MiB);
    const report = await inspectExecutionCapacity({ projectId: "synthetic-first", workspace, localImageAnchor: async () => { throw new Error("No local image fixture"); } });
    const plan = planInitialExecutionCapacity(report);
    expect(plan).toMatchObject({ authorization: "none", recommendedProfileId: null, smallestObservedEnvelope: "capacity-128-media64-v3", allocation: "unknown", applicability: "unknown", evidence: { metadataOnly: true, atomicSnapshot: false, completeForObservedEnvelope: true, futureWorkload: "unknown", guestCapabilities: "not-probed" }, performance: { decodedMemory: "unknown", gpuMemory: "unknown", frameTime: "not-measured" } });
    expect(plan.choices.map(choice => [choice.profileId, choice.observedEnvelope.status])).toEqual([["current-64", "exceeds"], ["capacity-128-v2", "exceeds"], ["capacity-128-media64-v3", "within"]]);
    expect(plan.choices.every(choice => !choice.simulationOnly && !choice.readyForAllocation && choice.capabilityStatus === "not-probed")).toBe(true);
    const missingClassVersion = structuredClone(report);
    delete missingClassVersion.host.inventory!.scope.mediaClassMaximaVersion;
    expect(planInitialExecutionCapacity(missingClassVersion).choices[2]?.observedEnvelope.status).toBe("unknown");
    const excluded = structuredClone(report);
    excluded.host.inventory!.scope.unverifiedCanvasCandidateCount = 1;
    expect(planInitialExecutionCapacity(excluded)).toMatchObject({ smallestObservedEnvelope: null, evidence: { completeForObservedEnvelope: false } });
    expect(planInitialExecutionCapacity(excluded).choices[2]?.observedEnvelope.status).toBe("unknown");
    const partial = structuredClone(report);
    partial.host.inventory!.complete = false;
    expect(planInitialExecutionCapacity(partial).choices[0]?.observedEnvelope.status).toBe("exceeds");
    expect(planInitialExecutionCapacity(partial).choices[2]?.observedEnvelope.status).toBe("unknown");
    for (const allocation of ["absent", "present", "unknown"] as const) {
      const copy = structuredClone(report); copy.guest.allocation = allocation;
      expect(planInitialExecutionCapacity(copy)).toMatchObject({ allocation, newProjectOrigin: "not-established-by-empty-volume", recommendedProfileId: null, applicability: allocation === "present" ? "existing-volume-out-of-scope" : allocation === "absent" ? "unallocated-observation-only" : "unknown" });
    }
    await writeFile(raster, "");
    await truncate(raster, 40 * MiB);
    const rasterReport = await inspectExecutionCapacity({ projectId: "synthetic-first", workspace, localImageAnchor: async () => { throw new Error("No local image fixture"); } });
    const rasterPlan = planInitialExecutionCapacity(rasterReport);
    expect(rasterPlan.choices[2]?.observedEnvelope.status).toBe("exceeds");
    expect(rasterPlan.choices[2]?.observedEnvelope.constraints.find(item => item.code === "base-media-file")).toMatchObject({ observedBytesOrCount: 40 * MiB, limit: 32 * MiB, status: "exceeds" });
    expect(rasterPlan.smallestObservedEnvelope).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["capacity-128-v2", "capacity-128-media64-v3"] as const)("uses only a trusted current %s volume profile for passive diagnostics", async profileId => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "capacity-overview-profile-")),
  );
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await mkdir(path.join(workspace, "public"));
    for (const name of [profileId === "capacity-128-media64-v3" ? "a.wav" : "a.png", "b.png"]) {
      const file = path.join(workspace, "public", name);
      await writeFile(file, "");
      await truncate(file, name === "a.wav" ? 64 * MiB : 32 * MiB);
    }
    const extra = path.join(workspace, "public/c.png");
    await writeFile(extra, "");
    await truncate(extra, 1);
    const current = project({
      volumeProfileVersion: profileId === "capacity-128-media64-v3" ? 3 : 2,
      sourceProfileId: profileId,
      volumeId: "a".repeat(32),
      volumeBytes: 512 * MiB,
      retainedVolumeBytes: 256 * MiB,
      stagingVolumeBytes: 0,
      logicalBytes: 768 * MiB,
    });
    const raw = {
      ...payload([current]),
      capacityOverviewVersion: 1,
      capacityReservations: [],
    };
    Object.assign(raw.counts, {
      allocatedLogicalBytes: 768 * MiB,
      retainedBackupBytes: 256 * MiB,
      stagingLogicalBytes: 0,
    });
    const snapshot = executionStorageSnapshot(raw, observedAt);
    const overview = {
      supported: true,
      vmState: "running" as const,
      dataStatus: "current" as const,
      checkedAt: observedAt,
      snapshot,
      unallocatedProjects: [],
    };
    const readOverview = vi.fn(async () => overview);
    const options = {
      projectId: a,
      namespace: "manual" as const,
      workspace,
      localImageAnchor: async () => ({
        projectId: a,
        workspace,
        storage: path.join(root, "image-recovery", a),
      }),
      storageOverview: readOverview,
    };
    const report = await inspectExecutionCapacity(options);
    expect(readOverview).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      status: "observed",
      host: {
        limits: { mediaBytes: 128 * MiB },
        limitsBasis: "current-volume-profile",
        inventory: { mediaBytes: (profileId === "capacity-128-media64-v3" ? 96 : 64) * MiB + 1 },
      },
      transfer: {
        mediaSetLimitBytes: 128 * MiB,
        mediaFileLimitBytes: 32 * MiB,
        largeMediaFileLimitBytes: profileId === "capacity-128-media64-v3" ? 64 * MiB : null,
        mediaWindowLimitBytes: 64 * MiB,
        changedMediaReturnLimitBytes: 64 * MiB,
      },
      preservation: {
        conservativeNewOperationEnvelope: { requiredBytes: 598 * MiB },
      },
      recovery: { quota: { limitBytes: 1024 * MiB } },
      guest: {
        currentProfileId: profileId,
        project: { volumeBytes: 512 * MiB, retainedVolumeBytes: 256 * MiB },
      },
    });
    expect(report.host.inventory?.overage.mediaBytes).toBeUndefined();
    expect(report.host.inventory?.overage.mediaFileBytes).toBeUndefined();
    const stale = await inspectExecutionCapacity({
      ...options,
      storageOverview: async () => ({ ...overview, dataStatus: "stale" }),
    });
    expect(stale).toMatchObject({
      status: "partial",
      guest: { currentProfileId: null },
      transfer: { mediaSetLimitBytes: null },
      preservation: { conservativeNewOperationEnvelope: null },
      recovery: { quota: { limitBytes: null } },
    });
    expect(stale.issues).toContain("active-volume-profile-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not infer an old unversioned overview's actual volume profile", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "capacity-overview-legacy-")),
  );
  try {
    const snapshot = executionStorageSnapshot(payload([project()]), observedAt);
    const report = await inspectExecutionCapacity({
      projectId: a,
      namespace: "manual",
      workspace: root,
      localImageAnchor: async () => ({
        projectId: a,
        workspace: root,
        storage: path.join(root, "image-recovery", a),
      }),
      storageOverview: async () => ({
        supported: true,
        vmState: "running",
        dataStatus: "current",
        checkedAt: observedAt,
        snapshot,
        unallocatedProjects: [],
      }),
    });
    expect(report.guest.currentProfileId).toBeNull();
    expect(report.transfer.mediaSetLimitBytes).toBeNull();
    expect(report.contracts.currentRecoveryLimitBytes).toBeNull();
    expect(report.host.limitsBasis).toBe("legacy-host-default-profile-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports legacy limits when a trusted versioned overview explicitly identifies a legacy volume", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "capacity-overview-v0-")),
  );
  try {
    const old = project({
      volumeProfileVersion: 0,
      sourceProfileId: null,
      volumeId: "legacy",
      volumeBytes: 256 * MiB,
      retainedVolumeBytes: 0,
      stagingVolumeBytes: 0,
      logicalBytes: 256 * MiB,
    });
    const raw = {
      ...payload([old]),
      capacityOverviewVersion: 1,
      capacityReservations: [],
    };
    Object.assign(raw.counts, {
      allocatedLogicalBytes: 256 * MiB,
      retainedBackupBytes: 0,
      stagingLogicalBytes: 0,
    });
    const snapshot = executionStorageSnapshot(raw, observedAt);
    const report = await inspectExecutionCapacity({
      projectId: a,
      namespace: "manual",
      workspace: root,
      localImageAnchor: async () => ({
        projectId: a,
        workspace: root,
        storage: path.join(root, "image-recovery", a),
      }),
      storageOverview: async () => ({
        supported: true,
        vmState: "running",
        dataStatus: "current",
        checkedAt: observedAt,
        snapshot,
        unallocatedProjects: [],
      }),
    });
    expect(report).toMatchObject({
      guest: { currentProfileId: "current-64" },
      transfer: { mediaSetLimitBytes: 64 * MiB },
      recovery: { quota: { limitBytes: 512 * MiB } },
      preservation: {
        conservativeNewOperationEnvelope: { requiredBytes: 470 * MiB },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function orphanPayload(phase: "started" | "unknown" = "unknown") {
  const planId = "f8ac33ad-1ee7-4fa7-9477-e6f83710c0cc";
  const reservation = {
    namespace: "manual",
    projectId: a,
    planId,
    targetVolumeId: "d".repeat(32),
    volumeBytes: 512 * MiB,
    phase,
    sourceAbsent: true,
  };
  const raw = {
    ...payload(),
    capacityOverviewVersion: 1,
    capacityReservations: [reservation],
    countsTrusted: false,
  };
  Object.assign(raw.counts, {
    residentReserved: 1,
    freeSlots: null,
    allocatedLogicalBytes: 512 * MiB,
    retainedBackupBytes: 0,
    stagingLogicalBytes: 512 * MiB,
  });
  return { raw, reservation };
}

it.each(["started", "unknown"] as const)(
  "preserves and counts a source-absent %s plan without inventing a project record",
  (phase) => {
    const { raw, reservation } = orphanPayload(phase);
    const snapshot = executionStorageSnapshot(raw, observedAt);
    expect(snapshot).toMatchObject({
      allocatedProjects: 0,
      residentReserved: 1,
      freeResidentSlots: null,
      countsTrusted: false,
      allocatedLogicalBytes: 512 * MiB,
      stagingLogicalBytes: 512 * MiB,
      retainedBackupBytes: 0,
      projects: [],
      capacityReservations: [reservation],
    });
  },
);

it("includes orphan reservations alongside registered project totals", () => {
  const { raw, reservation } = orphanPayload();
  const existing = project({
    namespace: "test",
    projectId: b,
    volumeProfileVersion: 2,
    sourceProfileId: "capacity-128-v2",
    volumeId: "a".repeat(32),
    volumeBytes: 512 * MiB,
    retainedVolumeBytes: 256 * MiB,
    stagingVolumeBytes: 0,
    logicalBytes: 768 * MiB,
  });
  raw.projects.push(existing);
  Object.assign(raw.counts, {
    allocatedProjects: 1,
    residentReserved: 2,
    resident: 1,
    allocatedLogicalBytes: 1280 * MiB,
    retainedBackupBytes: 256 * MiB,
  });
  expect(executionStorageSnapshot(raw, observedAt)).toMatchObject({
    allocatedProjects: 1,
    residentReserved: 2,
    allocatedLogicalBytes: 1280 * MiB,
    retainedBackupBytes: 256 * MiB,
    stagingLogicalBytes: 512 * MiB,
    capacityReservations: [reservation],
  });
});

it("rejects malformed, omitted, duplicated or falsely trusted orphan reservations", () => {
  const { raw: base } = orphanPayload();
  for (const mutate of [
    (raw: any) => {
      delete raw.capacityReservations;
    },
    (raw: any) => {
      raw.capacityReservations[0].sourceAbsent = false;
    },
    (raw: any) => {
      raw.capacityReservations[0].phase = "committed";
    },
    (raw: any) => {
      raw.capacityReservations[0].volumeBytes++;
    },
    (raw: any) => {
      raw.capacityReservations[0].extra = true;
    },
    (raw: any) => {
      raw.counts.stagingLogicalBytes = 0;
    },
    (raw: any) => {
      raw.counts.allocatedLogicalBytes = 0;
    },
    (raw: any) => {
      raw.counts.residentReserved = 0;
    },
    (raw: any) => {
      raw.countsTrusted = true;
      raw.counts.freeSlots = 7;
    },
    (raw: any) => {
      raw.capacityReservations.push({
        ...raw.capacityReservations[0],
        namespace: "test",
        projectId: b,
      });
    },
    (raw: any) => {
      raw.capacityReservations.push({
        ...raw.capacityReservations[0],
        namespace: "test",
        projectId: b,
        planId: "891b7dcc-9273-4ab5-b73d-28e3f125abf9",
      });
    },
    (raw: any) => {
      raw.projects.push({
        ...project(),
        volumeProfileVersion: 0,
        sourceProfileId: null,
        volumeId: "legacy",
        volumeBytes: 256 * MiB,
        retainedVolumeBytes: 0,
        stagingVolumeBytes: 0,
        logicalBytes: 256 * MiB,
      });
    },
    (raw: any) => {
      raw.projects.push({
        ...project({ namespace: "test", projectId: b }),
        volumeProfileVersion: 2,
        sourceProfileId: "capacity-128-v2",
        volumeId: raw.capacityReservations[0].targetVolumeId,
        volumeBytes: 512 * MiB,
        retainedVolumeBytes: 0,
        stagingVolumeBytes: 0,
        logicalBytes: 512 * MiB,
      });
      Object.assign(raw.counts, {
        allocatedProjects: 1,
        residentReserved: 2,
        resident: 1,
        allocatedLogicalBytes: 1024 * MiB,
      });
    },
    (raw: any) => {
      delete raw.capacityOverviewVersion;
    },
  ]) {
    const raw = structuredClone(base);
    mutate(raw);
    expect(() => executionStorageSnapshot(raw, observedAt)).toThrow();
  }
});

it("reports a pending original capacity plan while allocation and active profile remain unknown", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "capacity-overview-orphan-")),
  );
  try {
    const { raw, reservation } = orphanPayload();
    const snapshot = executionStorageSnapshot(raw, observedAt);
    const report = await inspectExecutionCapacity({
      projectId: a,
      namespace: "manual",
      workspace: root,
      localImageAnchor: async () => ({
        projectId: a,
        workspace: root,
        storage: path.join(root, "image-recovery", a),
      }),
      storageOverview: async () => ({
        supported: true,
        vmState: "running",
        dataStatus: "current",
        checkedAt: observedAt,
        snapshot,
        unallocatedProjects: null,
      }),
    });
    expect(report.guest).toMatchObject({
      allocation: "unknown",
      currentProfileId: null,
      currentProjectStateKnown: false,
      capacityReservationStatus: "pending",
      pendingCapacityReservation: reservation,
    });
    expect(
      report.recommendations.find(
        (item) => item.code === "inspect-original-capacity-plan",
      )?.message,
    ).toContain(reservation.planId);
    expect(
      proposeExecutionCapacity(report, "capacity-128-v1").constraints.find(
        (item) => item.code === "volume-pending",
      )?.status,
    ).toBe("blocked");
    const stale = await inspectExecutionCapacity({
      projectId: a,
      namespace: "manual",
      workspace: root,
      localImageAnchor: async () => ({
        projectId: a,
        workspace: root,
        storage: path.join(root, "image-recovery", a),
      }),
      storageOverview: async () => ({
        supported: true,
        vmState: "stopped",
        dataStatus: "stale",
        checkedAt: observedAt,
        snapshot,
        unallocatedProjects: null,
      }),
    });
    expect(stale.guest).toMatchObject({
      allocation: "unknown",
      capacityReservationStatus: "unknown",
      pendingCapacityReservation: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
