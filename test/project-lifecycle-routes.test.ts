import { link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import * as agentRuntime from "../src/daemon/agent.js";
import { createLocalModelRuntime, LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { kunpoRuntimeProvider } from "../src/daemon/provider-model-settings.js";
import { createApp } from "../src/daemon/app.js";
import { CheckpointStore, checkpointDirectory } from "../src/daemon/checkpoints.js";
import { ProjectManager } from "../src/daemon/projects.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { durablePublicationDirectory, savePublicationManifest } from "../src/daemon/isolated-publication-journal.js";
import type { IsolatedSourceReview } from "../src/shared/execution-storage.js";
import type { ExecutionCapacityReport } from "../src/daemon/execution-capacity.js";
import * as capacityRuntime from "../src/daemon/execution-capacity.js";
import * as recoveryCapacity from "../src/daemon/recovery-space.js";
import { VolumeMigrationCoordinator } from "../src/daemon/volume-migration-coordinator.js";
import { volumeMigrationReview, volumeMigrationConfirmation } from "./volume-migration-fixture.js";
import { reserveRecoverySpace } from "../src/daemon/recovery-space.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(accessToken?: string, configured = true, agentReady = false, capacityReady = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lifecycle-routes-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const agentDirectory = path.join(directory, "agent"); await mkdir(agentDirectory);
  const keyFile = path.join(agentDirectory, "local-api-keys.json");
  if (agentReady) await new LocalApiKeyStore(keyFile).modify("kunpo", async () => ({ type: "api_key", key: "isolated-recovery-offline-fixture" }));
  const runtime = agentReady ? await createLocalModelRuntime(keyFile, async () => [kunpoRuntimeProvider()])
    : await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const execution = {
    namespace: "test",
    dependenciesInGuest: true, setAdmission: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
    quiesceProject: vi.fn().mockResolvedValue(undefined), resumeProject: vi.fn(),
    retireProject: vi.fn(async (_project: ProjectState, beforeRetire: () => Promise<void>) => {
      await beforeRetire();
      return { deleted: true };
    }),
    inventoryProject: vi.fn().mockResolvedValue(undefined),
    inspectSource: vi.fn(async (project: ProjectState, generation: number) => ({ namespace: "test", projectId: project.id, generation,
      complete: true, changes: [], excluded: 0, blockers: 0 })),
    recoverSource: vi.fn().mockResolvedValue({ changed: [] }),
    storageOverview: vi.fn().mockResolvedValue({ supported: true, vmState: "stopped", dataStatus: "unavailable",
      checkedAt: "2026-11-04T10:00:00.000Z", reason: "vm-stopped", snapshot: null, unallocatedProjects: null }),
  };
  if (capacityReady) Object.assign(execution, {
    planCapacityMigration: vi.fn(), inspectCapacityPlan: vi.fn(), registerCapacityAuthorization: vi.fn(), executeCapacityPlan: vi.fn(),
    capacityBackingDevice: vi.fn(), assertSourceReviewSettled: vi.fn().mockResolvedValue(undefined),
  });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => runtime,
    projectExecution: configured ? execution as never : undefined, accessToken });
  cleanups.push(() => app.close());
  const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "Lifecycle fixture", type: "general" },
    ...(accessToken ? { headers: { authorization: `Bearer ${accessToken}` } } : {}) });
  expect(response.statusCode, response.body).toBe(201);
  return { app, execution, project: response.json<ProjectState>(), directory };
}

it("provides the global no-store overview with current ProjectManager names", async () => {
  const { app, execution, project } = await fixture();
  const response = await app.inject({ method: "GET", url: "/execution-storage" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({ vmState: "stopped", snapshot: null, unallocatedProjects: null });
  expect(execution.storageOverview).toHaveBeenCalledWith([expect.objectContaining({ id: project.id, name: project.name })]);
  expect(execution.inventoryProject).not.toHaveBeenCalled();
  expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("reports capacity without allocating, inspecting retained bytes or inventing stopped-guest space", async () => {
  const { app, execution, project, directory } = await fixture("capacity-access");
  const url = `/projects/${project.id}/execution-storage/capacity`;
  expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  const metadata = path.join(directory, "projects", project.id, "project.json");
  const before = await readFile(metadata, "utf8"), directories = await readdir(path.dirname(metadata));
  const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer capacity-access" } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const report = response.json<ExecutionCapacityReport>();
  expect(report).toMatchObject({ version: 1, basis: "metadata-only", authorization: "none", status: "partial",
    host: { inventory: { complete: true }, limits: { mediaBytes: 64 * 1024 * 1024 } },
    transfer: { incrementalBytes: null, mediaLimitScope: "complete-eligible-media-set-not-per-chunk" },
    preservation: { trustedChangedBeforeBytes: null, trustedChangedAfterBytes: null, conservativeNewOperationEnvelope: null },
    recovery: { localImageStorage: "included", quota: { scope: "shared-history-and-active" } },
    guest: { vmState: "stopped", dataStatus: "unavailable", currentProjectStateKnown: false, allocation: "unknown", volumeUsedBytes: null, volumeFreeBytes: null },
    contracts: { guestPerGenerationRasterPolicy: null }, inspection: { assetPayloadsRead: false, imagePixelsDecoded: false } });
  expect(report.recommendations.some(item => item.code === "guest-state-unknown")).toBe(true);
  expect(response.body).not.toContain(directory);
  expect(await readFile(metadata, "utf8")).toBe(before);
  expect(await readdir(path.dirname(metadata))).toEqual(directories);
  await expect(lstat(path.join(directory, "image-recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(execution.storageOverview).toHaveBeenCalledOnce();
  for (const method of [execution.inventoryProject, execution.inspectSource, execution.recoverSource, execution.retireProject, execution.quiesceProject]) expect(method).not.toHaveBeenCalled();
});

it("retains host capacity observations when no execution backend is configured", async () => {
  const { app, project } = await fixture(undefined, false);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ host: { inventory: { complete: true } }, guest: { configured: false, allocation: "unknown", volumeFreeBytes: null } });
});

it("rejects external-workspace execution capacity before scanning its parent recovery directories", async () => {
  const { app, project } = await fixture();
  const get = vi.spyOn(ProjectManager.prototype, "get").mockReturnValue({ ...project, workspaceLocation: "external" });
  const inspect = vi.spyOn(capacityRuntime, "inspectExecutionCapacity");
  try {
    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("external workspace");
    expect(inspect).not.toHaveBeenCalled();
  } finally { get.mockRestore(); inspect.mockRestore(); }
});

it("keeps the combined history and promise totals unknown when the local image anchor is unavailable", async () => {
  const { app, project } = await fixture();
  const anchor = vi.spyOn(ProjectManager.prototype, "getLocalImageRecoveryAnchor").mockRejectedValue(new Error("private path must not be echoed"));
  try {
    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "partial", host: { inventory: { complete: true } }, recovery: { status: "incomplete", localImageStorage: "not-supplied", quota: { usedBytes: null, remainingBytes: null }, promises: { ledger: "uncertain", own: { count: null }, sameDevice: { diskBytes: null } } }, preservation: { quotaEstimateFits: null, diskEstimateFits: null } });
    expect(response.body).not.toContain("private path must not be echoed");
  } finally { anchor.mockRestore(); }
});

it("does not substitute an assumed allocation unit for an unavailable filesystem observation", async () => {
  const { app, project } = await fixture();
  const url = `/projects/${project.id}/execution-storage/capacity`;
  const before = (await app.inject({ method: "GET", url })).json<ExecutionCapacityReport>();
  const inspect = vi.spyOn(recoveryCapacity, "inspectRecoveryCapacity").mockResolvedValue({ ...before.recovery, quota: { ...before.recovery.quota, limitBytes: 512 * 1024 * 1024 }, status: "incomplete", filesystem: { status: "incomplete", availableBytes: null, allocationUnitBytes: null, floorBytes: before.recovery.filesystem.floorBytes } });
  try {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ preservation: { conservativeNewOperationEnvelope: null, quotaEstimateFits: null, diskEstimateFits: null }, filesystem: { observedUnreservedAfterFloorBytes: null }, issues: ["current-envelope-estimate-unavailable", "active-volume-profile-unknown"] });
  } finally { inspect.mockRestore(); }
});

it("reports the complete media-set overage without decoding payloads or treating chunks as new capacity", async () => {
  const { app, project } = await fixture();
  const publicDirectory = path.join(project.workspacePath, "public"); await mkdir(publicDirectory);
  for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
    const target = path.join(publicDirectory, name); await writeFile(target, "metadata fixture, not a decoded image"); await truncate(target, 16 * 1024 * 1024 + 1);
  }
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ authorization: "none", host: { inventory: { complete: true, mediaBytes: 64 * 1024 * 1024 + 4, overage: { mediaBytes: 4 } } },
    preservation: { quotaEstimateFits: null, diskEstimateFits: null }, inspection: { assetPayloadsRead: false, imagePixelsDecoded: false } });
  expect(response.json<ExecutionCapacityReport>().recommendations.some(item => item.code === "media-set-over-limit")).toBe(true);
});

it("keeps a stale guest snapshot distinct from current allocation and free-space observations", async () => {
  const { app, execution, project } = await fixture();
  execution.storageOverview.mockResolvedValueOnce({ supported: true, vmState: "stopped", dataStatus: "stale", checkedAt: "2026-11-10T09:00:00Z", reason: "vm-stopped",
    snapshot: { observedAt: "2026-11-09T09:00:00Z", countsTrusted: true, allocatedProjects: 1, residentReserved: 1, freeResidentSlots: 7, resident: 1, sleeping: 0,
      limits: { residentVolumes: 8, volumeBytes: 256 * 1024 * 1024, totalLogicalBytes: 4 * 1024 ** 3, reserveBytes: 1024 ** 3, globalOperations: 2 },
      projects: [{ namespace: "test", projectId: project.id, generation: "37", projectName: "Old name", currentStore: true, residency: "resident", residentReserved: true, transition: null, dirty: true, pinned: false, syncPending: false, taskPhase: "idle", expiredTask: false }] }, unallocatedProjects: null } as never);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ guest: { dataStatus: "stale", observedAt: "2026-11-09T09:00:00Z", currentProjectStateKnown: false, project: null, allocation: "unknown", volumeFreeBytes: null } });
});

it.each([false, true])("distinguishes naturally finished work from a running retained operation in capacity advice: %s", async dirty => {
  const { app, execution, project } = await fixture();
  execution.storageOverview.mockResolvedValueOnce({ supported: true, vmState: "running", dataStatus: "current", checkedAt: "2026-11-10T09:00:00Z",
    snapshot: { observedAt: "2026-11-10T09:00:00Z", countsTrusted: true, allocatedProjects: 1, residentReserved: 1, freeResidentSlots: 7, resident: 1, sleeping: 0,
      limits: { residentVolumes: 8, volumeBytes: 256 * 1024 * 1024, totalLogicalBytes: 4 * 1024 ** 3, reserveBytes: 1024 ** 3, globalOperations: 2 },
      projects: [{ namespace: "test", projectId: project.id, generation: "4", projectName: "Fixture", currentStore: true, residency: "resident", residentReserved: true, transition: null, dirty, pinned: false, syncPending: false, taskPhase: dirty ? "running" : "finished", expiredTask: false }] }, unallocatedProjects: null } as never);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
  expect(response.statusCode, response.body).toBe(200);
  const report = response.json<ExecutionCapacityReport>();
  expect(report.guest).toMatchObject({ currentProjectStateKnown: true, allocation: "present", volumeUsedBytes: null, volumeFreeBytes: null });
  expect(report.recommendations.some(item => item.code === "inspect-original-generation")).toBe(dirty);
  expect(report.recommendations.some(item => item.code === "wait-original-operation")).toBe(dirty);
  expect(execution.quiesceProject).not.toHaveBeenCalled(); expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("reports unreadable host inventory as unknown without leaking paths or authorizing a seed", async () => {
  const { app, project, directory } = await fixture();
  const outside = path.join(directory, "private-outside-image.png"); await writeFile(outside, "never read this outside fixture");
  await symlink(outside, path.join(project.workspacePath, "linked.png"));
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: "partial", host: { inventory: null }, transfer: { observedEligiblePayloadBytes: null }, issues: ["host-inventory-unavailable", "current-envelope-estimate-unavailable", "active-volume-profile-unknown"] });
  expect(response.body).not.toContain(outside); expect(response.body).not.toContain("never read this");
});

it("observes the original source promise without consuming it or reporting a new allocation as admitted", async () => {
  const { app, project } = await fixture();
  const lease = await reserveRecoverySpace(project.workspacePath, { rawBytes: 1024, workingBytes: 1024, beforeBytes: 0, afterBytes: 1024, manifestBytes: 128, additionalEntries: 8 }, {
    namespace: "test", projectId: project.id, ownerKey: "c".repeat(32), generation: 7,
  });
  const intent = path.join(path.dirname(project.workspacePath), "isolated-space-reservations", lease.id + ".json"), before = await readFile(intent, "utf8");
  try {
    const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage/capacity` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ authorization: "none", preservation: { quotaEstimateFits: null, diskEstimateFits: null }, recovery: { promises: { ledger: "known", own: { count: 1, logicalBytes: lease.plan.requiredBytes } } } });
    expect(response.json<ExecutionCapacityReport>().recommendations.some(item => item.code === "preserve-original-operation")).toBe(true);
    expect(await readFile(intent, "utf8")).toBe(before); expect(response.body).not.toContain("c".repeat(32));
  } finally { await lease.release(); }
});

it("opens storage only through an explicit authenticated project action and never reviews or recovers files", async () => {
  const { app, execution, project } = await fixture("fixture-access");
  const open = vi.fn().mockResolvedValue(undefined);
  Object.assign(execution, { openRecoveryStorage: open });
  expect((await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage`, headers: { authorization: "Bearer fixture-access" } })).statusCode).toBe(200);
  expect(open).not.toHaveBeenCalled();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/open`, payload: {} })).statusCode).toBe(401);
  expect(open).not.toHaveBeenCalled();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/open`, payload: {}, headers: { authorization: "Bearer fixture-access" } })).statusCode).toBe(204);
  expect(open).toHaveBeenCalledOnce(); expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("keeps interrupted host publications behind a persistent admission gate while allowing inspection", async () => {
  const { app, execution, project } = await fixture();
  const directory = path.join(path.dirname(project.workspacePath), "isolated-changes/fixture");
  await durablePublicationDirectory(directory);
  await savePublicationManifest(directory, { version: 2, state: "needs-review", context: { namespace: "test", projectId: project.id, generation: 22, snapshotId: "b".repeat(64) }, versions: [], published: [], steps: {} });
  for (const request of [
    { method: "POST" as const, url: "/tools/generate-image/jobs", payload: { prompt: "offline fixture", projectId: project.id, nodeId: "node-1" } },
    { method: "PATCH" as const, url: `/projects/${project.id}`, payload: { name: "Must wait for publication" } },
    { method: "POST" as const, url: `/projects/${project.id}/conversations`, payload: {} },
    { method: "DELETE" as const, url: `/projects/${project.id}` },
  ]) expect((await app.inject(request)).statusCode).toBe(409);
  expect(execution.retireProject).not.toHaveBeenCalled();
  const status = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(status.statusCode).toBe(200);
  expect(status.json()).toMatchObject({ dirty: true, recoverable: false, state: "unavailable", reason: expect.stringContaining("file review") });
  expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(200);
});

it("reports an unconfigured backend without inventing zero occupancy or unallocated projects", async () => {
  const { app, execution } = await fixture(undefined, false);
  const response = await app.inject({ method: "GET", url: "/execution-storage" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ supported: false, dataStatus: "unavailable", reason: "not-configured",
    snapshot: null, unallocatedProjects: null });
  expect(execution.storageOverview).not.toHaveBeenCalled();
});

it("keeps global storage behind the existing host, origin and process-token boundary", async () => {
  const { app, execution } = await fixture("storage-fixture-token");
  expect((await app.inject({ method: "GET", url: "/execution-storage" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/execution-storage", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
  const headers = { authorization: "Bearer storage-fixture-token" };
  expect((await app.inject({ method: "GET", url: "/execution-storage", headers: { ...headers, host: "evil.example" } })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/execution-storage", headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
  expect(execution.storageOverview).not.toHaveBeenCalled();
  expect((await app.inject({ method: "GET", url: "/execution-storage", headers })).statusCode).toBe(200);
  expect(execution.storageOverview).toHaveBeenCalledOnce();
});

it("holds the host project until guest retirement succeeds, and denies new contextual work meanwhile", async () => {
  const { app, execution, project } = await fixture();
  let finish!: (value: { deleted: true }) => void;
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    await beforeRetire();
    return new Promise((resolve) => { finish = resolve; });
  });
  const deletion = app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  const pending = deletion.then((response) => response);
  await vi.waitFor(() => expect(execution.retireProject).toHaveBeenCalledOnce());
  await expect(readFile(path.join(path.dirname(project.workspacePath), "project.json"), "utf8")).resolves.toContain(project.id);
  const job = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "fixture, never generated", projectId: project.id, nodeId: "node-1" } });
  expect(job.statusCode, job.body).toBe(409);
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).statusCode).toBe(409);
  const duplicate = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  expect(duplicate.statusCode).toBe(409);
  finish({ deleted: true });
  expect((await pending).statusCode).toBe(204);
  await expect(readFile(path.join(path.dirname(project.workspacePath), "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([true, false])("releases a source disk promise only after confirmed explicit project retirement: %s", async confirmed => {
  const { app, execution, project } = await fixture();
  const lease = await reserveRecoverySpace(project.workspacePath, { rawBytes: 1024, workingBytes: 1024, beforeBytes: 0, afterBytes: 1024, manifestBytes: 128, additionalEntries: 8 }, {
    namespace: "test", projectId: project.id, ownerKey: "a".repeat(32), generation: 7,
  });
  const intent = path.join(path.dirname(project.workspacePath), "isolated-space-reservations", lease.id + ".json");
  const before = await readFile(intent, "utf8");
  if (!confirmed) execution.retireProject.mockRejectedValueOnce(new Error("Retirement response is unknown"));
  try {
    const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
    expect(response.statusCode, response.body).toBe(confirmed ? 204 : 409);
    if (confirmed) {
      await expect(readFile(intent)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(404);
    } else {
      expect(await readFile(intent, "utf8")).toBe(before);
      expect(await readFile(path.join(path.dirname(project.workspacePath), "project.json"), "utf8")).toContain(project.id);
    }
  } finally { await lease.release(); }
});

it("retains a former VM source promise when the current app has no execution backend", async () => {
  const { app, project } = await fixture(undefined, false);
  const lease = await reserveRecoverySpace(project.workspacePath, { rawBytes: 1024, workingBytes: 1024, beforeBytes: 0, afterBytes: 1024, manifestBytes: 128, additionalEntries: 8 }, {
    namespace: "manual", projectId: project.id, ownerKey: "b".repeat(32), generation: 7,
  });
  const intent = path.join(path.dirname(project.workspacePath), "isolated-space-reservations", lease.id + ".json");
  const before = await readFile(intent, "utf8");
  try {
    const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
    expect(response.statusCode, response.body).toBe(409);
    expect(await readFile(intent, "utf8")).toBe(before);
    expect(await readFile(path.join(path.dirname(project.workspacePath), "project.json"), "utf8")).toContain(project.id);
  } finally { await lease.release(); }
});

it("refuses deletion before retiring any data when originals still require recovery", async () => {
  const { app, execution, project, directory } = await fixture();
  const recovery = path.join(directory, "projects", project.id, "image-originals");
  await mkdir(recovery);
  await writeFile(path.join(recovery, "original"), "retained");
  const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("Legacy image recovery");
  expect(execution.retireProject).not.toHaveBeenCalled();
  expect(await readFile(path.join(recovery, "original"), "utf8")).toBe("retained");
  expect((await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Still editable" } })).statusCode).toBe(200);
});

it("keeps host files when retirement fails and exposes generation-bound recovery instead of reporting deletion", async () => {
  const { app, execution, project, directory } = await fixture();
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    await beforeRetire();
    throw new Error("Retained unsynchronized source requires recovery");
  });
  const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  expect(response.statusCode).toBe(409);
  expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toContain(project.id);
  expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(200);
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 7, state: "resident", dirty: true, active: false } as never);
  const storage = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(storage.statusCode, storage.body).toBe(200);
  expect(storage.json()).toMatchObject({ state: "recovery-pending", generation: "7", recoverable: true });
  const recovered = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "7" } });
  expect(recovered.statusCode, recovered.body).toBe(200);
  expect(execution.recoverSource).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), expect.any(Function), "7", undefined, undefined);
  expect((await app.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(200);
});

it("never offers source recovery for an active dirty guest operation", async () => {
  const { app, execution, project } = await fixture();
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 8, state: "resident", dirty: true, active: true } as never);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(response.json()).toMatchObject({ state: "busy", dirty: true, recoverable: false, generation: "8" });
});

it("does not advertise or start recovery when retained-file inspection is unavailable", async () => {
  const { app, execution, project } = await fixture();
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, namespace: "test", generation: 37,
    state: "recovery-pending", dirty: true, active: false } as never);
  execution.inspectSource.mockResolvedValue(undefined as never);
  await writeFile(path.join(project.workspacePath, "keep.txt"), "user work");
  const status = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(status.json()).toMatchObject({ dirty: true, recoverable: false, reason: expect.stringContaining("eligibility could not be established") });
  const recovered = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "37" } });
  expect(recovered.json().code).toBe("execution_recovery_not_started");
  expect(execution.recoverSource).not.toHaveBeenCalled();
  expect(await readFile(path.join(project.workspacePath, "keep.txt"), "utf8")).toBe("user work");
});

it("describes metadata eligibility without claiming complete validation and rechecks new blockers before recovery", async () => {
  const { app, execution, project } = await fixture();
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, namespace: "test", generation: 37,
    state: "recovery-pending", dirty: true, active: false } as never);
  const status = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(status.json()).toMatchObject({ dirty: true, recoverable: true, recoveryValidation: "metadata-only",
    reason: expect.stringContaining("does not confirm that files can be returned") });
  execution.inspectSource.mockResolvedValue({ namespace: "test", projectId: project.id, generation: 37,
    complete: true, changes: [{ path: "public/boss.png", kind: "blocked", size: 728431, reason: "Raster exceeds 512 KiB" }], excluded: 0, blockers: 1 } as never);
  const recovered = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "37" } });
  expect(recovered.json().code).toBe("execution_recovery_not_started");
  expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("shows bounded retained-file diagnostics and stops recovery before known blockers", async () => {
  const { app, execution, project } = await fixture();
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 7, state: "resident", dirty: true, active: false } as never);
  const inspection = { namespace: "test", projectId: project.id, generation: 7, complete: true, excluded: 2, blockers: 1,
    changes: [{ path: "public/new.mp4", kind: "blocked", size: 3 * 1024 * 1024, reason: "New media has no verified host original; retained for review" }] };
  execution.inspectSource.mockResolvedValue(inspection as never);
  const status = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(status.json()).toMatchObject({ recoverable: false, inspection });
  expect(status.json().reason).toContain("public/new.mp4");
  expect(execution.recoverSource).not.toHaveBeenCalled();
  const recovered = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "7" } });
  expect(recovered.statusCode).toBe(409);
  expect(recovered.json().code).toBe("execution_recovery_not_started");
  expect(recovered.json().error).toContain("review");
  expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("keeps interrupted host publication links and originals for review without a guest recovery request", async () => {
  const { app, execution, project } = await fixture();
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 7, state: "resident", dirty: true, active: false } as never);
  const file = path.join(project.workspacePath, "note.js");
  const retained = path.join(path.dirname(project.workspacePath), "isolated-changes", "fixture", "after");
  await mkdir(retained, { recursive: true });
  await writeFile(file, "retained partial publication");
  await link(file, path.join(retained, "note.js"));
  const status = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(status.json()).toMatchObject({ recoverable: false, dirty: true });
  expect(status.json().reason).toContain("note.js");
  expect(status.json().reason).toContain("isolated-changes");
  const recovered = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "7" } });
  expect(recovered.json().code).toBe("execution_recovery_not_started");
  expect(execution.recoverSource).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe("retained partial publication");
  expect(await readFile(path.join(retained, "note.js"), "utf8")).toBe("retained partial publication");
});

it("records retirement only after preparation, before allowing any host deletion", async () => {
  const { app, execution, project, directory } = await fixture();
  const record = path.join(directory, "project-lifecycle", project.id + ".json");
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    expect(JSON.parse(await readFile(record, "utf8")).phase).toBe("requested");
    expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toContain(project.id);
    await beforeRetire();
    expect(JSON.parse(await readFile(record, "utf8")).phase).toBe("retiring-volume");
    expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toContain(project.id);
    return { deleted: true };
  });
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  await expect(readFile(record)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["start failed", "inventory could not be verified"])("does not strand a new deletion when preparation fails: %s", async (message) => {
  const { app, execution, project, directory } = await fixture();
  const original = await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8");
  execution.retireProject.mockRejectedValue(Object.assign(new Error(message), { code: "EXECUTION_RETIREMENT_UNAVAILABLE", changed: false }));
  const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ code: "execution_retirement_unavailable" });
  expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toBe(original);
  expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("aborted");
  const rename = await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Still available" } });
  expect(rename.statusCode, rename.body).toBe(200);
});

it("keeps an existing uncertain retirement pending when a later preparation cannot be verified", async () => {
  const { app, execution, project, directory } = await fixture();
  const record = path.join(directory, "project-lifecycle", project.id + ".json");
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    await beforeRetire();
    throw new Error("Retirement reply lost");
  });
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(409);
  expect(JSON.parse(await readFile(record, "utf8")).phase).toBe("retiring-volume");
  execution.retireProject.mockRejectedValue(Object.assign(new Error("Could not verify execution storage"), { code: "EXECUTION_RETIREMENT_UNAVAILABLE", changed: false }));
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).json().code).toBe("execution_retirement_unavailable");
  expect(JSON.parse(await readFile(record, "utf8")).phase).toBe("retiring-volume");
  expect((await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Must stay blocked" } })).statusCode).toBe(409);
  expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toContain(project.id);
  expect(execution.retireProject).toHaveBeenCalledTimes(2);
});

it("keeps an unconfigured local project deletion independent of a VM", async () => {
  const { app, execution, project } = await fixture(undefined, false);
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  expect(execution.retireProject).not.toHaveBeenCalled();
  expect(execution.storageOverview).not.toHaveBeenCalled();
});

it.each([
  ["RECOVERY_REQUIRED", false],
  ["DELETE_UNCERTAIN", true],
  ["REPLY_LOST", undefined],
] as const)("preserves host files and the pending journal after a sent retirement: %s", async (code, changed) => {
  const { app, execution, project, directory } = await fixture();
  const marker = path.join(project.workspacePath, "keep-source.txt");
  await writeFile(marker, "source bytes must survive every refusal");
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    await beforeRetire();
    throw Object.assign(new Error(code), { code, changed });
  });
  const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe("project_lifecycle_pending");
  expect(execution.retireProject).toHaveBeenCalledOnce();
  expect(await readFile(marker, "utf8")).toBe("source bytes must survive every refusal");
  expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("retiring-volume");
  expect((await app.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Must stay blocked" } })).statusCode).toBe(409);
});

it("finishes a pending deletion only after a new explicit request receives fresh retirement confirmation", async () => {
  const { app, execution, project, directory } = await fixture();
  execution.retireProject.mockImplementationOnce(async (_project, beforeRetire) => {
    await beforeRetire();
    throw new Error("Reply lost after retirement may have completed");
  });
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(409);
  expect(execution.retireProject).toHaveBeenCalledOnce();
  expect(await readFile(path.join(directory, "projects", project.id, "project.json"), "utf8")).toContain(project.id);
  execution.retireProject.mockImplementationOnce(async (_project, beforeRetire) => {
    expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("retiring-volume");
    await beforeRetire();
    return { deleted: true, absent: true };
  });
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  expect(execution.retireProject).toHaveBeenCalledTimes(2);
  await expect(readFile(path.join(directory, "project-lifecycle", project.id + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves the host-deletion stage on a host failure and completes only on an explicit retry", async () => {
  const { app, execution, project, directory } = await fixture();
  const marker = path.join(project.workspacePath, "retained-host-file.txt");
  await writeFile(marker, "fixture retained across host failure");
  const remove = vi.spyOn(ProjectManager.prototype, "delete").mockRejectedValueOnce(new Error("Injected host removal failure"));
  try {
    const response = await app.inject({ method: "DELETE", url: `/projects/${project.id}` });
    expect(response.statusCode, response.body).toBe(409);
    expect(execution.retireProject).toHaveBeenCalledOnce();
    expect(await readFile(marker, "utf8")).toBe("fixture retained across host failure");
    expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("deleting-host");
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "1" } })).statusCode).toBe(409);
    expect(execution.recoverSource).not.toHaveBeenCalled();
  } finally { remove.mockRestore(); }
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  expect(execution.retireProject).toHaveBeenCalledTimes(2);
  await expect(readFile(path.join(directory, "project-lifecycle", project.id + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reloads a partial host deletion as pending and preserves remaining files until an explicit retry", async () => {
  const { app, execution, project, directory } = await fixture();
  const removed = path.join(project.workspacePath, "partially-removed-fixture.txt");
  const retained = path.join(project.workspacePath, "remaining-source.txt");
  await writeFile(removed, "fixture selected for fault injection");
  await writeFile(retained, "remaining bytes must not be guessed away");
  const remove = vi.spyOn(ProjectManager.prototype, "delete").mockImplementationOnce(async (id) => {
    expect(id).toBe(project.id);
    await rm(removed);
    throw new Error("Injected interruption after one host file was removed");
  });
  try {
    expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(409);
  } finally { remove.mockRestore(); }
  expect(execution.retireProject).toHaveBeenCalledOnce();
  expect(await readFile(retained, "utf8")).toBe("remaining bytes must not be guessed away");
  await expect(readFile(removed)).rejects.toMatchObject({ code: "ENOENT" });
  await app.close();
  const agentDirectory = path.join(directory, "agent");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const restarted = createApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => runtime, projectExecution: execution as never });
  cleanups.push(() => restarted.close());
  expect((await restarted.inject({ method: "GET", url: `/projects/${project.id}` })).statusCode).toBe(200);
  expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("deleting-host");
  expect((await restarted.inject({ method: "PATCH", url: `/projects/${project.id}`, payload: { name: "Still blocked after restart" } })).statusCode).toBe(409);
  expect((await restarted.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "1" } })).statusCode).toBe(409);
  expect(execution.recoverSource).not.toHaveBeenCalled();
  expect(await readFile(retained, "utf8")).toBe("remaining bytes must not be guessed away");
  expect(execution.retireProject).toHaveBeenCalledOnce();
  expect((await restarted.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(204);
  expect(execution.retireProject).toHaveBeenCalledTimes(2);
  await expect(readFile(path.join(directory, "project-lifecycle", project.id + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects malformed recovery generations before invoking the execution backend", async () => {
  const { app, execution, project } = await fixture();
  for (const payload of [{}, { generation: "../other" }, { generation: 7 }, { generation: "7", discard: true }]) {
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload })).statusCode).toBe(400);
  }
  expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("uses the workspace write guard when returning retained guest source", async () => {
  const { app, execution, project } = await fixture();
  execution.recoverSource.mockImplementation(async (_project: unknown, guard: (operation: () => Promise<unknown>) => Promise<unknown>) => {
    await guard(async () => { await writeFile(path.join(project.workspacePath, "recovered.txt"), "retained fixture"); return { changed: ["recovered.txt"] }; });
    return { changed: ["recovered.txt"] };
  });
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "1" } });
  expect(response.statusCode, response.body).toBe(200);
  expect(await readFile(path.join(project.workspacePath, "recovered.txt"), "utf8")).toBe("retained fixture");
  expect(response.headers["x-workspace-version"]).not.toBe("0");
});

it("announces host publication even when the subsequent guest acknowledgement fails", async () => {
  const { app, execution, project } = await fixture();
  execution.recoverSource.mockImplementation(async (_project: unknown, guard: (operation: () => Promise<unknown>) => Promise<unknown>) => {
    await guard(async () => { await writeFile(path.join(project.workspacePath, "retained.txt"), "retained fixture"); return { changed: ["retained.txt"] }; });
    throw Object.assign(new Error("Guest acknowledgement response lost"), { changed: false });
  });
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "1" } });
  expect(response.statusCode).toBe(409);
  expect(response.headers["x-workspace-version"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.json().code).toBe("execution_recovery_required");
  const notice = await readFile(path.join(path.dirname(project.workspacePath), "workspace-restore-notice.txt"), "utf8");
  expect(notice).toContain("retained.txt");
  expect(notice).toContain("acknowledgement may still be pending");
  expect(await readFile(path.join(project.workspacePath, "retained.txt"), "utf8")).toBe("retained fixture");
});

it("preserves pending deletion and refuses source recovery while a checkpoint restore is unfinished", async () => {
  const { app, execution, project, directory } = await fixture();
  execution.retireProject.mockImplementation(async (_project, beforeRetire) => {
    await beforeRetire();
    throw new Error("Retained source requires recovery");
  });
  expect((await app.inject({ method: "DELETE", url: `/projects/${project.id}` })).statusCode).toBe(409);
  const previous = await new CheckpointStore().snapshot(project);
  const note = path.join(checkpointDirectory(project), "ohmygame-unfinished.json");
  await writeFile(note, JSON.stringify({ previous }));
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/execution-storage/recover`, payload: { generation: "1" } });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error).toContain("interrupted file restore");
  expect(execution.recoverSource).not.toHaveBeenCalled();
  expect(await readFile(note, "utf8")).toContain(previous);
  expect(JSON.parse(await readFile(path.join(directory, "project-lifecycle", project.id + ".json"), "utf8")).phase).toBe("retiring-volume");
});


it("gives the active main Agent generation-bound recovery through the guarded publisher", async () => {
  let completed = false;
  let toolResult: unknown;
  const session = vi.spyOn(agentRuntime, "createPiSession").mockImplementation(async (_project, _manager, registered) => ({
    messages: [], abort: async () => {}, dispose: () => {}, subscribe: () => () => {},
    getAllTools: () => registered!.map(tool => ({ name: tool.name })),
    prompt: async () => {
      const tool = registered!.find(tool => tool.name === "recover_isolated_changes")!;
      expect(tool).toBeDefined();
      const capacity = await tool.execute("capacity", { action: "capacity" }, undefined, undefined, {} as never);
      expect(capacity.details).toMatchObject({ capacity: { basis: "metadata-only", authorization: "none", transfer: { incrementalBytes: null }, guest: { volumeFreeBytes: null } } });
      const first = await tool.execute("first-allocation", { action: "plan_first_allocation" }, undefined, undefined, {} as never);
      expect(first.details).toMatchObject({ firstAllocationPlan: { purpose: "first-allocation-planning-only", authorization: "none", applicability: "unknown", recommendedProfileId: null,
        choices: [ { profileId: "current-64", readyForAllocation: false }, { profileId: "capacity-128-v2", readyForAllocation: false }, { profileId: "capacity-128-media64-v3", readyForAllocation: false } ] } });
      expect(execution.inventoryProject).not.toHaveBeenCalled();
      expect(execution.recoverSource).not.toHaveBeenCalled();
      for (const profileId of ["capacity-64-v1", "capacity-128-v1", "capacity-256-v1"]) {
        const proposal = await tool.execute("plan-" + profileId, { action: "plan_capacity", profileId }, undefined, undefined, {} as never);
        expect(proposal.details).toMatchObject({ capacityProposal: {
          profile: { id: profileId, runtimeEnabled: false, simulationOnly: true },
          authorization: "none", readyForMigration: false,
          basis: "eligible-workspace-metadata-with-unverified-canvas-excluded",
        } });
        expect(execution.recoverSource).not.toHaveBeenCalled();
      }
      await tool.execute("inspect", { action: "inspect" }, undefined, undefined, {} as never);
      toolResult = await tool.execute("recover", { action: "recover", generation: "4" }, undefined, undefined, {} as never);
      completed = true;
    },
  }));
  cleanups.push(async () => { session.mockRestore(); });
  const { app, execution, project } = await fixture(undefined, true, true);
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 4, state: "resident", dirty: true, active: false } as never);
  execution.recoverSource.mockImplementation(async (_project: unknown, guard: (operation: () => Promise<unknown>) => Promise<unknown>) => {
    expect((await app.inject({ method: "GET", url: "/projects/activity" })).json().activity).toContainEqual({ projectId: project.id, status: "running" });
    await guard(async () => {
      await writeFile(path.join(project.workspacePath, "recovered.txt"), "retained Agent fixture");
      return { changed: ["recovered.txt"] };
    });
    return { changed: ["recovered.txt"] };
  });
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).json();
  const turn = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Recover retained isolated changes" } });
  expect(turn.statusCode, turn.body).toBe(202);
  await vi.waitFor(() => expect(completed).toBe(true));
  expect(execution.recoverSource).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), expect.any(Function), "4", undefined, undefined);
  expect(await readFile(path.join(project.workspacePath, "recovered.txt"), "utf8")).toBe("retained Agent fixture");
  expect(await readFile(path.join(path.dirname(project.workspacePath), "workspace-restore-notice.txt"), "utf8")).toContain("recovered.txt");
  expect(toolResult).toMatchObject({ details: { changed: ["recovered.txt"] } });
});

it("lets the main Agent request preparation and a trusted v2 approval without publishing during review", async () => {
  const trace: string[] = [];
  let prepared!: IsolatedSourceReview, initial!: IsolatedSourceReview, approved = false, finished = false;
  let working!: Buffer;
  const session = vi.spyOn(agentRuntime, "createPiSession").mockImplementation(async (_project, _manager, registered) => ({
    messages: [], abort: async () => {}, dispose: () => {}, subscribe: () => () => {},
    getAllTools: () => registered!.map(tool => ({ name: tool.name })),
    prompt: async () => {
      const tool = registered!.find(tool => tool.name === "recover_isolated_changes")!;
      trace.push("inspect");
      await tool.execute("inspect", { action: "inspect" }, undefined, undefined, {} as never);
      trace.push("review");
      await tool.execute("review", { action: "review" }, undefined, undefined, {} as never);
      trace.push("preserve");
      const preserved = await tool.execute("preserve", { action: "optimize", reviewId: initial.reviewId, paths: initial.optimizablePaths! }, undefined, undefined, {} as never);
      expect(preserved.details).toMatchObject({ blockers: [expect.objectContaining({ path: "public/boss.png" })] });
      await tool.execute("explicit", { action: "optimize", reviewId: "d".repeat(64), paths: initial.optimizablePaths!, maxEdge: 256 }, undefined, undefined, {} as never);
      trace.push("adopt");
      await tool.execute("adopt-v2", { action: "adopt", reviewId: prepared.reviewId }, undefined, undefined, {} as never);
      finished = true;
    },
  }));
  cleanups.push(async () => { session.mockRestore(); });
  const { app, execution, project, directory } = await fixture(undefined, true, true);
  const pixels = Buffer.alloc(512 * 512 * 4); let seed = 417;
  for (let index = 0; index < pixels.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[index] = index % 4 === 3 ? 120 : seed >>> 24; }
  const original = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  working = await sharp(original).resize(256, 256).png().toBuffer();
  const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
  const originalPath = path.join(directory, "independent-original.png"); await writeFile(originalPath, original);
  initial = { reviewVersion: 2, reviewId: "a".repeat(64), projectId: project.id, generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: "b".repeat(64), approved: false, expiresAt: "2099-01-01T00:00:00Z", optimizablePaths: ["public/boss.png"],
    files: [{ path: "public/boss.png", kind: "image", change: "added", bytes: original.length, afterSha256: digest(original) }, { path: "tools/ready.mjs", kind: "code", change: "added", bytes: 26, afterSha256: digest("export const ready = true;"), preview: "export const ready = true;" }], blockers: [{ path: "public/boss.png", reason: "Original dimensions do not fit this return path; keep the original or choose an explicit derivative" }] };
  prepared = { ...initial, reviewId: "e".repeat(64), preparedSnapshotId: "f".repeat(64), blockers: [], files: [{ ...initial.files[0]!, bytes: working.length, afterSha256: digest(working), optimization: { originalSha256: digest(original), originalBytes: original.length, originalWidth: 512, originalHeight: 512, width: 256, height: 256, maxEdge: 256, hasAlpha: true, originalRetained: true } }, initial.files[1]!] };
  const optimize = vi.fn(async (_project: ProjectState, reviewId: string, input: { paths: string[]; maxEdge?: number }, guard: <T>(operation: () => Promise<T>) => Promise<T>) => guard(async () => {
    trace.push("guard-enter");
    expect(input.paths).toEqual(["public/boss.png"]);
    expect((await app.inject({ method: "GET", url: "/projects/activity" })).json().activity).toContainEqual({ projectId: project.id, status: "running" });
    expect((await readFile(originalPath)).equals(original)).toBe(true);
    await expect(readFile(path.join(project.workspacePath, "public/boss.png"))).rejects.toMatchObject({ code: "ENOENT" });
    return input.maxEdge === undefined ? { ...initial, reviewId: "d".repeat(64) } : prepared;
  }));
  Object.assign(execution, { reviewSource: vi.fn(async () => initial), optimizeSourceReview: optimize,
    sourceReview: vi.fn(async () => ({ ...prepared, approved })), approveSourceReview: vi.fn(async () => { approved = true; }),
    approvedSourceReview: vi.fn(async () => approved ? { ...prepared, approved } : undefined) });
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 7, state: "resident", dirty: true, active: false } as never);
  execution.inspectSource.mockRejectedValue(new Error("Stopped volume; use explicit read-only review"));
  execution.recoverSource.mockImplementation(async (_project, guard) => {
    expect(approved).toBe(true);
    return guard(async () => {
      await mkdir(path.join(project.workspacePath, "public"), { recursive: true }); await mkdir(path.join(project.workspacePath, "tools"), { recursive: true });
      await writeFile(path.join(project.workspacePath, "public/boss.png"), working);
      await writeFile(path.join(project.workspacePath, "tools/ready.mjs"), "export const ready = true;");
      return { changed: ["public/boss.png", "tools/ready.mjs"] };
    });
  });
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).json();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Use the controlled recovery tools to prepare retained results" } })).statusCode).toBe(202);
  const url = `/projects/${project.id}/conversations/${conversation.id}/approvals/adopt-v2`;
  await vi.waitFor(async () => {
    const refused = await app.inject({ method: "POST", url, payload: { decision: "allow", sourceConfirmation: { reviewId: prepared.reviewId, filesReviewed: true } } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error, trace.join(" → ")).toContain("Confirm the exact");
  });
  expect(execution.recoverSource).not.toHaveBeenCalled();
  const allowed = await app.inject({ method: "POST", url, payload: { decision: "allow", sourceConfirmation: { reviewId: prepared.reviewId, filesReviewed: true, codeReviewed: true } } });
  expect(allowed.statusCode, allowed.body).toBe(204);
  await vi.waitFor(() => expect(finished).toBe(true));
  expect(optimize.mock.calls.map(call => call[2].maxEdge)).toEqual([undefined, 256]);
  expect(execution.recoverSource).toHaveBeenCalledOnce();
  expect((await readFile(originalPath)).equals(original)).toBe(true);
  expect((await readFile(path.join(project.workspacePath, "public/boss.png"))).equals(working)).toBe(true);
});

it.each(["allow", "deny"] as const)("uses trusted UI %s for a legacy batch and never accepts an Agent assertion instead of code confirmation", async decision => {
  let finished = false, outcome: unknown;
  const session = vi.spyOn(agentRuntime, "createPiSession").mockImplementation(async (_project, _manager, registered, _runtime, _model, _agentDir, _mcp, _transport, _snapshot, mutate) => ({
    messages: [], abort: async () => {}, dispose: () => {}, subscribe: () => () => {},
    getAllTools: () => registered!.map(tool => ({ name: tool.name })),
    prompt: async () => {
      const tool = registered!.find(tool => tool.name === "recover_isolated_changes")!;
      await tool.execute("inspect", { action: "inspect" }, undefined, undefined, {} as never);
      await tool.execute("review", { action: "review", generation: "22" }, undefined, undefined, {} as never);
      await expect(mutate!(async () => { throw new Error("unapproved write must not run"); })).rejects.toThrow("awaits trusted user confirmation");
      const generation = registered!.find(tool => tool.name === "optimize_image_asset")!;
      await expect(generation.execute("blocked-preparation", {} as never, undefined, undefined, {} as never)).rejects.toThrow("awaits trusted user confirmation");
      const canvasGeneration = registered!.find(tool => tool.name === "generate_canvas_media")! as import("../src/daemon/agent-auto-continue.js").RecoverableTool;
      await expect(canvasGeneration.recoverAfterHttp500!("blocked-continuation", {} as never, undefined, undefined, {} as never)).rejects.toThrow("awaits trusted user confirmation");
      try { outcome = await tool.execute("adopt-call", { action: "adopt", reviewId: "a".repeat(64) }, undefined, undefined, {} as never); }
      catch (error) { outcome = error; }
      finished = true;
    },
  }));
  cleanups.push(async () => { session.mockRestore(); });
  const { app, execution, project } = await fixture(undefined, true, true);
  let approved = false;
  const review: IsolatedSourceReview = { reviewId: "a".repeat(64), generation: "22", projectId: project.id, snapshotId: "b".repeat(64), files: [{ path: "tools/artprep.py", kind: "code", change: "added", bytes: 18, afterSha256: "c".repeat(64), preview: "print('fixture')" }], blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
  const legacy = Object.assign(execution, {
    reviewSource: vi.fn().mockResolvedValue(review), sourceReview: vi.fn(async () => ({ ...review, approved })),
    approveSourceReview: vi.fn(async () => { approved = true; }),
    approvedSourceReview: vi.fn(async () => approved ? { ...review, approved } : undefined),
    assertSourceReviewSettled: vi.fn(async () => { if (!approved) throw new Error("A retained batch awaits trusted user confirmation"); }),
  });
  execution.inventoryProject.mockResolvedValue({ projectId: project.id, generation: 22, state: "resident", dirty: true, active: false } as never);
  execution.inspectSource.mockRejectedValue(new Error("The existing source workspace is unavailable; no volume was mounted"));
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).json();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Review retained changes without assuming approval" } })).statusCode).toBe(202);
  const url = `/projects/${project.id}/conversations/${conversation.id}/approvals/adopt-call`;
  await vi.waitFor(async () => {
    const refused = await app.inject({ method: "POST", url, payload: { decision: "allow" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("Confirm the exact");
  });
  for (const payload of [
    { decision: "allow", sourceConfirmation: { reviewId: "d".repeat(64), filesReviewed: true, codeReviewed: true } },
    { decision: "allow", sourceConfirmation: { reviewId: review.reviewId, filesReviewed: true } },
    { decision: "allow-session", sourceConfirmation: { reviewId: review.reviewId, filesReviewed: true, codeReviewed: true } },
  ]) expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(409);
  expect(legacy.approveSourceReview).not.toHaveBeenCalled();
  expect(execution.recoverSource).not.toHaveBeenCalled();
  const response = await app.inject({ method: "POST", url, payload: { decision, ...(decision === "allow" ? { sourceConfirmation: { reviewId: review.reviewId, filesReviewed: true, codeReviewed: true } } : {}) } });
  expect(response.statusCode, response.body).toBe(204);
  await vi.waitFor(() => expect(finished).toBe(true));
  if (decision === "allow") {
    expect(legacy.approveSourceReview).toHaveBeenCalledOnce();
    expect(execution.recoverSource).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), expect.any(Function), "22", review.reviewId, undefined);
    expect(outcome).toMatchObject({ details: { changed: [] } });
    const status = (await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` })).json();
    expect(status).toMatchObject({ recoverable: true, approvedReviewId: review.reviewId });
  } else {
    expect(legacy.approveSourceReview).not.toHaveBeenCalled(); expect(execution.recoverSource).not.toHaveBeenCalled();
    expect((outcome as Error).message).toContain("not approved");
  }
});

it.each(["valid", "unknown-entry", "damaged-intent"] as const)("restores reservations for skipped damaged project cards and keeps %s promises behind their original gate", async variant => {
  // Use a cold application/ledger pair so an intentionally uncertain startup
  // cannot contaminate the ordinary route fixtures' module-owned reservation map.
  vi.resetModules();
  const space = await import("../src/daemon/recovery-space.js");
  const { createApp: coldCreateApp } = await import("../src/daemon/app.js");
  const restore = vi.spyOn(space, "restoreRecoverySpaceReservations");
  cleanups.push(async () => { restore.mockRestore(); vi.resetModules(); });
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lifecycle-startup-reservations-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const projectId = "11111111-1111-4111-8111-111111111111", reservationId = "22222222-2222-4222-8222-222222222222";
  const projectDirectory = path.join(directory, "projects", projectId), workspace = path.join(projectDirectory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const brokenMetadata = "{ damaged project metadata";
  await writeFile(path.join(projectDirectory, "project.json"), brokenMetadata, { mode: 0o600 });
  const reservationDirectory = path.join(projectDirectory, "isolated-space-reservations");
  await mkdir(reservationDirectory, { mode: 0o700 });
  const inputs = { rawBytes: 1024, workingBytes: 1024, beforeBytes: 0, afterBytes: 1024, manifestBytes: 128, additionalEntries: 8 };
  const owner = { ownerKey: "a".repeat(32), namespace: "test" as const, projectId, generation: 7, rawSnapshotId: "b".repeat(64) };
  const intent = { version: 1, id: reservationId, workspace, device: (await lstat(workspace)).dev, owner, plan: space.planRecoverySpace(inputs) };
  const reservationFile = path.join(reservationDirectory, reservationId + ".json"), originalIntent = JSON.stringify(intent);
  await writeFile(reservationFile, originalIntent, { mode: 0o600 });
  const suspect = variant === "unknown-entry" ? path.join(reservationDirectory, "unfinished.tmp") : variant === "damaged-intent" ? path.join(reservationDirectory, "33333333-3333-4333-8333-333333333333.json") : undefined;
  if (suspect) await writeFile(suspect, "{ incomplete reservation", { mode: 0o600 });
  const agentDirectory = path.join(directory, "agent"); await mkdir(agentDirectory);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const app = coldCreateApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => runtime });
  cleanups.push(() => app.close());
  await expect(app.ready()).resolves.toBe(app);
  expect(restore).toHaveBeenCalledExactlyOnceWith([workspace], []);
  const listed = await app.inject({ method: "GET", url: "/projects" });
  expect(listed.statusCode, listed.body).toBe(200); expect(listed.body).not.toContain(projectId);
  expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe(brokenMetadata);
  expect(await readFile(reservationFile, "utf8")).toBe(originalIntent);
  if (variant === "valid") {
    await expect(space.reserveRecoverySpace(workspace, inputs, { ...owner, ownerKey: "c".repeat(32) })).rejects.toThrow("unresolved reservation");
  } else {
    const freshWorkspace = path.join(directory, "fresh", "workspace"); await mkdir(freshWorkspace, { recursive: true });
    const allocate = () => space.reserveRecoverySpace(freshWorkspace, inputs, { ownerKey: "d".repeat(32), namespace: "test", projectId: "new-project" });
    await expect(allocate()).rejects.toThrow("startup could not establish all outstanding disk reservations");
    await space.restoreRecoverySpaceReservations([]);
    await expect(allocate()).rejects.toThrow("startup could not establish all outstanding disk reservations");
    expect(await readFile(suspect!, "utf8")).toBe("{ incomplete reservation");
  }
  expect(await readFile(reservationFile, "utf8")).toBe(originalIntent);
});

it("keeps startup available but blocks new allocations when a damaged project card hides a local image promise", async () => {
  vi.resetModules();
  const space = await import("../src/daemon/recovery-space.js");
  const { createApp: coldCreateApp } = await import("../src/daemon/app.js");
  cleanups.push(async () => { vi.resetModules(); });
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lifecycle-local-image-reservations-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const projectId = "44444444-4444-4444-8444-444444444444";
  const projectDirectory = path.join(directory, "projects", projectId), workspace = path.join(projectDirectory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(path.join(projectDirectory, "project.json"), "{ damaged metadata", { mode: 0o600 });
  const storage = path.join(directory, "image-recovery", projectId);
  const inputs = { rawBytes: 1024, workingBytes: 0, beforeBytes: 0, afterBytes: 1024, manifestBytes: 128, additionalEntries: 8 };
  const lease = await space.reserveLocalImageRecoverySpace({ workspace, storage, projectId }, inputs, { ownerKey: "e".repeat(32) });
  cleanups.push(() => lease.release());
  const intentPath = path.join(storage, "space-reservations", lease.id + ".json"), intent = await readFile(intentPath, "utf8");
  const agentDirectory = path.join(directory, "agent"); await mkdir(agentDirectory);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const app = coldCreateApp({ dataDirectory: directory, piAgentDirectory: agentDirectory, createModelRuntime: async () => runtime });
  cleanups.push(() => app.close());
  await expect(app.ready()).resolves.toBe(app);
  const listed = await app.inject({ method: "GET", url: "/projects" });
  expect(listed.statusCode).toBe(200); expect(listed.body).not.toContain(projectId);
  const fresh = path.join(directory, "fresh", "workspace"); await mkdir(fresh, { recursive: true });
  await expect(space.reserveRecoverySpace(fresh, inputs, { ownerKey: "f".repeat(32), namespace: "test", projectId: "new-project" })).rejects.toThrow("startup could not establish all outstanding disk reservations");
  expect(await readFile(intentPath, "utf8")).toBe(intent);
  expect(await readFile(path.join(projectDirectory, "project.json"), "utf8")).toBe("{ damaged metadata");
});


it("routes a main Agent capacity request through the native six-field confirmation without a model approval argument", async () => {
  let finished = false, review: ReturnType<typeof volumeMigrationReview> | undefined;
  const migration = vi.spyOn(VolumeMigrationCoordinator.prototype, "requestUpgrade").mockImplementation(async (project, ask, signal) => {
    review = volumeMigrationReview(project.id, true);
    const answer = await ask(review, signal);
    expect(answer).toEqual({ decision: "allow", volumeMigrationConfirmation: volumeMigrationConfirmation(review) });
    return { status: "committed", review };
  });
  const session = vi.spyOn(agentRuntime, "createPiSession").mockImplementation(async (_project, _manager, registered) => ({
    messages: [], abort: async () => {}, dispose: () => {}, subscribe: () => () => {},
    getAllTools: () => registered!.map(tool => ({ name: tool.name })),
    prompt: async () => {
      const tool = registered!.find(tool => tool.name === "recover_isolated_changes")!;
      await expect(tool.execute("forged-capacity", { action: "upgrade_capacity", approved: true } as never, undefined, undefined, {} as never)).rejects.toThrow("only its action");
      await tool.execute("medium-capacity", { action: "upgrade_capacity" }, undefined, undefined, {} as never);
      finished = true;
    },
  }));
  cleanups.push(async () => { session.mockRestore(); migration.mockRestore(); });
  const { app, execution, project } = await fixture(undefined, true, true, true);
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {} })).json();
  expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Request medium storage with native confirmation" } })).statusCode).toBe(202);
  const url = `/projects/${project.id}/conversations/${conversation.id}/approvals/medium-capacity`;
  await vi.waitFor(async () => {
    expect(review).toBeDefined();
    expect((await app.inject({ method: "POST", url, payload: { decision: "allow" } })).statusCode).toBe(409);
  });
  const exact = volumeMigrationConfirmation(review!);
  expect((await app.inject({ method: "POST", url, payload: { decision: "allow", volumeMigrationConfirmation: { ...exact, generation: 1 } } })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url, payload: { decision: "allow-session", volumeMigrationConfirmation: exact } })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url, payload: { decision: "allow", volumeMigrationConfirmation: { ...exact, capacityReviewed: false, approved: true } } })).statusCode).toBe(409);
  const allowed = await app.inject({ method: "POST", url, payload: { decision: "allow", volumeMigrationConfirmation: exact } });
  expect(allowed.statusCode, allowed.body).toBe(204);
  await vi.waitFor(() => expect(finished).toBe(true));
  expect(execution.recoverSource).not.toHaveBeenCalled();
  expect(migration).toHaveBeenCalledOnce();
});


it("never reports an unrecorded native capacity operation as absent storage", async () => {
  const { app, execution, project } = await fixture(undefined, true, false, true);
  const planId = "12345678-1234-1234-1234-123456789abc";
  execution.storageOverview.mockResolvedValue({ supported: true, vmState: "running", dataStatus: "current", checkedAt: new Date().toISOString(),
    snapshot: { capacityOverviewVersion: 1, countsTrusted: false, capacityReservations: [{ namespace: "test", projectId: project.id, planId,
      targetVolumeId: "a".repeat(32), volumeBytes: 512 * 1024 * 1024, phase: "unknown", sourceAbsent: true }] }, unallocatedProjects: null } as never);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ state: "unavailable", dirty: true, recoverable: false, reason: expect.stringContaining(planId) });
  expect(response.json().generation).toBeUndefined();
  expect(response.json().reason).toContain("inspect_capacity_migration");
  expect(execution.recoverSource).not.toHaveBeenCalled();
});

it("does not infer empty storage when native capacity reservation metadata is unavailable", async () => {
  const { app, execution, project } = await fixture(undefined, true, false, true);
  const response = await app.inject({ method: "GET", url: `/projects/${project.id}/execution-storage` });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "execution_storage_unavailable", error: expect.stringContaining("does not prove") });
  expect(execution.recoverSource).not.toHaveBeenCalled();
});
