import type {
  ExecutionStorageOverview,
  ExecutionStorageProject,
} from "../../src/shared/execution-storage.js";

export function executionStorageProject(
  patch: Partial<ExecutionStorageProject> = {},
): ExecutionStorageProject {
  return {
    namespace: "manual",
    projectId: "11111111-1111-1111-1111-111111111111",
    generation: "fixture-generation",
    projectName: "Garden game",
    currentStore: true,
    residency: "resident",
    residentReserved: true,
    transition: null,
    dirty: false,
    pinned: false,
    syncPending: false,
    taskPhase: "idle",
    expiredTask: false,
    ...patch,
  };
}

export function executionStorageOverview(): ExecutionStorageOverview {
  return {
    supported: true,
    vmState: "running",
    dataStatus: "current",
    checkedAt: "2026-11-04T10:00:01.000Z",
    snapshot: {
      observedAt: "2026-11-04T10:00:00.000Z",
      limits: {
        residentVolumes: 8,
        volumeBytes: 25 * 1024 ** 3,
        totalLogicalBytes: 200 * 1024 ** 3,
        reserveBytes: 10 * 1024 ** 3,
        globalOperations: 2,
      },
      countsTrusted: true,
      allocatedProjects: 4,
      residentReserved: 2,
      freeResidentSlots: 6,
      resident: 2,
      sleeping: 2,
      projects: [
        executionStorageProject(),
        executionStorageProject({
          projectId: "22222222-2222-2222-2222-222222222222",
          projectName: "Space adventure",
          taskPhase: "running",
        }),
        executionStorageProject({
          projectId: "33333333-3333-3333-3333-333333333333",
          projectName: "Interactive story",
          residency: "archived",
          residentReserved: false,
          taskPhase: "idle",
          dirty: true,
        }),
        executionStorageProject({
          namespace: "test",
          projectId: "44444444-4444-4444-4444-444444444444",
          projectName: null,
          currentStore: false,
          residency: "archived",
          residentReserved: false,
          taskPhase: "idle",
        }),
      ],
    },
    unallocatedProjects: [
      {
        projectId: "55555555-5555-5555-5555-555555555555",
        projectName: "New project",
      },
    ],
  };
}
