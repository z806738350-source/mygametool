import type {
  ExecutionStorageProject,
  ExecutionCapacityReservation,
  ExecutionStorageSnapshot,
  ExecutionStorageTaskPhase,
} from "../shared/execution-storage.js";

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid isolated storage overview");
  return value as Record<string, unknown>;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    throw new Error("Invalid isolated storage overview count");
  return value as number;
}

const taskPhases = [
  "prepared",
  "running",
  "finished-awaiting-ack",
  "finished",
  "cancel-requested",
  "expired-uncertain",
] as const;

/** Validate the one guest-wide snapshot; never derive capacity from UI state. */
export function executionStorageSnapshot(
  value: unknown,
  observedAt: string,
): ExecutionStorageSnapshot {
  const raw = record(value, [
    "protocolVersion",
    "capacityOverviewVersion",
    "capacityReservations",
    "scope",
    "ready",
    "limits",
    "countsTrusted",
    "counts",
    "projects",
    "reason",
  ]);
  if (
    raw.protocolVersion !== 2 ||
    raw.scope !== "global" ||
    raw.ready !== true ||
    typeof raw.countsTrusted !== "boolean" ||
    (raw.reason !== undefined && raw.reason !== "incomplete-lifecycle-state")
  )
    throw new Error("Unsupported isolated storage overview");
  if (
    raw.capacityOverviewVersion !== undefined &&
    raw.capacityOverviewVersion !== 1
  )
    throw new Error("Unsupported isolated capacity overview");
  const versioned = raw.capacityOverviewVersion === 1;
  const limits = record(raw.limits, [
    "residentVolumes",
    "volumeBytes",
    "totalLogicalBytes",
    "reserveBytes",
    "globalOperations",
    "identityRange",
    "operationHistory",
  ]);
  if (
    limits.residentVolumes !== 8 ||
    limits.volumeBytes !== 256 * 1024 * 1024 ||
    limits.totalLogicalBytes !== 4 * 1024 ** 3 ||
    limits.reserveBytes !== 1024 ** 3 ||
    limits.globalOperations !== 2 ||
    JSON.stringify(limits.identityRange) !== "[5000,5095]" ||
    limits.operationHistory !== 8192
  )
    throw new Error("Unsupported isolated storage resource profile");
  if (!Array.isArray(raw.projects) || raw.projects.length > 16)
    throw new Error("Invalid isolated storage projects");
  const seen = new Set<string>();
  const projects: ExecutionStorageProject[] = raw.projects.map((value) => {
    const item = record(value, [
      "namespace",
      "projectId",
      "generation",
      "volumeProfileVersion",
      "sourceProfileId",
      "volumeId",
      "volumeBytes",
      "retainedVolumeBytes",
      "stagingVolumeBytes",
      "logicalBytes",
      "residency",
      "transition",
      "dirty",
      "pinned",
      "syncPending",
      "tasks",
    ]);
    if (
      typeof item.namespace !== "string" ||
      !["manual", "test"].includes(item.namespace) ||
      typeof item.projectId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        item.projectId,
      ) ||
      integer(item.generation) < 1 ||
      typeof item.residency !== "string" ||
      !["resident", "archived", "creating", "recovery"].includes(
        item.residency,
      ) ||
      typeof item.dirty !== "boolean" ||
      typeof item.pinned !== "boolean" ||
      typeof item.syncPending !== "boolean"
    )
      throw new Error("Invalid isolated storage project");
    const capacityFields = [
      "volumeProfileVersion",
      "sourceProfileId",
      "volumeId",
      "volumeBytes",
      "retainedVolumeBytes",
      "stagingVolumeBytes",
      "logicalBytes",
    ];
    if (
      versioned
        ? capacityFields.some((key) => !Object.hasOwn(item, key))
        : capacityFields.some((key) => Object.hasOwn(item, key))
    )
      throw new Error("Incomplete isolated volume capacity metadata");
    if (versioned) {
      if (
        (item.volumeProfileVersion === 0
          ? item.sourceProfileId !== null ||
            item.volumeId !== "legacy" ||
            item.volumeBytes !== 256 * 1024 ** 2
          : item.volumeProfileVersion === 2 || item.volumeProfileVersion === 3
            ? item.sourceProfileId !== (item.volumeProfileVersion === 2 ? "capacity-128-v2" : "capacity-128-media64-v3") ||
              typeof item.volumeId !== "string" ||
              !/^[a-f0-9]{32}$/.test(item.volumeId) ||
              item.volumeBytes !== 512 * 1024 ** 2
            : true) ||
        integer(item.retainedVolumeBytes, 4 * 1024 ** 3) % (256 * 1024 ** 2) !==
          0 ||
        ![0, 512 * 1024 ** 2].includes(
          integer(item.stagingVolumeBytes, 512 * 1024 ** 2),
        ) ||
        integer(item.logicalBytes, 4 * 1024 ** 3) !==
          Number(item.volumeBytes) +
            Number(item.retainedVolumeBytes) +
            Number(item.stagingVolumeBytes)
      )
        throw new Error("Invalid isolated volume capacity metadata");
    }
    const key = `${item.namespace}:${item.projectId}`;
    if (seen.has(key)) throw new Error("Duplicate isolated storage project");
    seen.add(key);
    let transition: ExecutionStorageProject["transition"] = null;
    if (item.transition !== null) {
      const move = record(item.transition, ["from", "to"]);
      if (
        typeof move.from !== "string" ||
        !["resident", "archived", "creating", "recovery"].includes(move.from) ||
        typeof move.to !== "string" ||
        !["resident", "archived", "deleted"].includes(move.to) ||
        move.from !== item.residency ||
        move.to === move.from ||
        (move.to !== "deleted" &&
          !["resident:archived", "archived:resident"].includes(
            `${move.from}:${move.to}`,
          ))
      )
        throw new Error("Invalid isolated storage transition");
      transition = { from: move.from, to: move.to } as NonNullable<
        ExecutionStorageProject["transition"]
      >;
    }
    if (
      !Array.isArray(item.tasks) ||
      item.tasks.length > 1 ||
      (item.tasks.length > 0 &&
        (item.residency !== "resident" || transition !== null))
    )
      throw new Error("Invalid isolated storage tasks");
    const phases = item.tasks.map((value) => {
      const task = record(value, ["phase", "mode", "leaseExpiresAt"]);
      if (
        !taskPhases.includes(task.phase as (typeof taskPhases)[number]) ||
        typeof task.mode !== "string" ||
        !["install", "build", "preview", "shell", "recovery"].includes(
          task.mode,
        ) ||
        typeof task.leaseExpiresAt !== "number" ||
        !Number.isFinite(task.leaseExpiresAt) ||
        task.leaseExpiresAt < 0 ||
        task.leaseExpiresAt > Number.MAX_SAFE_INTEGER
      )
        throw new Error("Invalid isolated storage task phase");
      return task.phase as ExecutionStorageTaskPhase;
    });
    return {
      namespace: item.namespace as ExecutionStorageProject["namespace"],
      projectId: item.projectId,
      generation: String(item.generation),
      projectName: null,
      currentStore: false,
      residency: item.residency as ExecutionStorageProject["residency"],
      residentReserved:
        !["archived"].includes(String(item.residency)) ||
        transition?.to === "resident" ||
        (versioned && Number(item.stagingVolumeBytes) > 0),
      ...(versioned
        ? {
            residentReservationCount:
              (!["archived"].includes(String(item.residency)) ||
              transition?.to === "resident"
                ? 1
                : 0) + (item.stagingVolumeBytes ? 1 : 0),
            volumeProfileVersion: item.volumeProfileVersion as 0 | 2 | 3,
            sourceProfileId: item.sourceProfileId as "capacity-128-v2" | "capacity-128-media64-v3" | null,
            volumeId: item.volumeId as string,
            volumeBytes: item.volumeBytes as number,
            retainedVolumeBytes: item.retainedVolumeBytes as number,
            stagingVolumeBytes: item.stagingVolumeBytes as number,
            logicalBytes: item.logicalBytes as number,
          }
        : {}),
      transition,
      dirty: item.dirty,
      pinned: item.pinned,
      syncPending: item.syncPending,
      taskPhase: phases[0] ?? "idle",
      expiredTask: phases.includes("expired-uncertain"),
    };
  });
  if (
    versioned
      ? !Array.isArray(raw.capacityReservations)
      : Object.hasOwn(raw, "capacityReservations")
  )
    throw new Error("Incomplete isolated capacity reservations");
  if (versioned && (raw.capacityReservations as unknown[]).length > 8)
    throw new Error("Too many isolated capacity reservations");
  const reservationPlans = new Set<string>(),
    reservationTargets = new Set(
      projects.flatMap((project) =>
        (project.volumeProfileVersion === 2 || project.volumeProfileVersion === 3) && project.volumeId
          ? [project.volumeId]
          : [],
      ),
    );
  const capacityReservations: ExecutionCapacityReservation[] = versioned
    ? (raw.capacityReservations as unknown[]).map((value) => {
        const fields = [
          "namespace",
          "projectId",
          "planId",
          "targetVolumeId",
          "volumeBytes",
          "phase",
          "sourceAbsent",
        ];
        const item = record(value, fields);
        if (
          fields.some((key) => !Object.hasOwn(item, key)) ||
          typeof item.namespace !== "string" ||
          !["manual", "test"].includes(item.namespace) ||
          typeof item.projectId !== "string" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
            item.projectId,
          ) ||
          typeof item.planId !== "string" ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.planId) ||
          typeof item.targetVolumeId !== "string" ||
          !/^[a-f0-9]{32}$/.test(item.targetVolumeId) ||
          item.volumeBytes !== 512 * 1024 ** 2 ||
          !["started", "unknown"].includes(String(item.phase)) ||
          item.sourceAbsent !== true
        )
          throw new Error("Invalid isolated capacity reservation");
        const key = `${item.namespace}:${item.projectId}`;
        if (
          seen.has(key) ||
          reservationPlans.has(item.planId) ||
          reservationTargets.has(item.targetVolumeId)
        )
          throw new Error("Duplicate isolated capacity reservation");
        seen.add(key);
        reservationPlans.add(item.planId);
        reservationTargets.add(item.targetVolumeId);
        return {
          namespace:
            item.namespace as ExecutionCapacityReservation["namespace"],
          projectId: item.projectId,
          planId: item.planId,
          targetVolumeId: item.targetVolumeId,
          volumeBytes: 536870912,
          phase: item.phase as "started" | "unknown",
          sourceAbsent: true,
        };
      })
    : [];
  const counts = record(raw.counts, [
    "allocatedProjects",
    "residentReserved",
    "freeSlots",
    "resident",
    "sleeping",
    "allocatedLogicalBytes",
    "retainedBackupBytes",
    "stagingLogicalBytes",
  ]);
  const capacityCounts = [
    "allocatedLogicalBytes",
    "retainedBackupBytes",
    "stagingLogicalBytes",
  ];
  if (
    versioned
      ? capacityCounts.some((key) => !Object.hasOwn(counts, key))
      : capacityCounts.some((key) => Object.hasOwn(counts, key))
  )
    throw new Error("Incomplete isolated volume capacity counts");
  const residentReserved =
    projects.reduce(
      (total, project) =>
        total +
        (project.residentReservationCount ??
          (project.residentReserved ? 1 : 0)),
      0,
    ) + capacityReservations.length;
  const reservedVolumeBytes = capacityReservations.reduce(
    (total, item) => total + item.volumeBytes,
    0,
  );
  const allocatedLogicalBytes =
    projects.reduce(
      (total, project) => total + (project.logicalBytes ?? 0),
      0,
    ) + reservedVolumeBytes;
  const retainedBackupBytes = projects.reduce(
    (total, project) => total + (project.retainedVolumeBytes ?? 0),
    0,
  );
  const stagingLogicalBytes =
    projects.reduce(
      (total, project) => total + (project.stagingVolumeBytes ?? 0),
      0,
    ) + reservedVolumeBytes;
  if (
    versioned &&
    (integer(counts.allocatedLogicalBytes, 4 * 1024 ** 3) !==
      allocatedLogicalBytes ||
      integer(counts.retainedBackupBytes, 4 * 1024 ** 3) !==
        retainedBackupBytes ||
      integer(counts.stagingLogicalBytes, 4 * 1024 ** 3) !==
        stagingLogicalBytes)
  )
    throw new Error("Inconsistent isolated volume capacity counts");
  const resident = projects.filter(
    (project) => project.residency === "resident" && !project.transition,
  ).length;
  const sleeping = projects.filter(
    (project) => project.residency === "archived" && !project.transition,
  ).length;
  const incomplete =
    capacityReservations.length > 0 ||
    projects.some(
      (project) =>
        project.transition ||
        (project.stagingVolumeBytes ?? 0) > 0 ||
        project.residency === "creating" ||
        project.residency === "recovery" ||
        project.syncPending ||
        project.expiredTask,
    );
  if (
    integer(counts.allocatedProjects, 96) !== projects.length ||
    integer(counts.residentReserved, 96) !== residentReserved ||
    integer(counts.resident, 96) !== resident ||
    integer(counts.sleeping, 96) !== sleeping ||
    residentReserved > 8 ||
    (raw.countsTrusted &&
      (incomplete || counts.freeSlots !== 8 - residentReserved)) ||
    (!raw.countsTrusted && counts.freeSlots !== null)
  )
    throw new Error("Inconsistent isolated storage overview counts");
  return {
    observedAt,
    limits: {
      residentVolumes: 8,
      volumeBytes: 256 * 1024 * 1024,
      totalLogicalBytes: 4 * 1024 ** 3,
      reserveBytes: 1024 ** 3,
      globalOperations: 2,
    },
    countsTrusted: raw.countsTrusted,
    allocatedProjects: projects.length,
    residentReserved,
    freeResidentSlots: raw.countsTrusted ? 8 - residentReserved : null,
    resident,
    sleeping,
    ...(versioned
      ? {
          capacityOverviewVersion: 1 as const,
          allocatedLogicalBytes,
          retainedBackupBytes,
          stagingLogicalBytes,
          capacityReservations,
        }
      : {}),
    projects,
  };
}
