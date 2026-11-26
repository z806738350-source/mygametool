import { ChildProcess } from "node:child_process";
import { getToolConfirmedFailure } from "../src/daemon/agent-tool-errors.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PassThrough } from "node:stream";
import { crc32, gzipSync } from "node:zlib";
import * as fs from "node:fs/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import { PreviewManager } from "../src/daemon/preview.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import {
  isolatedProjectStore,
  IsolatedProjectExecution,
} from "../src/daemon/isolated-project-execution.js";
import { IsolatedVmLifecycle } from "../src/daemon/isolated-vm-lifecycle.js";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { createIsolatedRecoveryTool, createIsolatedShellTool } from "../src/daemon/isolated-shell-tool.js";
import { createLocalAgentFileTools } from "../src/daemon/agent-local-files.js";
import { readSourceReview, reviewSnapshotDigest } from "../src/daemon/isolated-source-review.js";
import * as sourceReview from "../src/daemon/isolated-source-review.js";
import { validSourceConfirmation, type IsolatedSourceReview } from "../src/shared/execution-storage.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { prepareWorkingImage } from "../src/daemon/image-working-assets.js";
import * as retainedDisplay from "../src/daemon/retained-image-display.js";
import * as imagePreparation from "../src/daemon/image-working-assets.js";
import { getIsolatedRepairProof, getIsolatedRepairPending } from "../src/daemon/isolated-tool-receipts.js";
import { getIsolatedOperationReceipts, isolatedCommandsNotSubmitted, isIsolatedInputBudgetError, isolatedVmLeaseBusyError, withIsolatedOperationScope, type IsolatedOperationReceipt } from "../src/daemon/isolated-tool-receipts.js";
import { reserveRecoverySpace } from "../src/daemon/recovery-space.js";
import * as recoverySpace from "../src/daemon/recovery-space.js";
import { inspectExecutionCapacity } from "../src/daemon/execution-capacity.js";
import { createSourceManifest, createSourceManifestV2, planSourceDelta, type SourceManifestV1, type SourceManifestV2 } from "../src/daemon/isolated-source-manifest.js";
import { inspectSafeProjectMedia } from "../src/daemon/safe-project-file.js";
import { getRuntimeCapacityProfile, RUNTIME_CAPACITY_PROFILES, type RuntimeCapacityProfileId } from "../src/shared/execution-capacity-profiles.js";
import * as isolatedFiles from "../src/daemon/isolated-project-files.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const directories: string[] = [];
const children: ChildProcess[] = [];
const executions: IsolatedProjectExecution[] = [];
afterEach(async () => {
  await Promise.all(
    executions.splice(0).map((execution) => execution.close().catch(() => {})),
  );
  for (const child of children.splice(0)) child.emit("close", 0);
  spawn.mockReset();

});
// Retained mock transactions stay on disk for this process-global ledger until suite teardown.
afterAll(async () => {
  await isolatedFiles.closeRuntimeMediaSnapshots();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function capacityReportFixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "capacity-tool-"))); directories.push(directory);
  const workspace = path.join(directory, "workspace"); await mkdir(workspace);
  return inspectExecutionCapacity({ projectId: "capacity-tool-fixture", workspace, localImageAnchor: async () => { throw new Error("No image anchor in this read-only fixture"); } });
}

it("returns the typed capacity report without inspecting a generation or authorizing recovery", async () => {
  const report = await capacityReportFixture(), inspect = vi.fn(), recover = vi.fn(), review = vi.fn(), adopt = vi.fn();
  const capacity = vi.fn(async () => report), tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity });
  const controller = new AbortController(), output = await tool.execute("capacity-report", { action: "capacity" }, controller.signal, undefined, {} as never);
  expect(output.details).toEqual({ capacity: report });
  const content = output.content[0]; expect(content?.type).toBe("text"); if (content?.type !== "text") throw new Error("Capacity report should contain JSON text");
  expect(JSON.parse(content.text)).toEqual(report);
  expect(report.basis).toBe("metadata-only"); expect(report.authorization).toBe("none"); expect(report.guest.volumeFreeBytes).toBeNull();
  expect(capacity).toHaveBeenCalledExactlyOnceWith(controller.signal);
  await expect(tool.execute("capacity-not-consent", { action: "recover", generation: "7" }, undefined, undefined, {} as never)).rejects.toThrow("Inspect");
  for (const operation of [inspect, recover, review, adopt, spawn]) expect(operation).not.toHaveBeenCalled();
});

it.each([{ generation: "7" }, { reviewId: "a".repeat(64) }, { paths: ["public/boss.png"] }, { maxEdge: 512 }])("rejects recovery arguments in the read-only capacity action: %j", async extra => {
  const inspect = vi.fn(), recover = vi.fn(), review = vi.fn(), adopt = vi.fn();
  const capacity = vi.fn(async () => { throw new Error("Capacity must not run for invalid arguments"); });
  const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity });
  await expect(tool.execute("capacity-invalid", { action: "capacity", ...extra } as never, undefined, undefined, {} as never)).rejects.toThrow("Capacity accepts only action");
  for (const operation of [inspect, recover, review, adopt, capacity, spawn]) expect(operation).not.toHaveBeenCalled();
});

it("reports unavailable capacity without falling back to inspection, recovery or a VM operation", async () => {
  const inspect = vi.fn(), recover = vi.fn(), tool = createIsolatedRecoveryTool(inspect, recover);
  expect(JSON.stringify(tool.parameters)).toContain('"const":"capacity"');
  await expect(tool.execute("capacity-unavailable", { action: "capacity" }, undefined, undefined, {} as never)).rejects.toThrow("Capacity diagnostics are unavailable");
  await expect(tool.execute("recovery-not-authorized", { action: "recover", generation: "7" }, undefined, undefined, {} as never)).rejects.toThrow("Inspect");
  for (const operation of [inspect, recover, spawn]) expect(operation).not.toHaveBeenCalled();
});

it("does not start a cancelled capacity callback or use another recovery action as a fallback", async () => {
  const inspect = vi.fn(), recover = vi.fn(), review = vi.fn(), adopt = vi.fn(), capacity = vi.fn();
  const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity });
  const controller = new AbortController(); controller.abort();
  await expect(tool.execute("capacity-cancelled", { action: "capacity" }, controller.signal, undefined, {} as never)).rejects.toThrow();
  for (const operation of [inspect, recover, review, adopt, capacity, spawn]) expect(operation).not.toHaveBeenCalled();
});

it.each([false, true])("preserves an inspected generation and its uncertain recovery latch across capacity reporting; unavailable=%s", async unavailable => {
  const report = await capacityReportFixture();
  const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation: "7" }));
  const recover = vi.fn(async () => { throw new Error("Original ACK was lost"); }), review = vi.fn(), adopt = vi.fn();
  const capacity = vi.fn(async () => { if (unavailable) throw new Error("Host capacity observation unavailable"); return report; });
  const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity });
  const call = (input: Parameters<typeof tool.execute>[1]) => tool.execute("capacity-state", input, undefined, undefined, {} as never);
  await call({ action: "inspect" });
  const observe = () => unavailable ? expect(call({ action: "capacity" })).rejects.toThrow("observation unavailable") : expect(call({ action: "capacity" })).resolves.toMatchObject({ details: { capacity: report } });
  await observe();
  await expect(call({ action: "recover", generation: "7" })).rejects.toThrow("Original ACK was lost");
  await call({ action: "inspect" }); await observe();
  await expect(call({ action: "recover", generation: "7" })).rejects.toThrow("uncertain");
  expect(inspect).toHaveBeenCalledTimes(2); expect(recover).toHaveBeenCalledOnce(); expect(capacity).toHaveBeenCalledTimes(2);
  for (const operation of [review, adopt, spawn]) expect(operation).not.toHaveBeenCalled();
});

it.each([false, true])("keeps the reviewed batch and original uncertain adoption identity across capacity reports; unavailable=%s", async unavailable => {
  const report = await capacityReportFixture();
  const retained: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), files: [], blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
  const inspect = vi.fn(), recover = vi.fn(), review = vi.fn(async () => retained), verify = vi.fn(), optimize = vi.fn();
  const adopt = vi.fn(async () => { throw new Error("Adoption completion is unknown"); });
  const capacity = vi.fn(async () => { if (unavailable) throw new Error("Capacity report unavailable"); return report; });
  const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, verify, optimize, capacity });
  const call = (input: Parameters<typeof tool.execute>[1]) => tool.execute("capacity-reviewed-state", input, undefined, undefined, {} as never);
  const observe = () => unavailable ? expect(call({ action: "capacity" })).rejects.toThrow("unavailable") : expect(call({ action: "capacity" })).resolves.toMatchObject({ details: { capacity: report } });
  await call({ action: "review", generation: "7" }); await observe();
  await expect(call({ action: "adopt", reviewId: retained.reviewId })).rejects.toThrow("Adoption completion is unknown");
  await observe();
  await expect(call({ action: "adopt", reviewId: retained.reviewId })).rejects.toThrow("uncertain");
  await expect(call({ action: "verify", reviewId: "c".repeat(64) })).rejects.toThrow("original reviewed transaction");
  await expect(call({ action: "optimize", reviewId: retained.reviewId, paths: ["public/boss.png"] })).rejects.toThrow("uncertain");
  expect(review).toHaveBeenCalledExactlyOnceWith("7", undefined); expect(adopt).toHaveBeenCalledOnce();
  for (const operation of [inspect, recover, verify, optimize, spawn]) expect(operation).not.toHaveBeenCalled();
});

it("discards a capacity response cancelled during its callback without falling back to inspection", async () => {
  const report = await capacityReportFixture(), controller = new AbortController();
  const inspect = vi.fn(), recover = vi.fn(), review = vi.fn(), adopt = vi.fn();
  const capacity = vi.fn(async () => { controller.abort(); return report; });
  const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity });
  await expect(tool.execute("capacity-late-cancel", { action: "capacity" }, controller.signal, undefined, {} as never)).rejects.toThrow();
  expect(capacity).toHaveBeenCalledExactlyOnceWith(controller.signal);
  for (const operation of [inspect, recover, review, adopt, spawn]) expect(operation).not.toHaveBeenCalled();
});

it("keeps the shell's legacy raster limit distinct from capture-v2 approval and capacity diagnostics", () => {
  const tool = createIsolatedShellTool(vi.fn());
  expect(tool.description).toContain("512 KiB static PNG/JPEG/WebP derivative bound applies only to legacy raster-return version 1");
  expect(tool.description).toContain("New captureVersion 2 raster candidates require complete review and trusted approval");
  expect(tool.description).toContain("A capacity report is not recovery approval"); expect(spawn).not.toHaveBeenCalled();
});

type ControlHandler = (
  input: any,
  child: ChildProcess,
  args: string[],
) => unknown | Promise<unknown>;
const resourceLimits = {
  residentVolumes: 8,
  volumeBytes: 256 * 1024 * 1024,
  totalLogicalBytes: 4 * 1024 ** 3,
  reserveBytes: 1024 ** 3,
  globalOperations: 2,
  identityRange: [5000, 5095],
};
function sourceFile(name: string, text: string) {
  return {
    path: name,
    data: Buffer.from(text).toString("base64"),
    sha256: createHash("sha256").update(text).digest("hex"),
    executable: false,
  };
}
async function fixture(namespace: "manual" | "test" = "test", vm?: unknown) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-isolated-test-")),
  );
  directories.push(directory);
  const id = "5e849fb8-9236-4f0e-a58a-76cb223b8a74";
  const workspacePath = path.join(directory, id, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const execution = Reflect.construct(IsolatedProjectExecution, [
    directory,
    vm,
    namespace,
  ]) as IsolatedProjectExecution;
  executions.push(execution);
  const requests: { operation: string; input: any; args: string[] }[] = [];
  const handlers = new Map<string, ControlHandler>();
  const operations = new Map<string, any>();
  const projects = new Map<string, any>();
  const runs = new Map<string, ChildProcess>();
  const runOutputs = new Map<string, PassThrough>();
  const defaultResponse: ControlHandler = (input, _child, args) => {
    switch (args[8]) {
      case "health":
        return { protocolVersion: 2, ready: true, limits: resourceLimits };
      case "inventory":
        return {
          protocolVersion: 2,
          namespace: input.namespace,
          projects: [...projects.values()],
        };
      case "prepare": {
        const binding = {
          namespace: input.namespace,
          projectId: input.projectId,
          operationId: input.operationId,
          generation: projects.get(input.projectId)?.generation ?? 1,
          leaseToken: "e".repeat(32),
        };
        operations.set(input.operationId, binding);
        projects.set(input.projectId, {
          projectId: input.projectId,
          namespace: input.namespace,
          generation: binding.generation,
          state: "resident",
          dirty: false,
          active: false,
        });
        return {
          ...binding,
          prepared: true,
          protocolVersion: 2,
          sourceDigest: "a".repeat(64),
        };
      }
      case "recover": {
        const binding = { ...input, leaseToken: "e".repeat(32) };
        operations.set(input.operationId, binding);
        return binding;
      }
      case "capture":
        return {
          files: [],
          baselineFiles: [],
          snapshotId: "b".repeat(64),
          generation: input.generation,
        };
      case "acknowledge":
        return { acknowledged: true };
      case "release":
        return { released: true, dirty: false };
      case "retire":
        return { deleted: true, absent: !projects.has(input.projectId) };
      case "export":
        return { files: [] };
      case "cancel": {
        runs.get(input.operationId)?.emit("close", 1);
        return { stopped: true, operation: operations.get(input.operationId) };
      }
      default:
        throw new Error("Unexpected mocked operation: " + args[8]);
    }
  };
  spawn.mockImplementation((_command, args) => {
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    if (args[8] === "run") {
      runs.set(args[9], child);
      runOutputs.set(args[9], child.stdout as PassThrough);
      return child;
    }
    let raw = "";
    child.stdin.on("data", (chunk) => {
      raw += chunk.toString();
    });
    child.stdin.on("finish", async () => {
      const input = raw ? JSON.parse(raw) : undefined;
      requests.push({ operation: args[8], input, args });
      try {
        const value = await (handlers.get(args[8]) ?? defaultResponse)(
          input,
          child,
          args,
        );
        (child.stdout as PassThrough).end(JSON.stringify(value));
        queueMicrotask(() => child.emit("close", 0));
      } catch (cause) {
        (child.stdout as PassThrough).end(
          JSON.stringify({
            error: {
              code: "MOCK_FAILURE",
              message: (cause as Error).message,
              changed: false,
            },
          }),
        );
        queueMicrotask(() => child.emit("close", 1));
      }
    });
    return child;
  });
  const completeRun = (id: string, code = 0) => {
    runOutputs
      .get(id)!
      .write(JSON.stringify({ kind: "exit", id, code }) + "\n");
    runs.get(id)!.emit("close", code);
  };
  return {
    execution,
    project: { id, workspacePath } as ProjectState,
    workspacePath,
    requests,
    handlers,
    operations,
    projects,
    runs,
    runOutputs,
    completeRun,
    defaultResponse,
  };
}

async function retainedFixture(options: { raw?: Buffer; policy?: 0 | 1; origins?: boolean; lostAck?: boolean; small?: boolean; noOp?: boolean; invalidRecoveryOrigin?: "operation" | "mode" | "phase" } = {}) {
  const f = await fixture(), raw = options.raw ?? (options.small ? referencePng({ width: 32, height: 32, noise: true, level: 0 }) : referencePng({ width: 1024, height: 1024, noise: true, level: 0 }));
  const image = { path: "public/frame.png", size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), executable: false as const };
  const source = sourceFile("game.js", "export const frameSize = 256;\n"), snapshotId = reviewSnapshotDigest([source, image]);
  const policy = options.policy ?? 1; let ackId: string | undefined, releasedId: string | undefined, held = false;
  const baseline: Array<{ path: string; sha256: string; executable: boolean; size?: number }> = [];
  if (options.noOp) {
    const working = await prepareWorkingImage(raw, 256, "preserve-dimensions");
    await mkdir(path.join(f.workspacePath, "public")); await writeFile(path.join(f.workspacePath, image.path), working.bytes, { mode: 0o600 });
    await writeFile(path.join(f.workspacePath, source.path), Buffer.from(source.data, "base64"));
    baseline.push({ path: image.path, sha256: working.workingSha256, size: working.bytes.length, executable: false }, { path: source.path, sha256: source.sha256, executable: false });
  }
  f.execution.setAdmission(() => { if (held) throw new Error("A controlled inspection owns the project"); });
  const owned = async <T>(run: () => Promise<T>) => { held = true; try { return await run(); } finally { held = false; } };
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 4, state: "resident", dirty: true, active: false });
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, rasterReturnVersion: policy, retainedReviewVersion: 2, limits: resourceLimits }));
  const header = () => ({ reviewVersion: 2 as const, namespace: "test", projectId: f.project.id, generation: 4, snapshotId, rasterReturnVersion: policy,
    files: ackId ? [source, { path: image.path, size: image.size, sha256: image.sha256 }] : [source],
    baselineFiles: ackId ? [{ path: source.path, sha256: source.sha256, executable: false }, image] : baseline, retainedRasters: ackId ? [] : [image],
    originOperations: [...(options.origins === false ? [] : [{ operationId: "c".repeat(32), mode: "shell", phase: "released", snapshotId, acknowledged: false }]),
      ...(ackId ? [{ operationId: options.invalidRecoveryOrigin === "operation" ? "f".repeat(32) : ackId, mode: options.invalidRecoveryOrigin === "mode" ? "shell" : "recovery", phase: releasedId === ackId && options.invalidRecoveryOrigin !== "phase" ? "released" : "finished", snapshotId, acknowledged: true }] : [])] });
  f.handlers.set("recover", async (...args) => ({ ...await f.defaultResponse(...args) as object, rasterReturnVersion: policy }));
  f.handlers.set("capture", () => header());
  f.handlers.set("acknowledge", input => { expect(input.reviewVersion).toBe(2); ackId = input.operationId;
    f.projects.get(f.project.id).dirty = false;
    if (options.lostAck) throw new Error("Fixture acknowledgement response was lost");
    return { acknowledged: true };
  });
  f.handlers.set("release", input => { releasedId = input.operationId; return { released: true, dirty: !ackId }; });
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    let request = ""; child.stdin.on("data", bytes => { request += bytes.toString(); });
    child.stdin.once("finish", () => {
      const input = JSON.parse(request); f.requests.push({ operation: "review-source-media", input, args: args[1] });
      expect(input).toEqual({ namespace: "test", projectId: f.project.id, generation: 4, reviewVersion: 2 });
      (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(header()) + "\n"), ...(ackId ? [] : [raw])])); queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  });
  return { ...f, raw, image, source, snapshotId, owned, header };
}

async function approvedRetained(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const review = await f.owned(() => f.execution.reviewSource(f.project, "4", async operation => operation()));
  expect(review.blockers).toEqual([]);
  await f.owned(() => f.execution.approveSourceReview(f.project, review.reviewId, async operation => operation()));
  return review;
}

async function approvedNoOp(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const initial = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation()));
  const review = await f.owned(() => f.execution.optimizeSourceReview(f.project, initial.reviewId, { paths: [f.image.path], maxEdge: 256 }, operation => operation()));
  expect(review.blockers).toEqual([]);
  await f.owned(() => f.execution.approveSourceReview(f.project, review.reviewId, operation => operation()));
  return review;
}

async function testStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (cause) { throw new Error(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
}

async function captureMediaFixture(fault?: "truncated" | "hash" | "trailing" | "exit" | "hold", lostAck = false, originPhase = "released") {
  const f = await fixture();
  const raw = referencePng({ width: 512, height: 512, noise: true, level: 0 });
  const image = { path: "public/frame.png", size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), executable: false as const };
  const source = sourceFile("game.js", "export const frameSize = 512;\n");
  const snapshotId = reviewSnapshotDigest([source, image]);
  let originalId = "", ackId: string | undefined, releasedId: string | undefined;
  let prepareReservation: any;
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, rasterReturnVersion: 1, rasterInspectionVersion: 2, captureVersion: 2, retainedReviewVersion: 2, limits: resourceLimits }));
  f.handlers.set("prepare", async (...args) => {
    expect(args[0].rasterReturnVersion).toBe(2);
    const folder = path.join(path.dirname(f.workspacePath), "isolated-space-reservations");
    const entries = await readdir(folder); expect(entries).toHaveLength(1);
    prepareReservation = JSON.parse(await readFile(path.join(folder, entries[0]!), "utf8"));
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2, captureVersion: 2 };
    originalId = args[0].operationId; f.operations.set(originalId, binding);
    return binding;
  });
  f.handlers.set("recover", async (...args) => ({ ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2 }));
  const reviewHeader = () => ({ namespace: "test", projectId: f.project.id, generation: 1, reviewVersion: 2, rasterReturnVersion: 2, snapshotId,
    files: ackId ? [source, { path: image.path, size: image.size, sha256: image.sha256 }] : [source],
    baselineFiles: ackId ? [{ path: source.path, sha256: source.sha256, executable: false }, image] : [],
    retainedRasters: ackId ? [] : [image], originOperations: [
      { operationId: originalId, mode: "shell", phase: originPhase, snapshotId, acknowledged: false },
      ...(ackId ? [{ operationId: ackId, mode: "recovery", phase: releasedId === ackId ? "released" : "finished", snapshotId, acknowledged: true }] : []),
    ] });
  f.handlers.set("capture", input => { if (input.reviewVersion !== 2) throw new Error("Legacy capture must not receive the original operation"); return reviewHeader(); });
  f.handlers.set("acknowledge", input => { ackId = input.operationId; f.projects.get(f.project.id).dirty = false; if (lostAck) throw new Error("Fixture acknowledgement response was lost"); return { acknowledged: true }; });
  f.handlers.set("release", input => { releasedId = input.operationId; f.projects.get(f.project.id).dirty = !ackId; return { released: true, dirty: !ackId }; });
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const command = args[1][8];
    if (command !== "capture-media" && command !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    let request = ""; child.stdin.on("data", bytes => { request += bytes.toString(); });
    child.stdin.once("finish", () => {
      const input = JSON.parse(request); f.requests.push({ operation: command, input, args: args[1] });
      const afterAck = command === "review-source-media" && !!ackId;
      const files = afterAck ? [source, { path: image.path, size: image.size, sha256: image.sha256 }] : [source];
      const baselineFiles = afterAck ? [{ path: source.path, sha256: source.sha256, executable: false }, image] : [];
      const header = command === "capture-media"
        ? { namespace: "test", projectId: f.project.id, operationId: input.operationId, generation: 1, captureVersion: 2, rasterReturnVersion: 2, snapshotId, files, baselineFiles, returnedRasters: [image] }
        : reviewHeader();
      const payload = fault === "truncated" && command === "capture-media" ? raw.subarray(0, -1)
        : fault === "hash" && command === "capture-media" ? Buffer.concat([raw.subarray(0, -1), Buffer.from([raw[raw.length - 1]! ^ 1])])
          : raw;
      if (fault === "hold" && command === "capture-media") {
        (child.stdout as PassThrough).write(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), raw.subarray(0, 16)]));
        return;
      }
      (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), ...(afterAck ? [] : [payload]), ...(fault === "trailing" && command === "capture-media" ? [Buffer.from([0])] : [])]));
      queueMicrotask(() => child.emit("close", fault === "exit" && command === "capture-media" ? 1 : 0));
    });
    return child;
  });
  return { ...f, raw, image, source, snapshotId, originalId: () => originalId, prepareReservation: () => prepareReservation };
}

type ManifestFixtureFile = ReturnType<typeof sourceFile> | { path: string; size: number; sha256: string; executable?: boolean };
function fixtureSourceManifest(files: readonly ManifestFixtureFile[]): SourceManifestV1 {
  return createSourceManifest(files.map(file => ({
    path: file.path, kind: "data" in file ? "source" : "media",
    size: "data" in file ? Buffer.byteLength(file.data, "base64") : file.size,
    sha256: file.sha256, executable: file.executable === true,
  })));
}

async function manifestCaptureFixture(options: {
  image?: boolean;
  imageSize?: number;
  unchanged?: boolean;
  lostAck?: boolean;
  originPhase?: "released" | "finished" | "active";
  prepareBinding?: (binding: any) => void;
  header?: (header: any, operation: string) => void;
} = {}) {
  const f = await fixture();
  const before = sourceFile("counter.txt", "before"), after = options.unchanged ? before : sourceFile("counter.txt", "after");
  await writeFile(path.join(f.workspacePath, before.path), Buffer.from(before.data, "base64"));
  const raw = referencePng({ width: options.imageSize ?? 32, height: options.imageSize ?? 32, noise: true, level: 0 });
  const image = { path: "public/frame.png", size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), executable: false as const };
  const returned = options.image ? [after, image] : [after];
  const resultManifest = fixtureSourceManifest(returned), snapshotId = reviewSnapshotDigest(returned);
  let baseline: ManifestFixtureFile[] = [before], baseManifest = fixtureSourceManifest(baseline);
  let originalBase = baseManifest, originalId = "", ackId: string | undefined, releasedId: string | undefined, generation = 0;
  let recoveryBase: SourceManifestV1 | undefined;
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, buildMediaVersion: 1, rasterReturnVersion: 1,
    rasterInspectionVersion: 2, captureVersion: 2, manifestCaptureVersion: 3, sourceManifestVersion: 1, retainedReviewVersion: 2, limits: resourceLimits }));
  f.handlers.set("prepare", async (...args) => {
    const input = args[0];
    baseManifest = fixtureSourceManifest(input.files); originalBase = baseManifest; baseline = input.files;
    expect(input).toMatchObject({ rasterReturnVersion: 2, sourceManifestVersion: 1, sourceManifest: baseManifest });
    const binding = { ...await f.defaultResponse(...args) as object, generation: ++generation, sourceDigest: reviewSnapshotDigest(input.files), rasterReturnVersion: 2,
      captureVersion: 3, sourceManifestVersion: 1, sourceBaseManifestId: baseManifest.manifestId };
    originalId = input.operationId; ackId = releasedId = undefined;
    f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation, state: "resident", dirty: false, active: false,
      sourceManifestVersion: 1, sourceBaseManifestId: baseManifest.manifestId });
    options.prepareBinding?.(binding); f.operations.set(originalId, binding); return binding;
  });
  const metadata = () => ({ sourceManifestVersion: 1, sourceBaselineManifest: baseManifest, sourceManifest: resultManifest,
    sourceResultManifestId: resultManifest.manifestId, sourceDelta: planSourceDelta(baseManifest, resultManifest).summary });
  const versions = (files: readonly ManifestFixtureFile[]) => files.map(file => ({ path: file.path, sha256: file.sha256,
    executable: file.executable === true, ...("data" in file ? {} : { size: file.size }) }));
  const origins = () => [
    { operationId: originalId, mode: "shell", phase: options.originPhase ?? "released", snapshotId, acknowledged: ackId === originalId,
      sourceManifestVersion: 1, sourceBaseManifestId: originalBase.manifestId, sourceResultManifestId: resultManifest.manifestId },
    ...(ackId && ackId !== originalId ? [{ operationId: ackId, mode: "recovery", phase: releasedId === ackId ? "released" : "finished",
      snapshotId, acknowledged: true, sourceManifestVersion: 1, sourceBaseManifestId: recoveryBase!.manifestId,
      sourceResultManifestId: resultManifest.manifestId }] : []),
  ];
  const header = (operation: string, input?: any) => ({ namespace: "test", projectId: f.project.id, generation, snapshotId, rasterReturnVersion: 2,
    files: options.image && !ackId ? [after] : returned, baselineFiles: versions(baseline),
    ...(operation === "capture-media" ? { operationId: input.operationId, captureVersion: 3, returnedRasters: options.image ? [image] : [] }
      : { reviewVersion: 2, retainedRasters: options.image && !ackId ? [image] : [], originOperations: origins() }),
    ...metadata(),
  });
  f.handlers.set("recover", async (...args) => {
    const input = args[0];
    expect(input).toMatchObject({ sourceManifestVersion: 1, sourceBaseManifestId: baseManifest.manifestId });
    if (input.reviewVersion === 2) expect(input.sourceResultManifestId).toBe(resultManifest.manifestId);
    else expect(input).not.toHaveProperty("sourceResultManifestId");
    recoveryBase = baseManifest;
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2, captureVersion: 3,
      sourceManifestVersion: 1, sourceBaseManifestId: baseManifest.manifestId };
    f.operations.set(input.operationId, binding); return binding;
  });
  f.handlers.set("capture", input => {
    expect(input).toMatchObject({ reviewVersion: 2, captureVersion: 3, sourceManifestVersion: 1,
      sourceBaseManifestId: baseManifest.manifestId });
    const value = header("capture"); options.header?.(value, "capture"); return value;
  });
  f.handlers.set("acknowledge", input => {
    const expectedBase = input.operationId === originalId ? originalBase : recoveryBase!;
    expect(input).toMatchObject({ captureVersion: 3, sourceManifestVersion: 1, sourceBaseManifestId: expectedBase.manifestId,
      sourceResultManifestId: resultManifest.manifestId, snapshotId });
    if (input.operationId !== originalId && options.image) expect(input.reviewVersion).toBe(2);
    ackId = input.operationId; baseline = returned; baseManifest = resultManifest;
    Object.assign(f.projects.get(f.project.id), { dirty: false, sourceBaseManifestId: resultManifest.manifestId });
    if (options.lostAck) throw new Error("Manifest fixture ACK response lost");
    return { acknowledged: true };
  });
  f.handlers.set("release", input => {
    releasedId = input.operationId; f.projects.get(f.project.id).dirty = !ackId;
    return { released: true, dirty: !ackId };
  });
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const operation = args[1][8];
    if (operation !== "capture-media" && operation !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    let request = ""; child.stdin.on("data", bytes => { request += bytes.toString(); });
    child.stdin.once("finish", () => {
      try {
        const input = JSON.parse(request); f.requests.push({ operation, input, args: args[1] });
        expect(input).toMatchObject({ namespace: "test", projectId: f.project.id, generation, sourceManifestVersion: 1,
          sourceBaseManifestId: baseManifest.manifestId, ...(operation === "capture-media" ? { captureVersion: 3 } : { reviewVersion: 2 }) });
        const value = header(operation, input); options.header?.(value, operation);
        (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(value) + "\n"), ...(options.image && !ackId ? [raw] : [])]));
        queueMicrotask(() => child.emit("close", 0));
      } catch (cause) {
        (child.stdout as PassThrough).end(JSON.stringify({ error: { code: "MOCK_FAILURE", message: (cause as Error).message } }));
        queueMicrotask(() => child.emit("close", 1));
      }
    });
    return child;
  });
  const run = async () => {
    const expectedRuns = f.runs.size + 1;
    const running = f.execution.shell(f.project, "fixture-only", 5, operation => operation()), outcome = running.catch(cause => cause);
    await Promise.race([
      vi.waitFor(() => expect(f.runs.size).toBe(expectedRuns)).then(() => f.completeRun(originalId)),
      outcome.then(value => { if (f.runs.size < expectedRuns) throw new Error("Manifest fixture admission failed: " + (value instanceof Error ? value.message : JSON.stringify(value))); }),
    ]);
    return outcome;
  };
  return { ...f, before, after, raw, image, snapshotId, resultManifest, run, originalId: () => originalId, baseManifest: () => baseManifest };
}

function fixtureProfileManifest(files: readonly ManifestFixtureFile[], profileId: RuntimeCapacityProfileId = "capacity-128-v2"): SourceManifestV2 {
  return createSourceManifestV2(profileId, files.map(file => ({ path: file.path, kind: "data" in file ? "source" : "media",
    size: "data" in file ? Buffer.byteLength(file.data, "base64") : file.size, sha256: file.sha256, executable: file.executable === true })));
}

function profileWave(size: number) {
  const data = Buffer.alloc(size); data.write("RIFF"); data.writeUInt32LE(size - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(8000, 28);
  data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34); data.write("data", 36); data.writeUInt32LE(size - 44, 40); return data;
}

async function profileCaptureFixture(options: {
  vm?: unknown;
  profileId?: RuntimeCapacityProfileId;
  replaceMedia?: boolean;
  large?: boolean;
  mediaSizes?: readonly number[];
  copiedAfterMiB?: 64 | 65;
  image?: boolean;
  lostAck?: boolean;
  begin?: (value: any) => void;
  append?: "receipt" | "unknown" | "request-paths";
  commit?: "lost" | "profile";
  header?: (value: any, operation: string) => void;
  afterAppend?: () => void;
} = {}) {
  const f = await fixture("test", options.vm), profile = getRuntimeCapacityProfile(options.profileId ?? "capacity-128-v2");
  const profileManifest = (files: readonly ManifestFixtureFile[]) => fixtureProfileManifest(files, profile.id);
  vi.spyOn(f.execution as IsolatedProjectExecution & { capacityBackingDevice: (project: ProjectState) => Promise<number> }, "capacityBackingDevice")
    .mockImplementation(async () => (await stat(f.workspacePath)).dev);
  const before = sourceFile("counter.txt", "before"), after = sourceFile("counter.txt", "after");
  await writeFile(path.join(f.workspacePath, before.path), Buffer.from(before.data, "base64")); await mkdir(path.join(f.workspacePath, "public"));
  const sizes = options.mediaSizes ?? (options.large ? [32 * 1024 ** 2, 32 * 1024 ** 2, 1024 ** 2] : [256, 256]);
  const media: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [index, size] of sizes.entries()) {
    const relative = `public/seed-${index}.wav`, target = path.join(f.workspacePath, relative);
    if (size > 32 * 1024 ** 2) { const header = profileWave(44); header[42] = index; await writeFile(target, header); await truncate(target, size); }
    else await writeFile(target, profileWave(size));
    const checked = await inspectSafeProjectMedia(f.workspacePath, target, 64 * 1024 ** 2);
    media.push({ path: relative, size, sha256: checked.sha256 });
  }
  const raw = referencePng({ width: 32, height: 32, noise: true, level: 0 });
  const image = { path: "public/frame.png", size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), executable: false as const };
  const copies = options.copiedAfterMiB ? [{ ...media[0]!, path: "public/new-a.wav" }, { ...media[0]!, path: "public/new-b.wav" }, ...(options.copiedAfterMiB === 65 ? [{ ...media[1]!, path: "public/new-c.wav" }] : [])] : [];
  const returnedMedia = media.map((entry, index) => options.replaceMedia && index === 0 ? { ...media[1]!, path: entry.path } : entry);
  const returned = [after, ...returnedMedia, ...copies, ...(options.image ? [image] : [])], resultManifest = profileManifest(returned), snapshotId = reviewSnapshotDigest(returned);
  let baseline: ManifestFixtureFile[] = [], baseManifest = profileManifest([]), operationBase = baseManifest, originalId = "", generation = 1;
  let ackId: string | undefined, releasedId: string | undefined, recoveryBase: SourceManifestV2 | undefined;
  let windows: Array<{ windowIndex: number; windowId: string; paths: string[]; bytes: number }> = [], uploaded = new Set<number>();
  const receivedMedia: Array<{ windowIndex: number; path: string; size: number; sha256: string }> = [];
  const inventory = () => ({ namespace: "test", projectId: f.project.id, generation, state: "resident", dirty: false, active: false,
    sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: baseManifest.manifestId });
  f.projects.set(f.project.id, inventory());
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, buildMediaVersion: 1, rasterReturnVersion: 1,
    rasterInspectionVersion: 2, captureVersion: 2, manifestCaptureVersion: 3, sourceManifestVersion: 1, retainedReviewVersion: 2,
    capacityProfileVersion: profile.id === "capacity-128-media64-v3" ? 3 : 2, profileManifestVersion: 2, profileCaptureVersion: 4, profileUploadVersion: 1, volumeMigrationVersion: 1,
    capacityProfiles: profile.id === "capacity-128-media64-v3" ? RUNTIME_CAPACITY_PROFILES : [profile], limits: resourceLimits }));
  f.handlers.set("prepare-begin", input => {
    expect(input).toMatchObject({ sourceManifestVersion: 2, sourceProfileId: profile.id, rasterReturnVersion: 2 });
    const seed = profileManifest(input.files); expect(input.sourceManifest).toEqual(seed);
    const previous = new Map(baseline.map(file => [file.path, file]));
    const needed = input.files.filter((file: ManifestFixtureFile) => !("data" in file) && JSON.stringify(previous.get(file.path)) !== JSON.stringify(file));
    windows = []; let group: string[] = [], bytes = 0;
    const flush = () => { if (group.length) windows.push({ windowIndex: windows.length, windowId: String(windows.length + 1).padStart(32, "0"), paths: group, bytes }); group = []; bytes = 0; };
    for (const file of needed) { if (bytes + file.size > 64 * 1024 ** 2) flush(); group.push(file.path); bytes += file.size; } flush();
    operationBase = seed; originalId = input.operationId; generation++; uploaded = new Set(); ackId = releasedId = undefined;
    const binding = { namespace: "test", projectId: f.project.id, operationId: originalId, generation, leaseToken: "e".repeat(32), rasterReturnVersion: 2,
      captureVersion: 4, sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: seed.manifestId };
    f.operations.set(originalId, { ...binding, seedFiles: input.files });
    const value = { ...binding, prepared: false, protocolVersion: 2, uploadVersion: 1, windowCount: windows.length, windows: structuredClone(windows) };
    options.begin?.(value); return value;
  });
  f.handlers.set("prepare-commit", input => {
    expect(input).toEqual({ ...binding(), uploadVersion: 1 });
    if (uploaded.size !== windows.length) throw new Error("Fixture full seed still has an unreceived original window");
    const operation = f.operations.get(originalId); baseline = operation.seedFiles; baseManifest = operationBase; Object.assign(f.projects.get(f.project.id), inventory());
    if (options.commit === "lost") throw new Error("Fixture complete seed commit acknowledgement unknown");
    return { ...binding(), prepared: true, protocolVersion: 2, sourceDigest: reviewSnapshotDigest(baseline),
      ...(options.commit === "profile" ? { sourceProfileId: "capacity-128-v1" } : {}) };
  });
  const binding = (operationId = originalId) => {
    const value = f.operations.get(operationId); return { namespace: "test", projectId: f.project.id, operationId, generation,
      leaseToken: "e".repeat(32), rasterReturnVersion: 2, captureVersion: 4, sourceManifestVersion: 2, sourceProfileId: profile.id,
      sourceBaseManifestId: value?.sourceBaseManifestId ?? baseManifest.manifestId };
  };
  const versions = () => baseline.map(file => ({ path: file.path, sha256: file.sha256, executable: file.executable === true, ...("data" in file ? {} : { size: file.size }) }));
  const origins = () => [{ operationId: originalId, mode: "shell", phase: "released", snapshotId, acknowledged: ackId === originalId,
    sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: operationBase.manifestId, sourceResultManifestId: resultManifest.manifestId },
    ...(ackId && ackId !== originalId ? [{ operationId: ackId, mode: "recovery", phase: releasedId === ackId ? "released" : "finished", snapshotId, acknowledged: true,
      sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: recoveryBase!.manifestId, sourceResultManifestId: resultManifest.manifestId }] : [])];
  const header = (operation: string, input?: any) => ({ namespace: "test", projectId: f.project.id, generation, rasterReturnVersion: 2, snapshotId,
    files: [after, ...returnedMedia, ...copies, ...(options.image && ackId ? [image] : [])], baselineFiles: versions(),
    ...(operation === "capture-media" ? { operationId: input.operationId, captureVersion: 4, returnedRasters: options.image ? [image] : [] }
      : { reviewVersion: 2, retainedRasters: options.image && !ackId ? [image] : [], originOperations: origins() }),
    sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaselineManifest: baseManifest, sourceManifest: resultManifest,
    sourceResultManifestId: resultManifest.manifestId, sourceDelta: planSourceDelta(baseManifest, resultManifest).summary });
  f.handlers.set("recover", input => {
    expect(input).toMatchObject({ sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: baseManifest.manifestId });
    if (input.reviewVersion === 2) expect(input.sourceResultManifestId).toBe(resultManifest.manifestId);
    recoveryBase = baseManifest; f.operations.set(input.operationId, input); return { ...binding(input.operationId), ...(input.reviewVersion ? { reviewVersion: 2, reviewSnapshotId: snapshotId } : {}) };
  });
  f.handlers.set("capture", input => { expect(input).toMatchObject({ captureVersion: 4, sourceManifestVersion: 2, sourceProfileId: profile.id, reviewVersion: 2 }); const value = header("capture"); options.header?.(value, "capture"); return value; });
  f.handlers.set("acknowledge", input => {
    expect(input).toMatchObject({ captureVersion: 4, sourceManifestVersion: 2, sourceProfileId: profile.id,
      sourceBaseManifestId: input.operationId === originalId ? operationBase.manifestId : recoveryBase!.manifestId,
      sourceResultManifestId: resultManifest.manifestId, snapshotId });
    ackId = input.operationId; baseline = returned; baseManifest = resultManifest; Object.assign(f.projects.get(f.project.id), inventory());
    if (options.lostAck) throw new Error("Fixture cap4 ACK response lost"); return { acknowledged: true };
  });
  f.handlers.set("release", input => { releasedId = input.operationId; f.projects.get(f.project.id).dirty = !ackId; return { released: true, dirty: !ackId }; });
  const previous = spawn.getMockImplementation()!;
  let completeOnInput = false;
  spawn.mockImplementation((...args) => {
    const operation = args[1][8];
    if (operation === "run" && completeOnInput) {
      const child = previous(...args);
      child.stdin!.once("data", () => setImmediate(() => f.completeRun(args[1][9])));
      return child;
    }
    if (!["prepare-append", "capture-media", "review-source-media"].includes(operation)) return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    if (operation === "prepare-append") {
      let first = Buffer.alloc(0), input: any, offset = 0, fileIndex = 0, digest = createHash("sha256"), failure: Error | undefined, terminal = false;
      child.stdin.on("data", (chunk: Buffer) => {
        if (terminal) return;
        try {
          if (!input) {
            first = Buffer.concat([first, chunk]); const boundary = first.indexOf(10); if (boundary < 0) return;
            input = JSON.parse(first.subarray(0, boundary).toString()); f.requests.push({ operation, input, args: args[1] });
            const window = windows[input.windowIndex]!;
            expect(input).toEqual({ ...binding(), uploadVersion: 1, windowIndex: window.windowIndex, windowId: window.windowId });
            (child.stdout as PassThrough).write(JSON.stringify({ needMedia: options.append === "request-paths" ? [...window.paths].reverse() : window.paths }) + "\n");
            if (options.append === "request-paths") {
              terminal = true;
              (child.stdout as PassThrough).end(JSON.stringify({ error: { code: "INVALID_BINDING", message: "Fixture returned a different requested path order", changed: true } }));
              queueMicrotask(() => child.emit("close", 1)); return;
            }
            chunk = first.subarray(boundary + 1); first = Buffer.alloc(0);
          }
          const window = windows[input.windowIndex]!;
          while (chunk.length) {
            const file = media.find(value => value.path === window.paths[fileIndex]); if (!file) throw new Error("Unexpected upload bytes");
            const length = Math.min(chunk.length, file.size - offset); digest.update(chunk.subarray(0, length)); offset += length; chunk = chunk.subarray(length);
            if (offset === file.size) { const sha256 = digest.digest("hex"); expect(sha256).toBe(file.sha256); receivedMedia.push({ windowIndex: input.windowIndex, path: file.path, size: offset, sha256 }); fileIndex++; offset = 0; digest = createHash("sha256"); }
          }
        } catch (cause) { failure = cause as Error; terminal = true; (child.stdout as PassThrough).end(JSON.stringify({ error: { code: "INVALID_BINDING", message: failure.message, changed: true } })); queueMicrotask(() => child.emit("close", 1)); }
      });
      child.stdin.once("finish", () => {
        if (terminal) return;
        const window = windows[input?.windowIndex];
        if (!failure && (!window || offset || fileIndex !== window.paths.length)) failure = new Error("Original upload window was truncated");
        if (options.append === "unknown") failure = new Error("Fixture upload outcome unknown");
        if (failure) (child.stdout as PassThrough).end(JSON.stringify({ error: { code: "GUEST_IO_UNKNOWN", message: failure.message, changed: true } }));
        else { uploaded.add(input.windowIndex); options.afterAppend?.(); (child.stdout as PassThrough).end(JSON.stringify({ appended: true, windowIndex: input.windowIndex, windowId: options.append === "receipt" ? "f".repeat(32) : input.windowId })); }
        queueMicrotask(() => child.emit("close", failure ? 1 : 0));
      });
    } else {
      let request = ""; child.stdin.on("data", chunk => { request += chunk.toString(); });
      child.stdin.once("finish", () => {
        const input = JSON.parse(request); f.requests.push({ operation, input, args: args[1] });
        expect(input).toEqual({ namespace: "test", projectId: f.project.id, generation,
          ...(operation === "capture-media" ? { operationId: originalId, leaseToken: "e".repeat(32), captureVersion: 4 } : { reviewVersion: 2 }),
          sourceManifestVersion: 2, sourceProfileId: profile.id, sourceBaseManifestId: baseManifest.manifestId });
        const value = header(operation, input); options.header?.(value, operation);
        (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(value) + "\n"), ...(options.image && !ackId ? [raw] : [])]));
        queueMicrotask(() => child.emit("close", 0));
      });
    }
    return child;
  });
  const run = async (signal?: AbortSignal) => {
    completeOnInput = true;
    try { return await f.execution.shell(f.project, "fixture-only", 5, operation => operation(), signal).catch(cause => cause); }
    finally { completeOnInput = false; }
  };
  return { ...f, profile, before, after, media, raw, image, resultManifest, snapshotId, receivedMedia, run, originalId: () => originalId };
}

it("source manifest v2 uploads a complete 65 MiB same-SHA multi-path seed in bounded windows and returns only the changed source", async () => {
  const f = await profileCaptureFixture({ large: true }), receipts: IsolatedOperationReceipt[] = [];
  let intent: any;
  const outcome = await withIsolatedOperationScope(async history => {
    receipts.splice(0, receipts.length, ...history);
    if (history.at(-1)?.phase === "prepared") {
      const folder = path.join(path.dirname(f.workspacePath), "isolated-space-reservations"), [name] = await readdir(folder);
      intent = JSON.parse(await readFile(path.join(folder, name!), "utf8"));
    }
  }, () => f.run());
  expect(outcome).not.toBeInstanceOf(Error);
  expect(f.media[0]!.sha256).toBe(f.media[1]!.sha256); expect(f.receivedMedia).toEqual(f.media.map((entry, index) => ({ ...entry, windowIndex: index < 2 ? 0 : 1 })));
  const begin = f.requests.find(request => request.operation === "prepare-begin")!;
  expect(begin.input.sourceManifest).toMatchObject({ version: 2, profile: "capacity-128-v2", limits: f.profile });
  expect(begin.input.sourceManifest.files.filter((file: any) => file.kind === "media").reduce((sum: number, file: any) => sum + file.size, 0)).toBe(65 * 1024 ** 2);
  expect(f.requests.filter(request => request.operation === "prepare-append")).toHaveLength(2);
  expect(f.requests.filter(request => request.operation === "prepare-commit")).toHaveLength(1);
  expect(f.requests.some(request => ["prepare", "prepare-media"].includes(request.operation))).toBe(false);
  expect(intent).toMatchObject({ version: 3, owner: { sourceManifestVersion: 2, sourceProfileId: "capacity-128-v2", ownerKey: f.originalId() }, plan: { profileId: "capacity-128-v2", limitBytes: 1024 ** 3 } });
  expect(receipts.map(receipt => receipt.phase)).toContain("acknowledged");
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("after");
  for (const file of f.media) expect((await stat(path.join(f.workspacePath, file.path))).size).toBe(file.size);
  const journals = path.join(path.dirname(f.workspacePath), "isolated-changes"), [id] = await readdir(journals);
  const publication = JSON.parse(await readFile(path.join(journals, id!, "manifest.json"), "utf8"));
  expect(publication).toMatchObject({ version: 5, state: "committed", context: { sourceContract: { version: 2, profileId: "capacity-128-v2" } } });
  expect(publication.publicationDelta).toMatchObject({ modifiedFiles: 1, unchangedFiles: 3, beforeMediaBytes: 0, afterMediaBytes: 0 });
}, 30000);

it.each(["missing-window", "wrong-order", "duplicate-path", "wrong-bytes", "wrong-base", "wrong-budget"])("source manifest v2 refuses an incomplete or inconsistent upload plan without running: %s", async fault => {
  const f = await profileCaptureFixture({ begin: value => {
    if (fault === "missing-window") { value.windows = []; value.windowCount = 0; }
    if (fault === "wrong-order") value.windows[0].windowIndex = 1;
    if (fault === "duplicate-path") value.windows[0].paths[1] = value.windows[0].paths[0];
    if (fault === "wrong-bytes") value.windows[0].bytes++;
    if (fault === "wrong-base") value.sourceBaseManifestId = "f".repeat(64);
    if (fault === "wrong-budget") value.sourceProfileId = "capacity-128-v1";
  } });
  const outcome = await f.run(); expect(outcome).toBeInstanceOf(Error); expect(f.runs.size).toBe(0);
  expect(f.requests.filter(request => request.operation === "prepare-begin")).toHaveLength(1);
  expect(f.requests.some(request => ["capture-media", "acknowledge", "prepare", "prepare-media"].includes(request.operation))).toBe(false);
  if (fault === "missing-window") expect((outcome as Error).message).toContain("unreceived original window");
  else expect(f.requests.some(request => request.operation === "prepare-commit")).toBe(false);
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("before");
});

it.each(["receipt", "unknown", "request-paths"] as const)("source manifest v2 stops after an unconfirmed original upload window: %s", async append => {
  const f = await profileCaptureFixture({ append });
  const receipts: IsolatedOperationReceipt[] = [];
  expect(await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.run())).toBeInstanceOf(Error); expect(f.runs.size).toBe(0);
  expect(isolatedCommandsNotSubmitted(receipts)).toBe(false);
  expect(f.requests.filter(request => request.operation === "prepare-append")).toHaveLength(1);
  expect(f.requests.some(request => ["prepare-commit", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
  expect(f.requests.filter(request => request.operation === "prepare-begin")).toHaveLength(1);
  expect(f.receivedMedia).toHaveLength(append === "request-paths" ? 0 : 2);
});

it.each(["lost", "profile"] as const)("source manifest v2 never starts run after an unknown or mismatched complete commit: %s", async commit => {
  const f = await profileCaptureFixture({ commit });
  const receipts: IsolatedOperationReceipt[] = [];
  expect(await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.run())).toBeInstanceOf(Error); expect(f.runs.size).toBe(0);
  expect(isolatedCommandsNotSubmitted(receipts)).toBe(false);
  expect(f.receivedMedia).toHaveLength(2);
  expect(f.requests.filter(request => request.operation === "prepare-commit")).toHaveLength(1);
  expect(f.requests.some(request => ["capture-media", "acknowledge", "prepare", "prepare-media"].includes(request.operation))).toBe(false);
});

it("source manifest v2 cancels after an upload receipt without committing or running another operation", async () => {
  const controller = new AbortController(), f = await profileCaptureFixture({ afterAppend: () => controller.abort() });
  expect(await f.run(controller.signal)).toBeInstanceOf(Error); expect(f.runs.size).toBe(0);
  expect(f.requests.filter(request => request.operation === "prepare-append")).toHaveLength(1);
  expect(f.requests.some(request => ["prepare-commit", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
});

it.each(["profile", "missing-profile", "limits", "delta", "result", "legacy-version"])("source manifest v2 rejects profile, full-budget or delta drift before publishing: %s", async fault => {
  const f = await profileCaptureFixture({ header: (header, operation) => {
    if (operation !== "capture-media") return;
    if (fault === "profile") header.sourceProfileId = "capacity-128-v1";
    if (fault === "missing-profile") delete header.sourceProfileId;
    if (fault === "limits") header.sourceManifest = { ...header.sourceManifest, limits: { ...header.sourceManifest.limits, recoveryBytes: 512 * 1024 ** 2 } };
    if (fault === "delta") header.sourceDelta = { ...header.sourceDelta, beforeMediaBytes: 1 };
    if (fault === "result") header.sourceResultManifestId = "f".repeat(64);
    if (fault === "legacy-version") { header.sourceManifestVersion = 1; header.captureVersion = 3; }
  } });
  const receipts: IsolatedOperationReceipt[] = [];
  expect(await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.run())).toBeInstanceOf(Error);
  expect(receipts.some(receipt => receipt.phase === "captured")).toBe(false);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false); expect(f.runs.size).toBe(1);
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("before");
});

it("source manifest v2 retains candidates, persists the reviewed profile and verifies an exact lost ACK without rerunning", async () => {
  const f = await profileCaptureFixture({ image: true, lostAck: true });
  expect(await f.run()).toBeInstanceOf(Error);
  const review = await f.execution.reviewSource(f.project, "2", operation => operation()); expect(review.blockers).toEqual([]);
  const stored = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId);
  expect(stored.retained?.sourceContract).toMatchObject({ version: 2, profileId: "capacity-128-v2", rawManifestId: f.resultManifest.manifestId });
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const failed = await f.execution.recoverSource(f.project, operation => operation(), "2", review.reviewId).catch(cause => cause);
  expect(getIsolatedRepairPending(failed)).toMatchObject({ reviewId: review.reviewId, rawSnapshotId: f.snapshotId });
  expect(await readFile(path.join(f.workspacePath, f.image.path))).toEqual(f.raw);
  const start = f.requests.length; await expect(f.execution.verifySourceReview(f.project, review.reviewId)).resolves.toMatchObject({ changed: [] });
  expect(f.requests.slice(start).some(request => ["prepare-begin", "prepare-append", "prepare-commit", "recover", "capture", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
  expect(f.runs.size).toBe(1);
});

it.each([64, 65])("source manifest v2 counts each copied path against its actual changed-after preservation window: %s MiB", async changedMiB => {
  const f = await profileCaptureFixture({ mediaSizes: [32 * 1024 ** 2, 1024 ** 2], copiedAfterMiB: changedMiB as 64 | 65, header: (header, operation) => {
    if (operation !== "capture-media") return;
    expect(header.sourceDelta.afterMediaBytes).toBe(changedMiB * 1024 ** 2);
    expect(header.sourceManifest.files.filter((file: any) => file.kind === "media").reduce((sum: number, file: any) => sum + file.size, 0)).toBe((33 + changedMiB) * 1024 ** 2);
  } });
  if (changedMiB === 64) {
    expect(await f.run()).not.toBeInstanceOf(Error);
    for (const name of ["public/new-a.wav", "public/new-b.wav"]) expect((await stat(path.join(f.workspacePath, name))).size).toBe(32 * 1024 ** 2);
    const folder = path.join(path.dirname(f.workspacePath), "isolated-changes"), [id] = await readdir(folder);
    const publication = JSON.parse(await readFile(path.join(folder, id!, "manifest.json"), "utf8"));
    expect(publication.publicationDelta.afterMediaBytes).toBe(64 * 1024 ** 2);
    expect(publication.versions.filter((file: any) => file.path.endsWith(".wav")).reduce((sum: number, file: any) => sum + file.afterSize, 0)).toBe(64 * 1024 ** 2);
  } else {
    const outcome = await f.run(); expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("Changed media exceeds the single-operation preservation contract");
    expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
    await expect(stat(path.join(f.workspacePath, "public/new-a.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(f.runs.size).toBe(1); expect(f.requests.filter(request => request.operation === "prepare-begin")).toHaveLength(1);
}, 30000);

it("source manifest v2 availability does not upgrade an unallocated or legacy current-64 operation", async () => {
  const f = await manifestCaptureFixture(), original = f.handlers.get("health")!;
  f.handlers.set("health", async (...args) => ({ ...await original(...args) as object, capacityProfileVersion: 2, profileManifestVersion: 2,
    profileCaptureVersion: 4, profileUploadVersion: 1, volumeMigrationVersion: 1, capacityProfiles: [getRuntimeCapacityProfile("capacity-128-v2")] }));
  expect(await f.run()).not.toBeInstanceOf(Error); expect(await f.run()).not.toBeInstanceOf(Error);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(2);
  for (const request of f.requests.filter(request => request.operation === "prepare")) {
    expect(request.input).toMatchObject({ sourceManifestVersion: 1, sourceManifest: { version: 1, profile: "current-64" } });
    expect(request.input).not.toHaveProperty("sourceProfileId");
  }
  expect(f.requests.some(request => ["prepare-begin", "prepare-append", "prepare-commit"].includes(request.operation))).toBe(false);
});

it.each(["sourceProfileId", "sourceContract", "baseline-size"])("source manifest v2 rejects a changed persisted approved profile receipt: %s", async fault => {
  const f = await profileCaptureFixture({ image: true }); expect(await f.run()).toBeInstanceOf(Error);
  const review = await f.execution.reviewSource(f.project, "2", operation => operation());
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const file = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json"), record = JSON.parse(await readFile(file, "utf8"));
  if (fault === "sourceProfileId") record.retained.sourceContract.profileId = "capacity-128-v1";
  if (fault === "sourceContract") { record.retained.sourceContract.version = 1; delete record.retained.sourceContract.profileId; }
  if (fault === "baseline-size") record.retained.sourceBaselineSizes[0]++;
  await writeFile(file, JSON.stringify(record));
  await expect(f.execution.recoverSource(f.project, operation => operation(), "2", review.reviewId)).rejects.toThrow();
  expect(f.requests.some(request => ["recover", "acknowledge"].includes(request.operation))).toBe(false);
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("before");
});

it.each(["copies-128", "copies-64-generated-64"] as const)("source manifest v2 build exports enforce separate copied, generated and combined media budgets: %s", async kind => {
  const f = await profileCaptureFixture({ large: true }); expect(await f.run()).not.toBeInstanceOf(Error);
  const physical = vi.spyOn(recoverySpace, "reserveVolumeMigrationSpace");
  try {
  const copied = f.media[0]!, bytes = profileWave(32 * 1024 ** 2); bytes[bytes.length - 1] = 0x7f;
  const generatedHash = createHash("sha256").update(bytes).digest("hex");
  const entry = (name: string, size: number, sha256: string) => ({ path: "dist/" + name + ".wav", size, sha256 });
  let manifest = { files: [] as ReturnType<typeof sourceFile>[], media: Array.from({ length: kind === "copies-128" ? 4 : 2 }, (_, index) => entry("copy-" + index, copied.size, copied.sha256)),
    generatedMedia: kind === "copies-128" ? [] : [entry("new-a", bytes.length, generatedHash), entry("new-b", bytes.length, generatedHash)] };
  let sendPayload = true;
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "export-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    let request = ""; child.stdin.on("data", chunk => { request += chunk.toString(); });
    child.stdin.once("finish", () => {
      const input = JSON.parse(request); f.requests.push({ operation: "export-media", input, args: args[1] });
      expect(input).toMatchObject({ captureVersion: 4, sourceManifestVersion: 2, sourceProfileId: "capacity-128-v2" });
      expect(physical.mock.calls.at(-1)?.slice(0, 3)).toEqual([f.workspacePath, expect.objectContaining({ backingDevice: expect.any(Number), physicalBytes: expect.any(Number) }),
        expect.objectContaining({ purpose: "runtime", profileId: "capacity-128-v2", projectId: f.project.id })]);
      (child.stdout as PassThrough).write(JSON.stringify(manifest) + "\n");
      if (sendPayload) for (const _entry of manifest.generatedMedia) (child.stdout as PassThrough).write(bytes);
      (child.stdout as PassThrough).end(); queueMicrotask(() => child.emit("close", 0));
    }); return child;
  });
  await f.execution.artifacts(f.project);
  for (const file of [...manifest.media, ...manifest.generatedMedia]) expect((await stat(path.join(f.workspacePath, file.path))).size).toBe(file.size);
  const keep = path.join(f.workspacePath, "dist/keep.txt"); await writeFile(keep, "accepted build remains");
  sendPayload = false;
  if (kind === "copies-128") {
    manifest = { ...manifest, generatedMedia: [entry("over-combined", 1, "d".repeat(64))] };
    await expect(f.execution.artifacts(f.project)).rejects.toThrow("complete-set limit");
  } else {
    manifest = { files: [], media: [], generatedMedia: [entry("over-new-a", bytes.length, generatedHash), entry("over-new-b", bytes.length, generatedHash), entry("over-new-c", 1, "d".repeat(64))] };
    await expect(f.execution.artifacts(f.project)).rejects.toThrow("64 MiB transfer limit");
  }
  expect(await readFile(keep, "utf8")).toBe("accepted build remains");
  expect(f.runs.size).toBe(1); expect(f.requests.filter(request => request.operation === "prepare-begin")).toHaveLength(1);
  } finally { physical.mockRestore(); }
}, 30000);

it("source manifest v1 negotiates capture3 and sends the complete actual seed on every fresh prepare", async () => {
  const f = await manifestCaptureFixture();
  const first = await f.run(); expect(first).not.toBeInstanceOf(Error);
  expect(await readFile(path.join(f.workspacePath, f.after.path), "utf8")).toBe("after");
  const initial = f.requests.find(request => request.operation === "prepare")!;
  expect(initial.input.sourceManifest).toEqual(fixtureSourceManifest([f.before]));
  const captured = f.requests.find(request => request.operation === "capture-media")!;
  expect(captured.input).toMatchObject({ captureVersion: 3, sourceManifestVersion: 1,
    sourceBaseManifestId: initial.input.sourceManifest.manifestId });
  expect(await f.run()).not.toBeInstanceOf(Error);
  const prepares = f.requests.filter(request => request.operation === "prepare"); expect(prepares).toHaveLength(2);
  expect(prepares[1]!.input.sourceManifest).toEqual(f.resultManifest);
  expect(f.requests.filter(request => request.operation === "acknowledge")).toHaveLength(2);
  expect(f.requests.some(request => request.operation === "capture")).toBe(false);
});

it.each([true, false])("settles a successful command after a concurrent host edit only for a verified unchanged guest capture (unchanged: %s)", async unchanged => {
  const f = await manifestCaptureFixture({ unchanged });
  const receipts: IsolatedOperationReceipt[] = [];
  const running = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
    () => f.execution.shell(f.project, "fixture-only", 5, operation => operation())).catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  await writeFile(path.join(f.workspacePath, f.before.path), "newer host version");
  f.completeRun(f.originalId());
  if (unchanged) {
    expect(await running).toMatchObject({ changed: [] });
    expect(receipts.map(r => r.phase).slice(-4)).toEqual(["captured", "published", "acknowledged", "released"]);
    expect(f.requests.find(r => r.operation === "acknowledge")?.input).toMatchObject({
      operationId: f.originalId(), snapshotId: f.snapshotId, sourceResultManifestId: f.resultManifest.manifestId,
    });
  } else {
    expect((await running).message).toContain("Source conflict");
    expect(receipts.map(r => r.phase).slice(-3)).toEqual(["captured", "retained", "released"]);
    expect(f.requests.some(r => r.operation === "acknowledge")).toBe(false);
  }
  expect(await readFile(path.join(f.workspacePath, f.before.path), "utf8")).toBe("newer host version");
});

it.each(["sourceManifestVersion", "sourceBaseManifestId", "captureVersion", "wrong-base"])("source manifest v1 rejects an incompatible prepare binding before run: %s", async fault => {
  const f = await manifestCaptureFixture({ prepareBinding: binding => {
    if (fault === "wrong-base") binding.sourceBaseManifestId = "f".repeat(64);
    else if (fault === "captureVersion") binding.captureVersion = 2;
    else delete binding[fault];
  } });
  await expect(f.execution.shell(f.project, "fixture-only", 5, operation => operation())).rejects.toThrow();
  expect(f.runs.size).toBe(0);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1);
  expect(f.requests.some(request => ["capture-media", "capture", "acknowledge"].includes(request.operation))).toBe(false);
  expect(await readFile(path.join(f.workspacePath, f.before.path), "utf8")).toBe("before");
});

type ManifestHeaderFault = "sourceManifestVersion" | "sourceBaselineManifest" | "sourceManifest" | "sourceResultManifestId" | "sourceDelta" |
  "wrong-version" | "wrong-base" | "wrong-result" | "wrong-delta" | "source-size" | "raster-kind" | "capture2";
function corruptManifestHeader(header: any, fault: ManifestHeaderFault) {
  if (["sourceManifestVersion", "sourceBaselineManifest", "sourceManifest", "sourceResultManifestId", "sourceDelta"].includes(fault)) delete header[fault];
  else if (fault === "wrong-version") header.sourceManifestVersion = 2;
  else if (fault === "wrong-base") {
    header.sourceBaselineManifest = createSourceManifest([]);
    header.sourceDelta = planSourceDelta(header.sourceBaselineManifest, header.sourceManifest).summary;
  } else if (fault === "wrong-result") header.sourceResultManifestId = "f".repeat(64);
  else if (fault === "wrong-delta") header.sourceDelta = { ...header.sourceDelta, afterBytes: header.sourceDelta.afterBytes + 1 };
  else if (fault === "capture2") header.captureVersion = 2;
  else {
    const files = header.sourceManifest.files.map((file: any) => fault === "source-size" && file.kind === "source"
      ? { ...file, size: file.size + 1 } : fault === "raster-kind" && file.kind === "media" ? { ...file, kind: "source" } : file);
    header.sourceManifest = createSourceManifest(files);
    header.sourceResultManifestId = header.sourceManifest.manifestId;
    header.sourceDelta = planSourceDelta(header.sourceBaselineManifest, header.sourceManifest).summary;
  }
}

function longPathSourceFiles(count: number) {
  const prefix = Array.from({ length: 14 }, (_, index) => "图".repeat(60) + index).join("/");
  const content = sourceFile("unused.txt", "x".repeat(4096));
  return Array.from({ length: count }, (_, index) => ({ ...content, path: prefix + `/file-${index}.txt` }));
}

it("source manifest v1 refuses an actual capture header over 16 MiB before capture, ACK or replay", async () => {
  const additions = longPathSourceFiles(1999), current = [sourceFile("counter.txt", "after"), ...additions];
  const manifest = fixtureSourceManifest(current);
  let headerBytes = 0;
  const f = await manifestCaptureFixture({ header: (header, operation) => {
    if (operation !== "capture-media") return;
    Object.assign(header, { files: current, sourceManifest: manifest, sourceResultManifestId: manifest.manifestId,
      snapshotId: reviewSnapshotDigest(current), sourceDelta: planSourceDelta(header.sourceBaselineManifest, manifest).summary });
    headerBytes = Buffer.byteLength(JSON.stringify(header), "utf8"); expect(headerBytes).toBeGreaterThan(16 * 1024 * 1024);
  } });
  const receipts: IsolatedOperationReceipt[] = [];
  const outcome = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.run());
  expect(outcome).toBeInstanceOf(Error); expect(headerBytes).toBeGreaterThan(16 * 1024 * 1024);
  expect(receipts.some(receipt => receipt.phase === "captured")).toBe(false);
  expect(f.requests.filter(request => request.operation === "capture-media")).toHaveLength(1);
  expect(f.requests.some(request => ["capture", "acknowledge"].includes(request.operation))).toBe(false);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1); expect(f.runs.size).toBe(1);
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("before");
}, 30000);

function fixturePackageArchive() {
  const entry = (name: string, bytes: Buffer) => {
    const header = Buffer.alloc(512); header.write(name); header.write("0000644\0", 100); header.write("0000000\0", 108);
    header.write("0000000\0", 116); header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  };
  const archive = gzipSync(Buffer.concat([
    entry("package/package.json", Buffer.from(JSON.stringify({ name: "header-fixture", version: "1.0.0" }))),
    entry("package/payload.bin", Buffer.alloc(3 * 1024 * 1024, 0x78)), Buffer.alloc(1024),
  ]), { level: 0 });
  return { name: "header-fixture", version: "1.0.0", sha512: createHash("sha512").update(archive).digest("hex"), data: archive.toString("base64") };
}

it("source manifest v1 checks the actual full UTF-8 prepare header against 24 MiB before submission", async () => {
  const f = await manifestCaptureFixture(), files = longPathSourceFiles(2000), manifest = fixtureSourceManifest(files), packages = [fixturePackageArchive()];
  const packageBytes = Buffer.byteLength(packages[0]!.data, "base64"); expect(packageBytes).toBeLessThan(4 * 1024 * 1024);
  const expected = { namespace: "test", projectId: f.project.id, operationId: "0".repeat(32), mode: "install", files, packages,
    rasterReturnVersion: 2, sourceManifestVersion: 1, sourceManifest: manifest };
  expect(Buffer.byteLength(JSON.stringify(expected), "utf8")).toBeGreaterThan(24 * 1024 * 1024);
  expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.data, "base64"), 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  const packageLookup = vi.spyOn(isolatedFiles, "publicPackages").mockResolvedValue(packages), receipts: IsolatedOperationReceipt[] = [];
  try {
    const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
      () => f.execution.start(f.project, "install", f.workspacePath, [], undefined, { files: async () => ({ files, media: [] }) })).catch(cause => cause);
    expect(isIsolatedInputBudgetError(failure)).toBe(true); expect(failure.message).toMatch(/24 MiB/);
    expect(isolatedCommandsNotSubmitted(receipts)).toBe(true); expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "input_rejected"]);
    expect(packageLookup).toHaveBeenCalledOnce(); expect(f.runs.size).toBe(0);
    expect(f.requests.some(request => ["prepare", "prepare-media", "capture", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
    expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("before");
  } finally { packageLookup.mockRestore(); }
}, 30000);

it.each<ManifestHeaderFault>(["sourceManifestVersion", "sourceBaselineManifest", "sourceManifest", "sourceResultManifestId", "sourceDelta",
  "wrong-version", "wrong-base", "wrong-result", "wrong-delta", "source-size", "raster-kind", "capture2"])("source manifest v1 refuses a malformed original capture without trusting the legacy snapshot alone: %s", async fault => {
  const f = await manifestCaptureFixture({ image: true, header: (header, operation) => {
    if (operation === "capture-media") corruptManifestHeader(header, fault);
  } });
  const receipts: IsolatedOperationReceipt[] = [];
  const outcome = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.run());
  expect(outcome).toBeInstanceOf(Error);
  expect(receipts.some(receipt => receipt.phase === "captured")).toBe(false);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1); expect(f.runs.size).toBe(1);
  expect(await readFile(path.join(f.workspacePath, f.before.path), "utf8")).toBe("before");
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).rejects.toMatchObject({ code: "ENOENT" });
});

it("source manifest v1 retains candidates for a complete bound review and approves exactly that publication", async () => {
  const f = await manifestCaptureFixture({ image: true });
  expect(await f.run()).toBeInstanceOf(Error);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  const review = await f.execution.reviewSource(f.project, "1", operation => operation());
  expect(review.blockers).toEqual([]); expect(review.approved).toBe(false);
  const stored = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId);
  expect(stored.retained?.sourceContract).toMatchObject({ version: 1, baseManifestId: fixtureSourceManifest([f.before]).manifestId,
    rawManifestId: f.resultManifest.manifestId, preparedManifestId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(review.sourceManifestVersion).toBe(1);
  expect(review.sourceRawDelta).toEqual(planSourceDelta(fixtureSourceManifest([f.before]), f.resultManifest).summary);
  expect(review.sourcePreparedDelta).toBeDefined();
  await expect(f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId)).rejects.toThrow();
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const result = await f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId);
  expect(result.changed).toContain(f.image.path); expect(await readFile(path.join(f.workspacePath, f.image.path))).toEqual(f.raw);
  const publication = JSON.parse(await readFile(path.join(path.dirname(f.workspacePath), result.recovery!, "manifest.json"), "utf8"));
  expect(publication).toMatchObject({ version: 4, state: "committed", context: { sourceContract: stored.retained!.sourceContract } });
  const recover = f.requests.find(request => request.operation === "recover")!;
  expect(recover.input).toMatchObject({ sourceManifestVersion: 1, sourceBaseManifestId: stored.retained!.sourceContract!.baseManifestId,
    sourceResultManifestId: f.resultManifest.manifestId, reviewVersion: 2 });
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1); expect(f.runs.size).toBe(1);
});

it.each<ManifestHeaderFault>(["sourceManifestVersion", "sourceBaselineManifest", "sourceManifest", "sourceResultManifestId", "sourceDelta", "source-size", "raster-kind"])("source manifest v1 refuses incomplete or payload-inconsistent retained review: %s", async fault => {
  const f = await manifestCaptureFixture({ image: true, header: (header, operation) => {
    if (operation === "review-source-media") corruptManifestHeader(header, fault);
  } });
  expect(await f.run()).toBeInstanceOf(Error);
  await expect(f.execution.reviewSource(f.project, "1", operation => operation())).rejects.toSatisfy(error =>
    error instanceof Error && !getToolPreflightFailure(error));
  expect(f.requests.some(request => request.operation === "review-source-media")).toBe(true);
  expect(f.requests.some(request => ["recover", "acknowledge"].includes(request.operation))).toBe(false);
  expect(await readFile(path.join(f.workspacePath, f.before.path), "utf8")).toBe("before");
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.runs.size).toBe(1);
});

it("source manifest v1 verifies a lost adoption ACK against the exact current manifest and original operation without replay", async () => {
  const f = await manifestCaptureFixture({ image: true, lostAck: true });
  expect(await f.run()).toBeInstanceOf(Error);
  const review = await f.execution.reviewSource(f.project, "1", operation => operation());
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const failure = await f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId).catch(cause => cause);
  expect(getIsolatedRepairPending(failure)).toMatchObject({ reviewId: review.reviewId, rawSnapshotId: f.snapshotId });
  expect(f.baseManifest()).toEqual(f.resultManifest);
  const start = f.requests.length;
  await expect(f.execution.verifySourceReview(f.project, review.reviewId)).resolves.toMatchObject({ changed: [] });
  expect(f.requests.slice(start).filter(request => request.operation === "review-source-media")[0]?.input)
    .toMatchObject({ sourceManifestVersion: 1, sourceBaseManifestId: f.resultManifest.manifestId, reviewVersion: 2 });
  expect(f.requests.slice(start).some(request => ["prepare", "recover", "capture", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
  expect(await readFile(path.join(f.workspacePath, f.image.path))).toEqual(f.raw); expect(f.runs.size).toBe(1);
});

it("source manifest v1 binds an explicitly resized working target separately from the immutable raw manifest", async () => {
  const f = await manifestCaptureFixture({ image: true, imageSize: 512 });
  expect(await f.run()).toBeInstanceOf(Error);
  const initial = await f.execution.reviewSource(f.project, "1", operation => operation());
  const review = await f.execution.optimizeSourceReview(f.project, initial.reviewId, { paths: [f.image.path], maxEdge: 256 }, operation => operation());
  expect(review.blockers).toEqual([]);
  const stored = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId);
  expect(stored.retained!.sourceContract!.rawManifestId).toBe(f.resultManifest.manifestId);
  expect(stored.retained!.sourceContract!.preparedManifestId).not.toBe(f.resultManifest.manifestId);
  expect(review.sourceRawDelta).toEqual(initial.sourceRawDelta);
  expect(review.sourcePreparedDelta?.afterMediaBytes).toBeLessThan(review.sourceRawDelta!.afterMediaBytes);
  expect(review.reviewId).not.toBe(initial.reviewId);
  expect(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).toEqual(f.raw);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
});

it("source manifest v1 reconstructs an inline source raster as a media working target even when its content hash is unchanged", async () => {
  const f = await fixture(), bytes = referencePng({ width: 32, height: 32, noise: true, level: 0 });
  const image = { path: "public/inline.png", data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), executable: false };
  const baseline = createSourceManifest([]), raw = fixtureSourceManifest([image]);
  const record = await sourceReview.buildRetainedSourceReview(f.workspacePath, "test", f.project.id, 1, {
    reviewVersion: 2, rasterReturnVersion: 2, files: [image], baselineFiles: [], retainedRasters: [], originOperations: [],
    snapshotId: reviewSnapshotDigest([image]), sourceManifestVersion: 1, sourceBaselineManifest: baseline, sourceManifest: raw,
    sourceResultManifestId: raw.manifestId, sourceDelta: planSourceDelta(baseline, raw).summary,
  }, new Map());
  expect(record.review.blockers).toEqual([]);
  await sourceReview.saveSourceReview(record);
  const restored = await readSourceReview(f.workspacePath, f.project.id, "test", record.review.reviewId);
  const manifests = sourceReview.reviewSourceManifests(restored);
  expect(manifests.raw.files).toEqual([{ path: image.path, kind: "source", size: bytes.length, sha256: image.sha256, executable: false }]);
  expect(manifests.prepared?.files).toEqual([{ path: image.path, kind: "media", size: bytes.length, sha256: image.sha256, executable: false }]);
  expect(manifests.prepared?.manifestId).not.toBe(manifests.raw.manifestId);
  expect(restored.retained!.sourceContract).toEqual({ version: 1, baseManifestId: baseline.manifestId,
    rawManifestId: raw.manifestId, preparedManifestId: manifests.prepared!.manifestId });
  await sourceReview.assertRetainedReviewArtifacts(restored);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([["restore-response", 1], ["confirm-response", 1], ["confirm-response", 2]] as const)("withdraws exactly the old source deletion across a lost %s (manifest v%s)", async (lost, version) => {
  const f = await fixture();
  const deleted = sourceFile("_t.mjs", "export const temporary = true;");
  const keep = sourceFile("index.html", "unchanged");
  for (const item of [deleted, keep]) await writeFile(path.join(f.workspacePath, item.path), Buffer.from(item.data, "base64"));
  const hostBefore = await stat(path.join(f.workspacePath, deleted.path), { bigint: true });
  const manifest = version === 1 ? fixtureSourceManifest : fixtureProfileManifest;
  const baseline = manifest([deleted, keep]), raw = manifest([keep]);
  const sourceScope = version === 1 ? { sourceManifestVersion: 1 as const } : { sourceManifestVersion: 2 as const, sourceProfileId: "capacity-128-v2" as const };
  const snapshotId = reviewSnapshotDigest([keep]);
  const original = { operationId: "f".repeat(32), mode: "shell", phase: "released", snapshotId, acknowledged: false,
    ...sourceScope, sourceBaseManifestId: baseline.manifestId, sourceResultManifestId: raw.manifestId };
  const record = await sourceReview.buildRetainedSourceReview(f.workspacePath, "test", f.project.id, 37, {
    reviewVersion: 2, rasterReturnVersion: 2, files: [keep], baselineFiles: [deleted, keep], retainedRasters: [], originOperations: [original],
    snapshotId, ...sourceScope, sourceBaselineManifest: baseline, sourceManifest: raw,
    sourceResultManifestId: raw.manifestId, sourceDelta: planSourceDelta(baseline, raw).summary,
  }, new Map());
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, limits: resourceLimits, runtimeMediaVersion: 1, buildMediaVersion: 1,
    rasterInspectionVersion: 2, captureVersion: 2, manifestCaptureVersion: 3, sourceManifestVersion: 1,
    retainedReviewVersion: 2, sourceDeletionWithdrawalVersion: 1,
    ...(version === 2 ? { capacityProfileVersion: 2, profileManifestVersion: 2, profileCaptureVersion: 4, profileUploadVersion: 1,
      volumeMigrationVersion: 1, capacityProfiles: [getRuntimeCapacityProfile("capacity-128-v2")] } : {}) }));
  const storage = { projectId: f.project.id, namespace: "test", generation: 37, state: "recovery-pending", dirty: true, active: false,
    ...sourceScope, sourceBaseManifestId: baseline.manifestId };
  f.projects.set(f.project.id, storage);
  let phase = "absent";
  const reviewID = record.review.reviewId;
  f.handlers.set("inspect-source-deletion-withdrawal", binding => ({ ...binding, phase }));
  f.handlers.set("restore-source-deletions", ({ files, ...binding }) => {
    expect(files).toEqual([deleted]); expect(binding.originalOperationId).toBe(original.operationId);
    phase = "restored";
    if (lost === "restore-response") throw new Error("Lost restore response");
    return { ...binding, phase };
  });
  f.handlers.set("confirm-source-deletion-withdrawal", async binding => {
    const saved = await readSourceReview(f.workspacePath, f.project.id, "test", reviewID);
    expect(saved.deletionWithdrawal).toEqual({ id: binding.withdrawalId, phase: "disposed" });
    phase = "confirmed"; storage.dirty = false; storage.state = "resident";
    if (lost === "confirm-response") throw new Error("Lost confirm response");
    return { ...binding, phase };
  });
  const status = async () => f.execution.deletionWithdrawalStatus(f.project, await f.execution.inventoryProject(f.project));
  const run = (execution = f.execution) => execution.withdrawSourceDeletion(f.project, "37", reviewID);
  const inspection = { projectId: f.project.id, namespace: "test" as const, generation: 37, complete: true, blockers: 1,
    excluded: 0, changes: [{ path: deleted.path, kind: "deleted" as const }] };
  await expect(f.execution.deletionWithdrawalStatus(f.project, await f.execution.inventoryProject(f.project), inspection))
    .resolves.toEqual({ deletionWithdrawalNeedsReview: true });
  await sourceReview.saveSourceReview(record);
  await expect(status()).resolves.toMatchObject({ deletionWithdrawal: { reviewId: reviewID, status: "available", paths: [deleted.path] } });
  await expect(run()).rejects.toThrow(/Lost .* response/);
  await expect(f.execution.assertSourceReviewSettled(f.project)).rejects.toThrow();
  await expect(status()).resolves.toMatchObject({ deletionWithdrawal: { status: "pending" } });
  const restarted = Reflect.construct(IsolatedProjectExecution, [path.dirname(path.dirname(f.workspacePath)), undefined, "test"]) as IsolatedProjectExecution;
  executions.push(restarted);
  await expect(run(restarted)).resolves.toMatchObject({ generation: "37", status: "withdrawn", paths: [deleted.path] });
  await expect(run(restarted)).resolves.toMatchObject({ status: "withdrawn" });
  await expect(restarted.assertSourceReviewSettled(f.project)).resolves.toBeUndefined();
  await expect(status()).resolves.toMatchObject({ deletionWithdrawal: { reviewId: reviewID, status: "withdrawn" } });
  expect(f.requests.filter(request => request.operation === "restore-source-deletions")).toHaveLength(1);
  expect(f.requests.filter(request => request.operation === "confirm-source-deletion-withdrawal")).toHaveLength(1);
  expect(f.requests.some(request => ["run", "acknowledge", "recover"].includes(request.operation))).toBe(false);
  const hostAfter = await stat(path.join(f.workspacePath, deleted.path), { bigint: true });
  expect([hostAfter.ino, hostAfter.mode, hostAfter.mtimeNs, hostAfter.ctimeNs]).toEqual([hostBefore.ino, hostBefore.mode, hostBefore.mtimeNs, hostBefore.ctimeNs]);
  const nextRaw = manifest([deleted]);
  const nextSnapshotId = reviewSnapshotDigest([deleted]);
  const nextOriginal = { ...original, operationId: randomUUID().replaceAll("-", ""), snapshotId: nextSnapshotId, sourceResultManifestId: nextRaw.manifestId };
  const nextReview = await sourceReview.buildRetainedSourceReview(f.workspacePath, "test", f.project.id, 37, {
    reviewVersion: 2, rasterReturnVersion: 2, files: [deleted], baselineFiles: [deleted, keep], retainedRasters: [], originOperations: [nextOriginal],
    snapshotId: nextSnapshotId, ...sourceScope, sourceBaselineManifest: baseline, sourceManifest: nextRaw,
    sourceResultManifestId: nextRaw.manifestId, sourceDelta: planSourceDelta(baseline, nextRaw).summary,
  }, new Map());
  await sourceReview.saveSourceReview(nextReview);
  storage.dirty = true; storage.state = "recovery-pending";
  await expect(status()).resolves.toMatchObject({ deletionWithdrawal: { reviewId: nextReview.review.reviewId, status: "available", paths: [keep.path] } });
  await expect(restarted.assertSourceReviewSettled(f.project)).rejects.toThrow();
});

it("source manifest v1 leaves a blocked working batch without a prepared identity or approval", async () => {
  const f = await manifestCaptureFixture({ image: true }); expect(await f.run()).toBeInstanceOf(Error);
  const prepare = vi.spyOn(imagePreparation, "prepareWorkingImage").mockRejectedValueOnce(new Error("Fixture working preparation unavailable"));
  try {
    const review = await f.execution.reviewSource(f.project, "1", operation => operation());
    expect(review.blockers.length).toBeGreaterThan(0); expect(review.sourcePreparedDelta).toBeUndefined();
    const stored = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId);
    expect(stored.retained!.sourceContract!.preparedManifestId).toBeUndefined();
    expect(validSourceConfirmation(review, { reviewId: review.reviewId, filesReviewed: true, codeReviewed: true })).toBe(false);
    await expect(f.execution.approveSourceReview(f.project, review.reviewId, operation => operation())).rejects.toThrow();
    expect(f.requests.some(request => ["recover", "acknowledge"].includes(request.operation))).toBe(false);
    await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { prepare.mockRestore(); }
});

it.each(["baseline-size", "raw-kind", "raw-size", "working-hash", "working-size"])("source manifest v1 rejects a modified persisted review: %s", async fault => {
  const f = await manifestCaptureFixture({ image: true });
  expect(await f.run()).toBeInstanceOf(Error);
  const review = await f.execution.reviewSource(f.project, "1", operation => operation());
  const file = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json");
  const record = JSON.parse(await readFile(file, "utf8")), raw = record.retained.rawFiles.find((entry: any) => entry.path === f.image.path);
  if (fault === "baseline-size") record.retained.sourceBaselineSizes[0]++;
  else if (fault === "raw-kind") raw.kind = "source";
  else if (fault === "raw-size") raw.size++;
  else if (fault === "working-hash") record.retained.images[f.image.path].workingSha256 = "f".repeat(64);
  else record.review.files.find((entry: any) => entry.path === f.image.path).bytes++;
  await writeFile(file, JSON.stringify(record));
  await expect(readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId)).rejects.toThrow();
  await expect(f.execution.approveSourceReview(f.project, review.reviewId, operation => operation())).rejects.toThrow();
  expect(f.requests.some(request => ["recover", "acknowledge"].includes(request.operation))).toBe(false);
  expect(await readFile(path.join(f.workspacePath, f.before.path), "utf8")).toBe("before");
});

it.each(["released", "finished"] as const)("source manifest v1 reconnects only an exact cold promise for the %s original operation", async phase => {
  const f = await manifestCaptureFixture({ image: true, originPhase: phase });
  expect(await f.run()).toBeInstanceOf(Error); await f.execution.close();
  vi.resetModules();
  const stagedSpace = await import("../src/daemon/recovery-space.js");
  const owner = { ownerKey: f.originalId(), namespace: "test" as const, projectId: f.project.id, generation: 1,
    rawSnapshotId: f.snapshotId, sourceManifestVersion: 1 as const, sourceBaseManifestId: fixtureSourceManifest([f.before]).manifestId,
    sourceResultManifestId: f.resultManifest.manifestId };
  const lease = await stagedSpace.reserveRecoverySpace(f.workspacePath, {
    rawBytes: 72 * 1024 * 1024, workingBytes: 64 * 1024 * 1024, beforeBytes: Buffer.byteLength(f.before.data, "base64"),
    afterBytes: 72 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024, reviewBytes: 8 * 1024 * 1024,
  }, owner);
  vi.resetModules();
  const { IsolatedProjectExecution: FreshExecution } = await import("../src/daemon/isolated-project-execution.js");
  const fresh = Reflect.construct(FreshExecution, [path.dirname(path.dirname(f.workspacePath)), undefined, "test"]) as IsolatedProjectExecution;
  executions.push(fresh);
  const folder = path.join(path.dirname(f.workspacePath), "isolated-space-reservations"), [name] = await readdir(folder);
  const original = JSON.parse(await readFile(path.join(folder, name!), "utf8")); expect(original.owner).toMatchObject(owner);
  if (phase === "finished") {
    try {
      await expect(fresh.reviewSource(f.project, "1", operation => operation())).rejects.toThrow();
      expect(JSON.parse(await readFile(path.join(folder, name!), "utf8"))).toEqual(original);
      expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
    } finally { await lease.release(); }
  } else {
    const review = await fresh.reviewSource(f.project, "1", operation => operation());
    expect(review.blockers).toEqual([]);
    expect(JSON.parse(await readFile(path.join(folder, name!), "utf8"))).toEqual(original);
    await fresh.approveSourceReview(f.project, review.reviewId, operation => operation());
    await fresh.recoverSource(f.project, operation => operation(), "1", review.reviewId);
    expect(await readdir(folder)).toEqual([]); expect(await readFile(path.join(f.workspacePath, f.image.path))).toEqual(f.raw);
  }
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1); expect(f.runs.size).toBe(1);
}, 30000);

it("retains streamed image candidates from the original command for explicit review and adoption", async () => {
  const f = await captureMediaFixture(), receipts: IsolatedOperationReceipt[] = [];
  let capturedReservation: any;
  const reservationFolder = path.join(path.dirname(f.workspacePath), "isolated-space-reservations");
  const task = withIsolatedOperationScope(async history => {
    receipts.splice(0, receipts.length, ...history);
    if (history.at(-1)?.phase === "captured") {
      const entries = await readdir(reservationFolder); expect(entries).toHaveLength(1);
      capturedReservation = JSON.parse(await readFile(path.join(reservationFolder, entries[0]!), "utf8"));
    }
  }, () => f.execution.shell(f.project, "fixture-only", 5, async operation => operation()));
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  expect((await failure).message).toMatch(/retained.*review/i);
  const capture = f.requests.find(request => request.operation === "capture-media")!;
  expect(capture.input).toEqual({ namespace: "test", projectId: f.project.id, operationId: f.originalId(), generation: 1, leaseToken: "e".repeat(32), captureVersion: 2 });
  expect(f.prepareReservation().owner).toMatchObject({ namespace: "test", projectId: f.project.id, ownerKey: f.originalId() });
  expect(capturedReservation.owner).toMatchObject({ namespace: "test", projectId: f.project.id, ownerKey: f.originalId(), generation: 1, rawSnapshotId: f.snapshotId });
  expect(await readdir(reservationFolder)).toEqual([]);
  expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "retained", "released"]);
  expect(receipts.find(receipt => receipt.phase === "captured")?.snapshotId).toBe(f.snapshotId);
  expect(f.requests.some(request => ["capture", "acknowledge"].includes(request.operation))).toBe(false);
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).equals(f.raw)).toBe(true);
  const review = await testStage("review", () => f.execution.reviewSource(f.project, "1", operation => operation()));
  expect(review.blockers).toEqual([]); expect(review.approved).toBe(false);
  expect(review.files.find(file => file.path === f.image.path)?.optimization).toMatchObject({ originalWidth: 512, originalHeight: 512, workingSha256: f.image.sha256 });
  await expect(f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId)).rejects.toThrow();
  await testStage("approve", () => f.execution.approveSourceReview(f.project, review.reviewId, operation => operation()));
  await testStage("adopt", () => f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId));
  expect((await readFile(path.join(f.workspacePath, f.image.path))).equals(f.raw)).toBe(true);
  expect(f.runs.size).toBe(1); expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1);
}, 30000);

it.each(["truncated", "hash", "trailing", "exit"] as const)("does not publish or acknowledge an invalid streamed capture: %s", async fault => {
  const f = await captureMediaFixture(fault), receipts: IsolatedOperationReceipt[] = [];
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.execution.shell(f.project, "fixture-only", 5, operation => operation()));
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  expect(await failure).toBeInstanceOf(Error);
  expect(receipts.some(receipt => receipt.phase === "captured")).toBe(false);
  expect(receipts.map(receipt => receipt.phase)).toContain("retained");
  expect(f.requests.some(request => ["capture", "acknowledge"].includes(request.operation))).toBe(false);
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(f.workspacePath, f.source.path))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  const incoming = path.join(path.dirname(f.workspacePath), "isolated-source-transfers");
  expect(await readdir(incoming).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).toEqual([]);
  expect(f.runs.size).toBe(1);
}, 30000);

it("cancels an in-flight capture without trusting partial bytes or publishing a snapshot", async () => {
  const f = await captureMediaFixture("hold"), controller = new AbortController(), receipts: IsolatedOperationReceipt[] = [];
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
    () => f.execution.shell(f.project, "fixture-only", 5, operation => operation(), controller.signal));
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  await vi.waitFor(() => expect(f.requests.some(request => request.operation === "capture-media")).toBe(true));
  controller.abort(); expect(await failure).toBeInstanceOf(Error);
  expect(receipts.some(receipt => receipt.phase === "captured")).toBe(false);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  const incoming = path.join(path.dirname(f.workspacePath), "isolated-source-transfers");
  expect(await readdir(incoming).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))).toEqual([]);
  expect(await readdir(path.join(path.dirname(f.workspacePath), "isolated-space-reservations"))).toEqual([]);
});

it("refuses a command before guest preparation when recovery space is already reserved", async () => {
  const f = await captureMediaFixture(), receipts: IsolatedOperationReceipt[] = [];
  const lease = await reserveRecoverySpace(f.workspacePath, { rawBytes: 0, workingBytes: 0, beforeBytes: 0, afterBytes: 0, manifestBytes: 0 },
    { ownerKey: "a".repeat(32), namespace: "test", projectId: f.project.id });
  try {
    const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
      () => f.execution.shell(f.project, "fixture-only", 5, operation => operation())).catch(cause => cause);
    expect(failure).toMatchObject({ code: "RECOVERY_SPACE_REQUIRED" });
    expect(isIsolatedInputBudgetError(failure)).toBe(false);
    expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight"]);
    expect(f.requests.some(request => ["prepare", "prepare-media", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
    expect(f.runs.size).toBe(0);
  } finally { await lease.release(); }
});

it("records a trusted disk capacity rejection before any guest preparation", async () => {
  const f = await captureMediaFixture(), receipts: IsolatedOperationReceipt[] = [];
  const realStatfs = fs.statfs;
  const disk = vi.spyOn(fs, "statfs").mockImplementation((async (...args: Parameters<typeof fs.statfs>) => {
    const value = await realStatfs(...args);
    return String(args[0]) === f.workspacePath ? { ...value, bavail: 0n } : value;
  }) as typeof fs.statfs);
  try {
    const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
      () => f.execution.shell(f.project, "fixture-only", 5, operation => operation())).catch(cause => cause);
    expect(isIsolatedInputBudgetError(failure)).toBe(true);
    expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(true);
    expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "input_rejected"]);
    expect(receipts.every(receipt => receipt.namespace === "test" && receipt.projectId === f.project.id && receipt.operationId === receipts[0]!.operationId)).toBe(true);
    expect(f.requests.some(request => ["prepare", "prepare-media", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
    expect(f.runs.size).toBe(0);
  } finally { disk.mockRestore(); }
});

it("does not trust forged recovery capacity wording as an input rejection", async () => {
  const f = await captureMediaFixture(), receipts: IsolatedOperationReceipt[] = [];
  const forged = Object.assign(new Error("Recovery space requires review: insufficient available disk space; keep original dimensions and quality and arrange storage"), { code: "RECOVERY_SPACE_REQUIRED", rejection: "input_budget", effect: "none" });
  const reserve = vi.spyOn(recoverySpace, "reserveRecoverySpace").mockRejectedValueOnce(forged);
  try {
    const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
      () => f.execution.shell(f.project, "fixture-only", 5, operation => operation())).catch(cause => cause);
    expect(failure).toBe(forged); expect(isIsolatedInputBudgetError(failure)).toBe(false);
    expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight"]);
    expect(f.requests.some(request => ["prepare", "prepare-media", "capture-media"].includes(request.operation))).toBe(false);
    expect(f.runs.size).toBe(0);
  } finally { reserve.mockRestore(); }
});

it("does not leave a reservation or approval when approval snapshot verification fails", async () => {
  const f = await retainedFixture({ small: true });
  const review = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation()));
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    child.stdin.once("finish", () => {
      const header = { ...f.header(), snapshotId: "d".repeat(64) };
      (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), f.raw]));
      queueMicrotask(() => child.emit("close", 0));
    });
    (child.stdin as PassThrough).resume(); return child;
  });
  await expect(f.owned(() => f.execution.approveSourceReview(f.project, review.reviewId, operation => operation()))).rejects.toThrow();
  const reservationFolder = path.join(path.dirname(f.workspacePath), "isolated-space-reservations");
  expect(await readdir(reservationFolder)).toEqual([]);
  expect((await f.execution.sourceReview(f.project, review.reviewId)).approved).toBe(false);
  spawn.mockImplementation(previous);
  await f.owned(() => f.execution.approveSourceReview(f.project, review.reviewId, operation => operation()));
  expect((await f.execution.sourceReview(f.project, review.reviewId)).approved).toBe(true);
  expect(await readdir(reservationFolder)).toEqual([]);
});

it("does not read or reserve anything for an already cancelled review", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController();
  controller.abort();
  const reserve = vi.spyOn(recoverySpace, "reserveRecoverySpace");
  try {
    await expect(f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation(), controller.signal))).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
    await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { reserve.mockRestore(); }
});

it("cancels a retained review during raw transfer without publishing or approving", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController(), previous = spawn.getMockImplementation()!;
  let transferStarted = false;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    child.stdin.once("finish", () => {
      (child.stdout as PassThrough).write(Buffer.concat([Buffer.from(JSON.stringify(f.header()) + "\n"), f.raw.subarray(0, 16)]));
      transferStarted = true;
    });
    (child.stdin as PassThrough).resume(); return child;
  });
  const task = f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation(), controller.signal));
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(transferStarted).toBe(true));
  const root = path.join(path.dirname(f.workspacePath), "isolated-space-reservations");
  await vi.waitFor(async () => expect(await readdir(root)).toHaveLength(1));
  controller.abort(); expect(await failure).toBeInstanceOf(Error);
  expect(await readdir(root)).toEqual([]);
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-reviews"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.requests.some(request => ["recover", "capture", "acknowledge"].includes(request.operation))).toBe(false);
});

it("cancels private image preparation without saving or approving a review", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController();
  const prepare = imagePreparation.prepareWorkingImage;
  let resume!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(imagePreparation, "prepareWorkingImage").mockImplementation(async (...args) => { await hold; return prepare(...args); });
  try {
    const task = f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation(), controller.signal));
    const failure = task.catch(cause => cause);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce()); controller.abort(); resume();
    expect(await failure).toBeInstanceOf(Error);
    const parent = path.dirname(f.workspacePath);
    expect(await readdir(path.join(parent, "isolated-space-reservations"))).toEqual([]);
    await expect(stat(path.join(parent, "isolated-reviews"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(path.join(parent, "isolated-review-artifacts/raw", f.image.sha256))).equals(f.raw)).toBe(true);
    await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.requests.some(request => ["recover", "capture", "acknowledge"].includes(request.operation))).toBe(false);
  } finally { resume(); spy.mockRestore(); }
});

it.each(["failure", "cancel"] as const)("never publishes a %s original operation with retained media", async outcome => {
  const f = await captureMediaFixture(), controller = new AbortController();
  const task = f.execution.shell(f.project, "fixture-only", 5, operation => operation(), controller.signal);
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  if (outcome === "cancel") controller.abort();
  else f.completeRun([...f.runs.keys()][0]!, 1);
  expect(await failure).toBeInstanceOf(Error);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  if (outcome === "cancel") expect(f.requests.some(request => ["capture-media", "capture"].includes(request.operation))).toBe(false);
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.runs.size).toBe(1);
});

it("verifies a lost approval ACK without replaying the original operation or publication", async () => {
  const f = await captureMediaFixture(undefined, true);
  const task = f.execution.shell(f.project, "fixture-only", 5, operation => operation());
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!); await failure;
  const review = await f.execution.reviewSource(f.project, "1", operation => operation());
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const lost = await f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId).catch(cause => cause);
  expect(lost.message).toMatch(/acknowledgement response was lost/);
  expect(getIsolatedRepairPending(lost)).toMatchObject({ reviewId: review.reviewId, rawSnapshotId: f.snapshotId, publicationVerified: true, released: true });
  expect((await readFile(path.join(f.workspacePath, f.image.path))).equals(f.raw)).toBe(true);
  const before = f.requests.length;
  await expect(f.execution.verifySourceReview(f.project, review.reviewId)).resolves.toMatchObject({ changed: [] });
  expect(f.requests.slice(before).some(request => ["recover", "capture", "capture-media", "acknowledge", "release", "prepare"].includes(request.operation))).toBe(false);
  expect(f.runs.size).toBe(1);
}, 30000);

it("resumes an interrupted approved publication with its original reservation and journal", async () => {
  const f = await captureMediaFixture();
  const task = f.execution.shell(f.project, "fixture-only", 5, operation => operation());
  const originalResult = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  expect((await originalResult).message).toMatch(/retained.*review/i);
  const review = await f.execution.reviewSource(f.project, "1", operation => operation());
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());

  const realRm = fs.rm, realRename = fs.rename;
  const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, ...args) => {
    if (String(target).includes(`${path.sep}isolated-changes${path.sep}`) && String(target).includes(`${path.sep}after${path.sep}`))
      throw new Error("fixture staging cleanup failure");
    return realRm(target, ...args);
  });
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).includes(`${path.sep}isolated-changes${path.sep}`) && path.basename(String(to)).startsWith("failed-"))
      throw new Error("fixture rollback failure");
    return realRename(from, to);
  });
  try {
    await expect(f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId)).rejects.toThrow("Source publication stopped");
  } finally { remove.mockRestore(); renameSpy.mockRestore(); }

  const parent = path.dirname(f.workspacePath), journalRoot = path.join(parent, "isolated-changes"), reservationRoot = path.join(parent, "isolated-space-reservations");
  const [journalId] = await readdir(journalRoot), [reservationFile] = await readdir(reservationRoot);
  expect(journalId).toBeDefined(); expect(reservationFile).toBeDefined();
  const journalPath = path.join(journalRoot, journalId!, "manifest.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const reservation = JSON.parse(await readFile(path.join(reservationRoot, reservationFile!), "utf8"));
  expect(journal).toMatchObject({ version: 3, state: "needs-review", reservationId: reservation.id, context: { namespace: "test", projectId: f.project.id, generation: 1, snapshotId: f.snapshotId } });
  expect(reservation.owner).toMatchObject({ namespace: "test", projectId: f.project.id, generation: 1, rawSnapshotId: f.snapshotId });
  expect(f.requests.filter(request => request.operation === "release")).toHaveLength(2);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);

  const rereview = await f.execution.reviewSource(f.project, "1", operation => operation());
  expect(rereview.reviewId).toBe(review.reviewId);
  expect(await readdir(reservationRoot)).toEqual([reservationFile]);
  expect(JSON.parse(await readFile(path.join(reservationRoot, reservationFile!), "utf8"))).toEqual(reservation);
  const result = await f.execution.recoverSource(f.project, operation => operation(), "1", review.reviewId);
  expect(result.recovery).toBe(`isolated-changes/${journalId}`);
  expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ version: 3, state: "committed", reservationId: reservation.id, context: journal.context });
  expect(await readdir(journalRoot)).toEqual([journalId]); expect(await readdir(reservationRoot)).toEqual([]);
  expect((await readFile(path.join(f.workspacePath, f.image.path))).equals(f.raw)).toBe(true);
  expect(f.runs.size).toBe(1); expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1);
  expect(f.requests.filter(request => request.operation === "capture-media")).toHaveLength(1);
}, 30000);

it.each(["released", "finished", "active"] as const)("reconnects only a cold intent for a %s original operation", async phase => {
  const f = await captureMediaFixture(undefined, false, phase);
  const task = f.execution.shell(f.project, "fixture-only", 5, operation => operation());
  const failed = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  expect((await failed).message).toMatch(/retained.*review/i);
  await f.execution.close();

  vi.resetModules();
  const stagedSpace = await import("../src/daemon/recovery-space.js");
  const owner = { ownerKey: f.originalId(), namespace: "test" as const, projectId: f.project.id, generation: 1, rawSnapshotId: f.snapshotId };
  const lease = await stagedSpace.reserveRecoverySpace(f.workspacePath, {
    rawBytes: 72 * 1024 * 1024, workingBytes: 64 * 1024 * 1024, beforeBytes: 0,
    afterBytes: 72 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024, reviewBytes: 8 * 1024 * 1024,
  }, owner);
  const origin = { operationId: f.originalId(), mode: "shell", phase: "released", snapshotId: f.snapshotId };
  await expect(stagedSpace.reconnectRetainedRecoverySpace(f.workspacePath, {
    namespace: "test", projectId: f.project.id, generation: 1, rawSnapshotId: f.snapshotId, originOperations: [origin],
  })).rejects.toThrow();
  vi.resetModules();
  const { IsolatedProjectExecution: FreshExecution } = await import("../src/daemon/isolated-project-execution.js");
  const fresh = Reflect.construct(FreshExecution, [path.dirname(path.dirname(f.workspacePath)), undefined, "test"]) as IsolatedProjectExecution;
  executions.push(fresh);
  const reservationRoot = path.join(path.dirname(f.workspacePath), "isolated-space-reservations");
  const [reservationFile] = await readdir(reservationRoot);
  const intent = JSON.parse(await readFile(path.join(reservationRoot, reservationFile!), "utf8"));
  expect(intent.owner).toMatchObject(owner);
  if (phase !== "released") {
    try {
      await expect(fresh.reviewSource(f.project, "1", operation => operation())).rejects.toThrow();
      expect(await readdir(reservationRoot)).toEqual([reservationFile]);
      expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
      await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await lease.release(); }
  } else {
    const review = await fresh.reviewSource(f.project, "1", operation => operation());
    expect(review.blockers).toEqual([]); expect(await readdir(reservationRoot)).toEqual([reservationFile]);
    expect(JSON.parse(await readFile(path.join(reservationRoot, reservationFile!), "utf8"))).toEqual(intent);
    await fresh.approveSourceReview(f.project, review.reviewId, operation => operation());
    await fresh.recoverSource(f.project, operation => operation(), "1", review.reviewId);
    expect(await readdir(reservationRoot)).toEqual([]);
    expect((await readFile(path.join(f.workspacePath, f.image.path))).equals(f.raw)).toBe(true);
    expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1);
    expect(f.requests.filter(request => request.operation === "capture-media")).toHaveLength(1);
    expect(f.runs.size).toBe(1);
  }
}, 30000);

it("keeps old guest capture on its negotiated legacy policy", async () => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, rasterReturnVersion: 1, retainedReviewVersion: 2, limits: resourceLimits }));
  f.handlers.set("prepare", async (...args) => {
    expect(args[0].rasterReturnVersion).toBe(1);
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 1 };
    f.operations.set(args[0].operationId, binding); return binding;
  });
  f.handlers.set("capture", input => ({ files: [], baselineFiles: [], snapshotId: "b".repeat(64), generation: input.generation, rasterReturnVersion: 1 }));
  const task = f.execution.shell(f.project, "fixture-only", 5, operation => operation());
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  await expect(task).resolves.toMatchObject({ changed: [] });
  expect(f.requests.filter(request => request.operation === "capture")).toHaveLength(1);
  expect(f.requests.some(request => request.operation === "capture-media")).toBe(false);
});

it.each([false, true])("handles an unknown policy 2 source ACK without replay; guest stays dirty=%s", async remainsDirty => {
  const f = await fixture(), before = sourceFile("counter.txt", "before"), after = sourceFile("counter.txt", "after");
  const snapshotId = reviewSnapshotDigest([after]);
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, rasterReturnVersion: 1, rasterInspectionVersion: 2, captureVersion: 2, retainedReviewVersion: 2, limits: resourceLimits }));
  f.handlers.set("prepare", async (...args) => {
    expect(args[0].rasterReturnVersion).toBe(2);
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2, captureVersion: 2 };
    f.operations.set(args[0].operationId, binding); return binding;
  });
  f.handlers.set("recover", async (...args) => {
    if (remainsDirty) throw new Error("Dirty policy 2 generation requires reviewed recovery");
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2, captureVersion: 2 };
    f.operations.set(args[0].operationId, binding); return binding;
  });
  let acknowledgements = 0;
  f.handlers.set("acknowledge", () => {
    if (++acknowledgements <= 2) { f.projects.get(f.project.id).dirty = remainsDirty; throw new Error("Fixture ACK response unavailable"); }
    return { acknowledged: true };
  });
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "capture-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    let request = ""; child.stdin.on("data", bytes => { request += bytes.toString(); });
    child.stdin.once("finish", () => {
      const input = JSON.parse(request); f.requests.push({ operation: "capture-media", input, args: args[1] });
      const baselineFiles = acknowledgements ? [after] : [before];
      const header = { namespace: "test", projectId: f.project.id, operationId: input.operationId, generation: 1, captureVersion: 2, rasterReturnVersion: 2,
        snapshotId, files: [after], baselineFiles, returnedRasters: [] };
      (child.stdout as PassThrough).end(JSON.stringify(header) + "\n"); queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  });
  const pending = f.execution.shell(f.project, "fixture-only", 5, operation => operation());
  const failed = pending.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  expect((await failed).message).toContain("Fixture ACK response unavailable");
  expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("after");
  expect(await readdir(path.join(path.dirname(f.workspacePath), "isolated-space-reservations"))).toEqual([]);
  const reserve = vi.spyOn(recoverySpace, "reserveRecoverySpace");
  try {
    const start = f.requests.length;
    if (remainsDirty) {
      await expect(f.execution.recoverSource(f.project, operation => operation(), "1")).rejects.toThrow("Dirty policy 2 generation requires reviewed recovery");
      expect(f.requests.slice(start).some(request => ["capture-media", "acknowledge"].includes(request.operation))).toBe(false);
    } else {
      await expect(f.execution.recoverSource(f.project, operation => operation(), "1")).resolves.toEqual({ changed: [] });
      const captured = f.requests.slice(start).find(request => request.operation === "capture-media")!;
      expect(captured.input).toEqual({ namespace: "test", projectId: f.project.id, operationId: expect.stringMatching(/^[a-f0-9]{32}$/), generation: 1, leaseToken: "e".repeat(32), captureVersion: 2 });
      expect(captured.input.operationId).not.toBe([...f.runs.keys()][0]);
      expect(f.requests.slice(start).filter(request => request.operation === "acknowledge")).toHaveLength(1);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(f.requests.slice(start).some(request => ["prepare", "prepare-media", "review-source-media"].includes(request.operation))).toBe(false);
    expect(f.runs.size).toBe(1);
    expect(await readFile(path.join(f.workspacePath, "counter.txt"), "utf8")).toBe("after");
  } finally { reserve.mockRestore(); }
});

it("matches the guest's ASCII-escaped Unicode snapshot digest and code point ordering", () => {
  expect(reviewSnapshotDigest([{ path: "public/😀.png", sha256: "a".repeat(64), executable: false }, { path: "public/角色.png", sha256: "b".repeat(64), executable: false }, { path: "public/\uffff.png", sha256: "c".repeat(64), executable: false }]))
    .toBe("c0d96bdee5a171b70c7d4fe59614173f8f560a23db63e93076fd1455baba9cde");
});

it.each([0, 1] as const)("runs a scripted Agent review/prepare/explicit-size/approval/adopt/read loop through real host tools; generation policy=%s", async policy => {
  const f = await retainedFixture({ policy }), manager = SessionManager.inMemory(f.workspacePath);
  const user = manager.appendMessage({ role: "user", content: "Recover the existing result without rerunning it", timestamp: 1 });
  const approvals: string[] = [];
  const recovery = createIsolatedRecoveryTool(async () => ({ state: "resident", dirty: true, recoverable: false, generation: "4", reason: "Image preparation is required" }),
    generation => f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), generation)), {
      review: generation => f.owned(() => f.execution.reviewSource(f.project, generation, async operation => operation())),
      optimize: (id, input, signal) => f.owned(() => f.execution.optimizeSourceReview(f.project, id, input, async operation => operation(), signal)),
      adopt: id => f.owned(async () => {
        const review = await f.execution.sourceReview(f.project, id);
        expect(validSourceConfirmation(review, { reviewId: id, filesReviewed: true, codeReviewed: false })).toBe(false);
        expect(validSourceConfirmation(review, { reviewId: id, filesReviewed: true, codeReviewed: true })).toBe(true); approvals.push(id);
        await f.execution.approveSourceReview(f.project, id, async operation => operation());
        return f.execution.recoverSource(f.project, async operation => operation(), review.generation, id);
      }),
    });
  const read = createLocalAgentFileTools(f.workspacePath, undefined, true).find(tool => tool.name === "read")!;
  const guard = new AutoContinueTools([recovery, read], { sessionManager: manager }); guard.reset(user); const tools = guard.wrap();
  const run = async (name: string, id: string, input: object) => {
    const tool = tools.find(candidate => candidate.name === name)!;
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], stopReason: "toolUse", timestamp: 2 } as never);
    const output = await testStage(id, () => tool.execute(id, input, undefined, undefined, { sessionManager: manager } as never));
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: output.content, details: output.details, isError: false, timestamp: 3 } as never);
    return output;
  };
  const tool = tools.find(candidate => candidate.name === recovery.name)!;
  await expect(tool.execute("stale-review", { action: "review", generation: "3" }, undefined, undefined, { sessionManager: manager } as never))
    .rejects.toSatisfy(error => getToolPreflightFailure(error)?.reason === "invalid_recovery_input");
  expect(f.requests.some(request => request.operation === "review-source-media")).toBe(false);
  await guard.prepare(new AbortController().signal);
  await run(recovery.name, "inspect", { action: "inspect" });
  const initial = (await run(recovery.name, "review", { action: "review", generation: "4" })).details as IsolatedSourceReview;
  expect(initial.reviewVersion).toBe(2); expect(initial.blockers).toEqual([]); expect(initial.preparedSnapshotId).toMatch(/^[a-f0-9]{64}$/);
  const stored = await readSourceReview(f.workspacePath, f.project.id, "test", initial.reviewId);
  expect((await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).equals(f.raw)).toBe(true);
  expect(stored.retained?.allOriginalsRetained).toBe(true);
  const preserved = (await run(recovery.name, "preserve-size", { action: "optimize", reviewId: initial.reviewId, paths: [f.image.path] })).details as IsolatedSourceReview;
  expect(preserved.files.find(file => file.path === f.image.path)?.optimization).toMatchObject({ originalRetained: true, originalWidth: 1024, originalHeight: 1024, workingSha256: f.image.sha256 });
  expect(preserved.blockers).toEqual([]);
  const ready = (await run(recovery.name, "explicit-size", { action: "optimize", reviewId: preserved.reviewId, paths: [f.image.path], maxEdge: 256 })).details as IsolatedSourceReview;
  expect(ready.blockers).toEqual([]); expect(ready.preparedSnapshotId).toMatch(/^[a-f0-9]{64}$/);
  await expect(readFile(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  const adopted = await run(recovery.name, "adopt", { action: "adopt", reviewId: ready.reviewId });
  expect((adopted.details as { changed: string[] }).changed).toEqual(expect.arrayContaining(["game.js", f.image.path])); expect(approvals).toEqual([ready.reviewId]);
  const viewed = await run("read", "view-working", { path: f.image.path }); expect(viewed.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  expect((await sharp(await readFile(path.join(f.workspacePath, f.image.path))).metadata()).width).toBe(256);
  expect((await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).equals(f.raw)).toBe(true);
  expect(f.runs.size).toBe(0); expect(f.requests.some(request => ["run", "prepare", "prepare-media"].includes(request.operation))).toBe(false);
  expect(f.requests.filter(request => request.operation === "acknowledge")).toHaveLength(1); expect((await f.execution.sourceReview(f.project, ready.reviewId)).completed).toBe(true);
});

it("returns confirmed manual v2 recovery without inventing an original command mapping", async () => {
  const f = await retainedFixture({ small: true, origins: false }), review = await approvedRetained(f);
  const result = await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId));
  expect(result.changed).toContain(f.image.path); expect(getIsolatedRepairProof(result)).toBeUndefined();
  expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).toBe(true); expect(f.runs.size).toBe(0);
});

it("retains the raw-to-working review and commits a verified no-op receipt when the approved working target already exists", async () => {
  const f = await retainedFixture({ small: true, noOp: true }), review = await approvedNoOp(f);
  const image = review.files.find(file => file.path === f.image.path)!;
  expect(review.files).toHaveLength(1); expect(image.kind).toBe("image"); expect(image.beforeSha256).toBe(image.afterSha256);
  expect(review.publicationUnchanged).toBe(true);
  const original = await readFile(path.join(f.workspacePath, f.image.path));
  const result = await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId));
  expect(result.changed).toEqual([]); expect(getIsolatedRepairProof(result)).toBeDefined();
  const manifest = JSON.parse(await readFile(path.join(path.dirname(f.workspacePath), result.recovery!, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ state: "committed", context: { snapshotId: f.snapshotId }, versions: [], verifiedReviewId: review.reviewId, targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await readFile(path.join(f.workspacePath, f.image.path))).toEqual(original);
  expect(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).toEqual(f.raw);
  await expect(f.execution.verifySourceReview(f.project, review.reviewId)).resolves.toMatchObject({ changed: [] });
  expect(f.runs.size).toBe(0);
});

it("refuses a no-op receipt when publication history reaches 2000 after approval, without acknowledging or deleting anything", async () => {
  const f = await retainedFixture({ small: true, noOp: true }), review = await approvedNoOp(f), root = path.join(path.dirname(f.workspacePath), "isolated-changes");
  await mkdir(root, { recursive: true });
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, async (_, offset) => {
    const directory = path.join(root, `00000000-0000-4000-8000-${String(start + offset).padStart(12, "0")}`); await mkdir(directory);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 2, state: "committed", versions: [], published: [], steps: {} }));
  }));
  await expect(f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId))).rejects.toMatchObject({ code: "RECOVERY_SPACE_REQUIRED", message: expect.stringContaining("available recovery capacity") });
  expect(await readdir(root)).toHaveLength(2000); expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  expect(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).toEqual(f.raw);
});

it("verifies a lost v2 ACK using only the original committed publication and exact released operation", async () => {
  const f = await retainedFixture({ small: true, lostAck: true }), review = await approvedRetained(f);
  const failure = await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId)).catch(cause => cause);
  const pending = getIsolatedRepairPending(failure);
  expect(pending).toMatchObject({ reviewId: review.reviewId, rawSnapshotId: f.snapshotId, publicationVerified: true, released: true });
  const before = f.requests.length;
  const result = await f.owned(() => f.execution.verifySourceReview(f.project, review.reviewId));
  expect(result.changed).toEqual([]); expect(getIsolatedRepairProof(result)).toBeDefined();
  expect(f.requests.slice(before).some(request => ["recover", "capture", "acknowledge", "release", "prepare"].includes(request.operation))).toBe(false);
  expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).toBe(true);
  expect(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).toEqual(f.raw);
});

it("does not grant verify-only pending evidence before publication or after an independent host conflict", async () => {
  const f = await retainedFixture({ small: true }), review = await approvedRetained(f);
  await writeFile(path.join(f.workspacePath, "game.js"), "Independent newer save");
  const failure = await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId)).catch(cause => cause);
  expect(failure.message).toContain("Host source changed"); expect(getIsolatedRepairPending(failure)).toBeUndefined();
  expect(await readFile(path.join(f.workspacePath, "game.js"), "utf8")).toBe("Independent newer save");
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  const before = f.requests.length;
  await expect(f.execution.verifySourceReview(f.project, review.reviewId)).rejects.toThrow("not confirmed complete"); expect(f.requests).toHaveLength(before);
});

it("does not contact the guest for an already cancelled recovery", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController();
  controller.abort();
  await expect(f.owned(() => f.execution.recoverSource(f.project, operation => operation(), "4", undefined, controller.signal))).rejects.toThrow();
  expect(f.requests).toEqual([]); expect(f.runs.size).toBe(0);
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not submit recovery when cancelled while its approval lookup is pending", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController();
  let respond!: () => void;
  const wait = new Promise<void>(resolve => { respond = resolve; });
  const lookup = vi.spyOn(sourceReview, "approvedSourceReview").mockImplementation(async () => { await wait; return undefined; });
  const task = f.owned(() => f.execution.recoverSource(f.project, operation => operation(), "4", undefined, controller.signal));
  const failure = task.catch(cause => cause);
  try {
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    controller.abort(); respond();
    expect(await failure).toBeInstanceOf(Error);
    expect(f.requests).toEqual([]); expect(f.runs.size).toBe(0);
    await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { respond(); lookup.mockRestore(); }
});

it("retains and releases a recovery cancelled while its guest reservation response is pending", async () => {
  const f = await retainedFixture({ small: true }), controller = new AbortController(), receipts: IsolatedOperationReceipt[] = [];
  let respond!: () => void;
  const wait = new Promise<void>(resolve => { respond = resolve; });
  f.handlers.set("recover", async (...args) => { await wait; return { ...await f.defaultResponse(...args) as object, rasterReturnVersion: 1 }; });
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
    () => f.owned(() => f.execution.recoverSource(f.project, operation => operation(), "4", undefined, controller.signal)));
  const failure = task.catch(cause => cause);
  try {
    await vi.waitFor(() => expect(f.requests.some(request => request.operation === "recover")).toBe(true));
    controller.abort(); respond();
    expect(await failure).toBeInstanceOf(Error);
    expect(receipts.map(receipt => receipt.phase)).toContain("retained");
    expect(receipts.at(-1)?.phase).toBe("released");
    expect(f.requests.filter(request => request.operation === "release")).toHaveLength(1);
    expect(f.requests.some(request => ["capture", "capture-media", "acknowledge"].includes(request.operation))).toBe(false);
    await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { respond(); }
});

it("retains approved image bytes and releases recovery when cancelled during capture", async () => {
  const f = await retainedFixture({ small: true }), review = await approvedRetained(f), controller = new AbortController();
  const receipts: IsolatedOperationReceipt[] = [];
  let respond!: () => void;
  const wait = new Promise<void>(resolve => { respond = resolve; });
  f.handlers.set("capture", async () => { await wait; return f.header(); });
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
    () => f.owned(() => f.execution.recoverSource(f.project, operation => operation(), "4", review.reviewId, controller.signal)));
  const failure = task.catch(cause => cause);
  try {
    await vi.waitFor(() => expect(f.requests.some(request => request.operation === "capture")).toBe(true));
    controller.abort(); respond(); expect(await failure).toBeInstanceOf(Error);
    expect(receipts.map(receipt => receipt.phase)).toContain("retained"); expect(receipts.at(-1)?.phase).toBe("released");
    expect(f.requests.filter(request => request.operation === "release")).toHaveLength(1);
    expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
    expect((await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).equals(f.raw)).toBe(true);
    await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).not.toBe(true);
    expect(await readdir(path.join(path.dirname(f.workspacePath), "isolated-space-reservations"))).toEqual([]);
  } finally { respond(); }
});

it("interrupts an in-flight policy 2 recovery stream without retaining partial data or acknowledging", async () => {
  const f = await captureMediaFixture("hold"), controller = new AbortController(), receipts: IsolatedOperationReceipt[] = [];
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 1, state: "resident", dirty: false, active: false });
  f.handlers.set("recover", async (...args) => ({ ...await f.defaultResponse(...args) as object, rasterReturnVersion: 2, captureVersion: 2 }));
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); },
    () => f.execution.recoverSource(f.project, operation => operation(), "1", undefined, controller.signal));
  const failure = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.requests.some(request => request.operation === "capture-media")).toBe(true));
  controller.abort(); expect(await failure).toBeInstanceOf(Error);
  expect(receipts.map(receipt => receipt.phase)).toContain("retained"); expect(receipts.at(-1)?.phase).toBe("released");
  expect(f.requests.filter(request => request.operation === "release")).toHaveLength(1);
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.runs.size).toBe(0);
});

it.each(["operation", "mode", "phase"] as const)("refuses a lost ACK verification with the wrong recovery %s without submitting another mutation", async invalidRecoveryOrigin => {
  const f = await retainedFixture({ small: true, lostAck: true, invalidRecoveryOrigin }), review = await approvedRetained(f);
  await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId)).catch(() => {});
  const before = f.requests.length;
  await expect(f.owned(() => f.execution.verifySourceReview(f.project, review.reviewId))).rejects.toThrow("acknowledgement and release are not confirmed");
  expect(f.requests.slice(before).some(request => ["recover", "capture", "acknowledge", "release", "prepare"].includes(request.operation))).toBe(false);
  expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).not.toBe(true);
});

it("does not turn a typed acknowledgement permission refusal into automatic verify-only authorization", async () => {
  const f = await retainedFixture({ small: true }), review = await approvedRetained(f);
  f.handlers.set("acknowledge", () => ({ error: { code: "PERMISSION_DENIED", message: "Fixture authority refused", changed: false } }));
  const failure = await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId)).catch(cause => cause);
  expect(failure.code).toBe("PERMISSION_DENIED"); expect(getIsolatedRepairPending(failure)).toBeUndefined();
  expect(f.requests.filter(request => request.operation === "release")).toHaveLength(1);
});

it("retains the original uncertain plan when reviewing after a lost ACK and refuses changed host targets during verification", async () => {
  const f = await retainedFixture({ small: true, lostAck: true }), review = await approvedRetained(f);
  await f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId)).catch(() => {});
  expect((await f.owned(() => f.execution.reviewSource(f.project, "4", async operation => operation()))).reviewId).toBe(review.reviewId);
  await writeFile(path.join(f.workspacePath, "game.js"), "Independent newer save");
  await expect(f.owned(() => f.execution.verifySourceReview(f.project, review.reviewId))).rejects.toThrow("host changed");
  expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).not.toBe(true);
});

it.each(["raw", "working"] as const)("refuses tampered immutable %s bytes before allocating a recovery operation", async kind => {
  const f = await retainedFixture({ small: true }), review = await approvedRetained(f), record = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId);
  const id = kind === "raw" ? f.image.sha256 : record.retained!.images[f.image.path]!.workingSha256!;
  const folder = kind === "working" && id === f.image.sha256 ? "raw" : kind;
  await writeFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts", folder, id), "tampered");
  const before = f.requests.length;
  await expect(f.owned(() => f.execution.recoverSource(f.project, async operation => operation(), "4", review.reviewId))).rejects.toThrow("artifact bytes changed");
  expect(f.requests).toHaveLength(before); expect(f.runs.size).toBe(0);
});

it("rejects review before retaining data when the 512 MiB recovery budget is full", async () => {
  const f = await retainedFixture({ small: true }), root = path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw");
  await mkdir(root, { recursive: true, mode: 0o700 }); const existing = path.join(root, "a".repeat(64)); await writeFile(existing, ""); await truncate(existing, 512 * 1024 * 1024);
  await expect(f.owned(() => f.execution.reviewSource(f.project, "4", async operation => operation()))).rejects.toMatchObject({ code: "RECOVERY_SPACE_REQUIRED" });
  expect((await stat(existing)).size).toBe(512 * 1024 * 1024);
  expect(await readdir(root)).toEqual(["a".repeat(64)]);
  expect(f.requests.some(request => ["recover", "acknowledge"].includes(request.operation))).toBe(false);
});

it.each(["snapshot", "duplicate-path", "per-file", "aggregate", "truncated", "trailing", "raw-hash", "origin"])("rejects malformed v2 %s transport before retaining or publishing any candidate", async variant => {
  const f = await retainedFixture({ small: true }), previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "review-source-media") return previous(...args);
    const child = new ChildProcess(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); children.push(child);
    child.stdin.once("finish", () => {
      const header = structuredClone(f.header()); let bytes = f.raw;
      if (variant === "snapshot") header.snapshotId = "d".repeat(64);
      if (variant === "duplicate-path") header.retainedRasters.push({ ...header.retainedRasters[0]! });
      if (variant === "per-file") header.retainedRasters[0]!.size = 33 * 1024 * 1024;
      if (variant === "aggregate") {
        header.files.push({ path: "public/copy-a.mp4", size: 32 * 1024 * 1024, sha256: "a".repeat(64) }, { path: "public/copy-b.mp4", size: 32 * 1024 * 1024, sha256: "b".repeat(64) });
        header.snapshotId = reviewSnapshotDigest([...header.files, ...header.retainedRasters]);
      }
      if (variant === "truncated") bytes = f.raw.subarray(0, -1);
      if (variant === "trailing") bytes = Buffer.concat([f.raw, Buffer.of(1)]);
      if (variant === "raw-hash") bytes = Buffer.alloc(f.raw.length, 1);
      if (variant === "origin") header.originOperations[0]!.snapshotId = "e".repeat(64);
      (child.stdout as PassThrough).end(Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), bytes])); queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  });
  await expect(f.owned(() => f.execution.reviewSource(f.project, "4", async operation => operation()))).rejects.toThrow();
  await expect(stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.requests.some(request => ["recover", "capture", "acknowledge", "prepare"].includes(request.operation))).toBe(false); expect(f.runs.size).toBe(0);
});

it("reserves the concurrent job limit after asynchronous path checks", async () => {
  const { execution, project, workspacePath } = await fixture();
  const projects = await Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const id = project.id.slice(0, -1) + index;
      const target = path.join(
        path.dirname(path.dirname(workspacePath)),
        id,
        "workspace",
      );
      await mkdir(target, { recursive: true });
      return { ...project, id, workspacePath: target };
    }),
  );
  const results = await Promise.allSettled(
    projects.map((value) =>
      execution.start(value, "build", value.workspacePath),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(2);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(spawn.mock.calls.filter((call) => call[1][8] === "run")).toHaveLength(
    2,
  );
  const env = spawn.mock.calls[0][2].env;
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  expect(env.HOME).toContain("/.runtime/local-execution/home");
});

it("inspects retained changes without preparing, reserving, or acknowledging guest work", async () => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, limits: resourceLimits }));
  const secret = "retained-inspection-secret-canary";
  registerSensitiveValue(secret);
  const value = { namespace: "test", projectId: f.project.id, generation: 4, complete: true, excluded: 2, blockers: 1,
    changes: [{ path: "public/new.mp4", kind: "blocked", size: 3 * 1024 * 1024, reason: `Unverified media ${secret}` }] };
  f.handlers.set("inspect-source", () => value);
  const result = await f.execution.inspectSource(f.project, 4);
  expect(result).toMatchObject({ generation: 4, complete: true, excluded: 2, blockers: 1 });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(f.requests.map(request => request.operation)).toEqual(["health", "inspect-source"]);
  f.handlers.set("inspect-source", () => ({ ...value, generation: 5 }));
  await expect(f.execution.inspectSource(f.project, 4)).rejects.toThrow("Invalid retained");
  f.handlers.set("inspect-source", () => ({ ...value, complete: false, blockers: 0 }));
  await expect(f.execution.inspectSource(f.project, 4)).rejects.toThrow("Invalid retained");
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, limits: resourceLimits }));
  await expect(f.execution.inspectSource(f.project, 4)).resolves.toBeUndefined();
});

it.each([undefined, 0, 2, false, null])("refuses unverified raster inspection rule version %s on a capable guest", async version => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, rasterReturnVersion: 1, limits: resourceLimits }));
  f.handlers.set("inspect-source", () => ({ namespace: "test", projectId: f.project.id, generation: 4, complete: true, changes: [], excluded: 0, blockers: 0,
    rasterInspectionVersion: version, rasterReturnVersion: 1 }));
  await expect(f.execution.inspectSource(f.project, 4)).rejects.toThrow("metadata cannot establish recoverability");
  expect(f.requests.map(request => request.operation)).toEqual(["health", "inspect-source"]);
});

it.each([undefined, 2, false, null])("refuses raster generation policy %s without guessing it from guest health", async version => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, rasterReturnVersion: 1, limits: resourceLimits }));
  f.handlers.set("inspect-source", () => ({ namespace: "test", projectId: f.project.id, generation: 4, complete: true, changes: [], excluded: 0, blockers: 0,
    rasterInspectionVersion: 1, rasterReturnVersion: version }));
  await expect(f.execution.inspectSource(f.project, 4)).rejects.toThrow("metadata cannot establish recoverability");
});

it.each([0, 1] as const)("returns verified metadata rules for generation raster policy %s without guessing media-copy validity from size", async version => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, rasterReturnVersion: 1, limits: resourceLimits }));
  const value = { namespace: "test", projectId: f.project.id, generation: 4, complete: true, changes: [{ path: "public/copy.png", kind: "added", size: 3 * 1024 * 1024 }], excluded: 0, blockers: 0,
    rasterInspectionVersion: 1, rasterReturnVersion: version };
  f.handlers.set("inspect-source", () => value);
  await expect(f.execution.inspectSource(f.project, 4)).resolves.toEqual(value);
  expect(f.requests.every(request => !["recover", "capture", "acknowledge", "prepare"].includes(request.operation))).toBe(true);
});

it.each([{ rasterInspectionVersion: 0 }, { rasterInspectionVersion: 1 }, { rasterReturnVersion: 0 }])("does not accept invalid or incomplete inspection versions on a legacy guest: %o", async rules => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, limits: resourceLimits }));
  f.handlers.set("inspect-source", () => ({ namespace: "test", projectId: f.project.id, generation: 4, complete: true, changes: [], excluded: 0, blockers: 0, ...rules }));
  await expect(f.execution.inspectSource(f.project, 4)).rejects.toThrow("inspection rule version");
});

it.each([true, false])("continues after a confirmed VM lease refusal and preserves unknown startup failures (confirmed=%s)", async confirmed => {
  const message = "The isolated VM has an existing lifecycle lease";
  const ready = vi.fn().mockRejectedValueOnce(confirmed ? isolatedVmLeaseBusyError(message) : new Error(message));
  const f = await fixture("test", { ready, close: vi.fn() });
  const shell = createIsolatedShellTool((command, timeout, signal) => f.execution.shell(f.project, command, timeout, fn => fn(), signal));
  const manager = SessionManager.inMemory(f.workspacePath);
  const user = manager.appendMessage({ role: "user", content: "Measure the standing images", timestamp: 1 });
  const args = { command: "measure" };
  manager.appendMessage({ role: "assistant", api: "ohmygame-native", content: [{ type: "toolCall", id: "original", name: shell.name, arguments: args }], timestamp: 2 } as never);
  const guard = new AutoContinueTools([shell], { sessionManager: manager }); guard.reset(user);
  const invoke = (tools: AutoContinueTools, id: string) => tools.wrap()[0]!.execute(id, args, undefined, undefined, {} as never);
  const failure = await invoke(guard, "original").catch(cause => cause);
  const isolatedOperations = getIsolatedOperationReceipts(failure);
  manager.appendMessage({ role: "toolResult", toolName: shell.name, toolCallId: "original", content: [{ type: "text", text: message }], isError: true, timestamp: 3, isolatedOperations } as never);
  expect(f.requests).toHaveLength(0);
  expect(isolatedCommandsNotSubmitted(isolatedOperations)).toBe(confirmed);
  const restored = new AutoContinueTools([shell], { sessionManager: manager }); restored.reset(user);
  if (!confirmed) {
    await expect(restored.prepare(new AbortController().signal)).rejects.toThrow("unconfirmed");
    return;
  }
  expect(isolatedOperations?.at(-1)).toMatchObject({ phase: "input_rejected", rejection: "vm_lease_busy" });
  expect(guard.stopRequested).toBe(false);
  await restored.prepare(new AbortController().signal);
  await expect(invoke(restored, "original")).rejects.toThrow(message);
  expect(ready).toHaveBeenCalledOnce();
  const next = invoke(restored, "after-release");
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  f.completeRun([...f.runs.keys()][0]!);
  await expect(next).resolves.toMatchObject({ details: { changed: [] } });
});

it.each([false, true])("records only a command-scoped rejection for an initial budget and submits no prepare, command or cancellation; separate runtime=%s", async separated => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: separated ? 1 : 0, limits: resourceLimits }));
  await mkdir(path.join(f.workspacePath, "public"));
  for (let index = 0; index < 3; index++) {
    const file = path.join(f.workspacePath, `public/image-${index}.png`); await writeFile(file, ""); await truncate(file, 23 * 1024 * 1024);
  }
  const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () =>
    f.execution.shell(f.project, "fixture-only", 5, async operation => operation())).catch(cause => cause);
  expect(isIsolatedInputBudgetError(failure)).toBe(true); expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(true);
  if (!separated) expect(failure.message).toContain("legacy source limits");
  expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "input_rejected"]);
  expect(receipts[1]).toMatchObject({ scope: "project_command", projectId: f.project.id, namespace: "test", rejection: "input_budget" });
  expect(receipts[0]!.operationId).toMatch(/^[a-f0-9]{32}$/); expect(receipts[1]!.operationId).toBe(receipts[0]!.operationId);
  expect(f.requests.map(request => request.operation)).toEqual(["health"]); expect(f.runs.size).toBe(0);
  await rm(path.join(f.workspacePath, "public"), { recursive: true });
  const child = await f.execution.start(f.project, "build", f.workspacePath); f.completeRun([...f.runs.keys()][0]!); await f.execution.settled(child);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(1);
});

it.each(["Isolated runtime media exceeds its 32 MiB per-file or 64 MiB total limit", "Isolated source transfer budget exceeded"])("does not accept a callback's forged budget wording or descriptor as proof of an unsubmitted correctable command: %s", async message => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  const forged = Object.assign(new Error(message), { rejection: "input_budget", effect: "none" });
  const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () =>
    f.execution.start(f.project, "build", f.workspacePath, [], undefined, { files: async () => { throw forged; } })).catch(cause => cause);
  expect(failure.message).toContain(message); expect(isIsolatedInputBudgetError(failure)).toBe(false); expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(false);
  expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight"]); expect(f.requests.map(request => request.operation)).toEqual(["health"]); expect(f.runs.size).toBe(0);
});

it.each(["input_preflight", "prepare_submitting", "run_submitting"] as const)("does not cross the %s barrier when its receipt cannot be recorded", async phase => {
  const f = await fixture();
  const failure = await withIsolatedOperationScope(async history => { if (history.at(-1)!.phase === phase) throw new Error("Journal unavailable"); }, () =>
    f.execution.start(f.project, "build", f.workspacePath)).catch(cause => cause);
  expect(failure.message).toContain("could not be safely recorded"); expect(f.runs.size).toBe(0);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(phase === "run_submitting" ? 1 : 0);
  expect(f.requests.filter(request => request.operation === "cancel")).toHaveLength(phase === "run_submitting" ? 1 : 0);
  if (phase === "input_preflight") expect(f.requests).toEqual([]);
});

it.each(["prepare_submitting", "run_submitting"] as const)("rechecks project cancellation after the asynchronous %s receipt barrier", async phase => {
  const f = await fixture(); let entered = false, resume!: () => void;
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const task = withIsolatedOperationScope(async history => { if (history.at(-1)!.phase === phase) { entered = true; await hold; } }, () =>
    f.execution.start(f.project, "build", f.workspacePath));
  const failed = expect(task).rejects.toThrow(/being deleted|closing/);
  await vi.waitFor(() => expect(entered).toBe(true)); const stopped = f.execution.quiesceProject(f.project.id); resume();
  await failed; await stopped; expect(f.runs.size).toBe(0);
  expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(phase === "run_submitting" ? 1 : 0);
  expect(f.requests.filter(request => request.operation === "cancel")).toHaveLength(phase === "run_submitting" ? 1 : 0);
});

it("binds confirmed source publication receipts to the original operation, generation and snapshot without recording its lease", async () => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  f.handlers.set("capture", input => ({ files: [sourceFile("created.js", "created")], baselineFiles: [], snapshotId: "b".repeat(64), generation: input.generation }));
  const pending = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.execution.shell(f.project, "fixture-only", 5, async operation => operation()));
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!);
  await expect(pending).resolves.toMatchObject({ changed: ["created.js"] });
  expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "published", "acknowledged", "released"]);
  expect(new Set(receipts.map(receipt => receipt.operationId)).size).toBe(1);
  expect(receipts.slice(2).every(receipt => receipt.generation === 1)).toBe(true); expect(receipts.slice(5).every(receipt => receipt.snapshotId === "b".repeat(64))).toBe(true);
  expect(JSON.stringify(receipts)).not.toContain("leaseToken"); expect(JSON.stringify(receipts)).not.toContain("e".repeat(32)); expect(JSON.stringify(receipts)).not.toContain("fixture-only");
});

it("keeps the same typed budget error retained after a command ran and its host baseline later exceeds the budget", async () => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, limits: resourceLimits }));
  f.handlers.set("capture", async input => {
    await mkdir(path.join(f.workspacePath, "public"));
    const file = path.join(f.workspacePath, "public/late.png"); await writeFile(file, ""); await truncate(file, 33 * 1024 * 1024);
    return { files: [sourceFile("created.js", "guest")], baselineFiles: [], snapshotId: "b".repeat(64), generation: input.generation };
  });
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.execution.shell(f.project, "fixture-only", 5, async operation => operation()));
  const failed = task.catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!); const failure = await failed;
  expect(failure.message).toContain("32 MiB per-file or 64 MiB total limit"); expect(isIsolatedInputBudgetError(failure)).toBe(true);
  expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(false);
  const evidence = receipts.map(receipt => receipt.phase); expect(evidence).toContain("captured"); expect(evidence).toContain("retained"); expect(evidence).not.toContain("input_rejected");
  expect(receipts.find(receipt => receipt.phase === "retained")).toMatchObject({ generation: 1, snapshotId: "b".repeat(64) });
  expect(isolatedCommandsNotSubmitted(receipts)).toBe(false); expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  await expect(stat(path.join(f.workspacePath, "created.js"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps concurrent project receipts in their original async scopes even when completion is emitted from outside both calls", async () => {
  const f = await fixture(), histories: IsolatedOperationReceipt[][] = [[], []];
  const second = { ...f.project, id: f.project.id.slice(0, -1) + "5", workspacePath: path.join(path.dirname(path.dirname(f.workspacePath)), f.project.id.slice(0, -1) + "5", "workspace") };
  await mkdir(second.workspacePath, { recursive: true });
  const pending = [f.project, second].map((project, index) => withIsolatedOperationScope(async history => { histories[index]!.splice(0, histories[index]!.length, ...history); }, async () => {
    const child = await f.execution.start(project, "build", project.workspacePath); await f.execution.settled(child);
  }));
  await vi.waitFor(() => expect(f.runs.size).toBe(2)); for (const id of f.runs.keys()) f.completeRun(id);
  await Promise.all(pending);
  for (const [index, project] of [f.project, second].entries()) {
    expect(histories[index]!.every(receipt => receipt.projectId === project.id)).toBe(true); expect(histories[index]!.at(-1)!.phase).toBe("released");
  }
  expect(histories[0]![0]!.operationId).not.toBe(histories[1]![0]!.operationId);
});

it("keeps a successful running preview alive and records its later release in the original scope rather than the stopping call", async () => {
  const f = await fixture(), original: IsolatedOperationReceipt[] = [], other: IsolatedOperationReceipt[] = [], late: boolean[] = [];
  const child = await withIsolatedOperationScope(async (history, detached) => { original.splice(0, original.length, ...history); late.push(detached); }, () =>
    f.execution.start(f.project, "preview", f.workspacePath, ["run", "dev"], 18080));
  expect(original.at(-1)!.phase).toBe("running"); expect(f.runs.size).toBe(1); expect(child.killed).toBe(false);
  await withIsolatedOperationScope(async history => { other.splice(0, other.length, ...history); }, () => f.execution.stop(child));
  expect(other).toEqual([]); expect(original.at(-1)!.phase).toBe("released"); expect(late.at(-1)).toBe(true);
  expect(new Set(original.map(receipt => receipt.operationId)).size).toBe(1);
});

it.each([false, true])("records the artifact recovery and publication path and refuses an unrecorded export barrier: fail=%s", async fail => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 3, state: "resident", dirty: false, active: false });
  const task = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); if (fail && history.at(-1)!.phase === "run_submitting") throw new Error("Journal failed"); }, () => f.execution.artifacts(f.project));
  if (fail) {
    await expect(task).rejects.toThrow("could not be safely recorded"); expect(f.requests.some(request => request.operation === "export")).toBe(false);
  } else {
    await task;
    expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "prepare_submitting", "prepared", "run_submitting", "captured", "published", "released"]);
    expect(receipts.slice(1).every(receipt => receipt.generation === 3 && receipt.snapshotId === undefined)).toBe(true);
  }
  expect(f.requests.filter(request => request.operation === "recover")).toHaveLength(1); expect(f.requests.filter(request => request.operation === "release")).toHaveLength(1);
});

it("does not publish captured source when its snapshot receipt cannot be durably recorded", async () => {
  const f = await fixture();
  f.handlers.set("capture", input => ({ files: [sourceFile("created.js", "guest")], baselineFiles: [], snapshotId: "b".repeat(64), generation: input.generation }));
  const task = withIsolatedOperationScope(async history => { if (history.at(-1)!.phase === "captured") throw new Error("Journal failed"); }, () =>
    f.execution.shell(f.project, "fixture-only", 5, async operation => operation()));
  const failed = expect(task).rejects.toThrow("could not be safely recorded");
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!); await failed;
  await expect(stat(path.join(f.workspacePath, "created.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false); expect(f.requests.some(request => request.operation === "release")).toBe(true);
});

it.each(["generation", "lease"])("rejects a changed known cancellation %s binding without replacing the original operation identity", async kind => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = []; let child!: ChildProcess;
  f.handlers.set("cancel", input => ({ stopped: true, operation: { ...f.operations.get(input.operationId), ...(kind === "generation" ? { generation: 2 } : { leaseToken: "f".repeat(32) }) } }));
  const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, async () => {
    child = await f.execution.start(f.project, "build", f.workspacePath); await f.execution.stop(child);
  }).catch(cause => cause);
  expect(failure.message).toContain("cancellation binding changed"); expect(receipts.some(receipt => receipt.phase === "released")).toBe(false);
  expect(receipts.every(receipt => receipt.generation === undefined || receipt.generation === 1)).toBe(true); expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(false);
  f.handlers.delete("cancel"); await f.execution.stop(child);
  expect(f.requests.filter(request => request.operation === "cancel").map(request => request.input.generation)).toEqual([1, 1]);
});

it("discovers the original reservation binding during cancellation after an unverified preparation response", async () => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  f.handlers.set("prepare", async (...args) => { await f.defaultResponse(...args); return { prepared: true }; });
  const failure = await withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.execution.start(f.project, "build", f.workspacePath)).catch(cause => cause);
  expect(failure.message).toBe("Invalid isolated operation binding"); expect(f.runs.size).toBe(0);
  const prepare = f.requests.find(request => request.operation === "prepare")!, cancel = f.requests.find(request => request.operation === "cancel")!;
  expect(cancel.input).toEqual({ namespace: "test", projectId: f.project.id, operationId: prepare.input.operationId });
  expect(receipts.at(-1)).toMatchObject({ phase: "released", generation: 1, operationId: prepare.input.operationId });
  expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(false); expect(JSON.stringify(receipts)).not.toContain("leaseToken");
});

it("streams only requested runtime media and restores a renamed build copy without using guest paths as host inputs", async () => {
  const f = await fixture();
  const mediaPath = "public/scene.mp4", movie = Buffer.alloc(3 * 1024 * 1024);
  movie.write("ftypisom", 4);
  await mkdir(path.join(f.workspacePath, "public"));
  await writeFile(path.join(f.workspacePath, mediaPath), movie);
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, runtimeMediaVersion: 1, limits: resourceLimits }));
  const previous = spawn.getMockImplementation()!;
  const transfers: Buffer[][] = [];
  const headers: Array<{files: Array<{path: string; data?: string; size?: number; sha256: string}>; operationId: string}> = [];
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "prepare-media") return previous(...args);
    const child = new ChildProcess();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let header: typeof headers[number];
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      if (header) { chunks.push(Buffer.from(chunk)); return; }
      header = JSON.parse(chunk.toString());
      headers.push(header);
      const paths = transfers.length ? [] : [mediaPath];
      queueMicrotask(() => (child.stdout as PassThrough).write(JSON.stringify({ needMedia: paths }) + "\n"));
    });
    child.stdin.once("finish", async () => {
      transfers.push(chunks);
      const command = [...args[1]]; command[8] = "prepare";
      const result = await f.defaultResponse(header, child, command);
      (child.stdout as PassThrough).end(JSON.stringify(result));
      queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  });
  for (const source of ["first", "second"]) {
    await writeFile(path.join(f.workspacePath, "game.js"), source);
    const child = await f.execution.start(f.project, "build", f.workspacePath);
    f.completeRun(headers.at(-1)!.operationId);
    await f.execution.settled(child);
  }
  const declared = headers[0]!.files.find(file => file.path === mediaPath)!;
  expect(declared).toEqual({ path: mediaPath, size: movie.length, sha256: createHash("sha256").update(movie).digest("hex") });
  expect(headers[1]!.files).toContainEqual(declared);
  expect(transfers[0]!.every(chunk => chunk.length <= 512 * 1024)).toBe(true);
  expect(Buffer.concat(transfers[0]!)).toEqual(movie);
  expect(transfers[1]).toEqual([]);
  f.handlers.set("export", () => ({ files: [], media: [{ ...declared, path: "dist/intro.mp4" }] }));
  await f.execution.artifacts(f.project);
  expect(await readFile(path.join(f.workspacePath, "dist/intro.mp4"))).toEqual(movie);

  const preview = await f.execution.start(f.project, "preview", f.workspacePath, ["run", "dev"], 18080);
  await writeFile(path.join(f.workspacePath, "dist/intro.mp4"), "rebuild");
  expect(await f.execution.previewSourceMatches(preview, f.project)).toBe(true);
  movie[movie.length - 1] = 1;
  await writeFile(path.join(f.workspacePath, mediaPath), movie);
  expect(await f.execution.previewSourceMatches(preview, f.project)).toBe(false);
  movie[movie.length - 1] = 0;
  await writeFile(path.join(f.workspacePath, mediaPath), movie);
  expect(await f.execution.previewSourceMatches(preview, f.project)).toBe(true);
  await writeFile(path.join(f.workspacePath, "game.js"), "third");
  expect(await f.execution.previewSourceMatches(preview, f.project)).toBe(false);
});

it("receives new build media, keeps copied media local, and publishes only a complete verified export", async () => {
  const f = await fixture();
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, buildMediaVersion: 1, limits: resourceLimits }));
  const run = await f.execution.start(f.project, "build", f.workspacePath);
  f.completeRun([...f.runs.keys()][0]!);
  await f.execution.settled(run);
  const copied = Buffer.from("....ftypisomsource");
  await mkdir(path.join(f.workspacePath, "public"));
  await writeFile(path.join(f.workspacePath, "public/original.mp4"), copied);
  const generated = Buffer.alloc(3 * 1024 * 1024, 0xc3);
  generated.write("ftypisom", 4);
  const sound = Buffer.from("RIFF....WAVEencoded");
  const entry = (file: string, bytes: Buffer) => ({ path: file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const copy = entry("dist/assets/copy.mp4", copied);
  const movie = entry("dist/assets/recoded.mp4", generated);
  const wav = entry("build/sound.wav", sound);
  const manifest = { files: [], media: [copy], generatedMedia: [movie, wav] };
  let header = JSON.stringify(manifest), body = Buffer.concat([generated, sound]), status = 0;
  const previous = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "export-media") return previous(...args);
    const child = new ChildProcess();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.once("finish", () => {
      const output = child.stdout as PassThrough;
      output.write(header.slice(0, 9));
      output.write(Buffer.concat([Buffer.from(header.slice(9) + "\n"), body.subarray(0, 17)]));
      output.end(body.subarray(17));
      queueMicrotask(() => child.emit("close", status));
    });
    return child;
  });
  await f.execution.artifacts(f.project);
  const result = path.join(f.workspacePath, movie.path);
  expect(await readFile(result)).toEqual(generated);
  expect(await readFile(path.join(f.workspacePath, wav.path))).toEqual(sound);
  expect(await readFile(path.join(f.workspacePath, copy.path))).toEqual(copied);
  const keep = path.join(f.workspacePath, "dist/previous.txt");
  await writeFile(keep, "keep the accepted build");
  await expect(f.execution.artifacts(f.project, f.workspacePath, { playable: true })).rejects.toThrow("previous local output was preserved");
  expect(await readFile(keep, "utf8")).toBe("keep the accepted build");
  const original = body;
  for (const invalid of [body.subarray(0, -1), Buffer.concat([body, Buffer.of(1)]), Buffer.alloc(body.length)]) {
    body = invalid;
    await expect(f.execution.artifacts(f.project)).rejects.toThrow();
    expect(await readFile(keep, "utf8")).toBe("keep the accepted build");
  }
  body = original;
  status = 1;
  await expect(f.execution.artifacts(f.project)).rejects.toThrow("export failed");
  expect(await readFile(keep, "utf8")).toBe("keep the accepted build");
  status = 0;
  header = JSON.stringify({ ...manifest, generatedMedia: [{ ...movie, path: copy.path }] });
  await expect(f.execution.artifacts(f.project)).rejects.toThrow("destination");
  const credential = "test-generated-media-private-credential";
  registerSensitiveValue(credential);
  const privateMovie = Buffer.from("....ftypisom" + credential);
  header = JSON.stringify({ files: [], generatedMedia: [entry(movie.path, privateMovie)] });
  body = privateMovie;
  await expect(f.execution.artifacts(f.project)).rejects.toThrow("Protected");
  expect(await readFile(keep, "utf8")).toBe("keep the accepted build");
  header = JSON.stringify({ error: { code: "CONTROL_FAILED", message: "Generated media exceeds the 32 MiB limit", changed: false } });
  status = 1;
  body = Buffer.alloc(0);
  await expect(f.execution.artifacts(f.project)).rejects.toThrow("32 MiB limit");
  expect(await readFile(keep, "utf8")).toBe("keep the accepted build");
});

it("prepares a nested package lock and keeps install cwd without requiring a root manifest", async () => {
  const { execution, project, workspacePath } = await fixture();
  const nested = path.join(workspacePath, "games/demo");
  await mkdir(nested, { recursive: true });
  await writeFile(
    path.join(nested, "package.json"),
    JSON.stringify({ name: "nested-fixture", version: "1.0.0" }),
  );
  await writeFile(
    path.join(nested, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
  );
  let prepared = "";
  let launched = "";
  const implementation = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const child = implementation(...args);
    child.stdin!.on("data", (chunk: Buffer) => {
      if (args[1][8] === "prepare") prepared += chunk;
      if (args[1][8] === "run") launched += chunk;
    });
    return child;
  });
  await execution.start(project, "install", nested);
  expect(JSON.parse(prepared)).toMatchObject({
    packages: [],
    files: expect.arrayContaining([
      expect.objectContaining({ path: "games/demo/package.json" }),
      expect.objectContaining({ path: "games/demo/package-lock.json" }),
    ]),
  });
  expect(JSON.parse(launched)).toMatchObject({
    mode: "install",
    cwd: "games/demo",
  });
});

it("registers only the two fixed canonical stores and refuses a linked escape", async () => {
  const { workspacePath } = await fixture();
  const root = path.dirname(path.dirname(workspacePath));
  for (const name of ["test-data", "manual-data"]) {
    const store = path.join(root, name);
    await mkdir(path.join(store, "projects"), { recursive: true });
    expect(await isolatedProjectStore(root, store)).toEqual({
      directory: path.join(store, "projects"),
      manual: name === "manual-data",
    });
  }
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "projects"), { recursive: true });
  await expect(isolatedProjectStore(root, outside)).rejects.toThrow(
    "not configured",
  );
  await rm(path.join(root, "manual-data/projects"), { recursive: true });
  await symlink(
    path.join(outside, "projects"),
    path.join(root, "manual-data/projects"),
  );
  await expect(
    isolatedProjectStore(root, path.join(root, "manual-data")),
  ).rejects.toThrow("not configured");
});

async function lifecycle(
  status: string = "Stopped",
  failStart = false,
  failStop = false,
) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-vm-lifecycle-")),
  );
  directories.push(directory);
  const commands: string[][] = [];
  let state = status;
  let gate: { operation: string; wait: Promise<void> } | undefined;
  spawn.mockImplementation((_command, args) => {
    commands.push(args);
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    queueMicrotask(async () => {
      if (gate && gate.operation === args[0]) await gate.wait;
      if (args[0] === "start") state = "Running";
      if (args[0] === "stop" && !failStop) state = "Stopped";
      child.stdout!.push(
        args[0] === "list"
          ? JSON.stringify({ name: "omg", status: state })
          : "",
      );
      child.stdout!.push(null);
      child.emit(
        "close",
        (failStart && args[0] === "start") || (failStop && args[0] === "stop")
          ? 1
          : 0,
      );
    });
    return child;
  });
  const launchId = "e78ff150-0830-4625-9bfa-69db5539f015";
  const vm = new IsolatedVmLifecycle(directory, launchId);
  return { vm, directory, launchId, commands,
    setState: (value: string) => { state = value; },
    setFailStart: (value: boolean) => { failStart = value; },
    holdCommand: (operation: string, wait: Promise<void>) => { gate = { operation, wait }; },
  };
}

it("starts the existing manual VM once, writes its ownership receipt and stops only that owned VM", async () => {
  const { vm, directory, launchId, commands } = await lifecycle();
  await Promise.all([vm.ready(), vm.ready()]);
  expect(commands).toEqual([
    ["list", "--json", "omg"],
    ["start", "--tty=false", "omg"],
    ["list", "--json", "omg"],
  ]);
  const receipt = path.join(directory, "manual-vm.lock/owner.json");
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
    version: 1,
    instance: "omg",
    ownerPid: process.pid,
    ownerParentPid: process.ppid,
    ownerLaunchId: launchId,
    state: "owned",
  });
  expect((await stat(receipt)).mode & 0o777).toBe(0o600);
  const env = spawn.mock.calls[0]![2].env;
  expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  await Promise.all([vm.close(), vm.close()]);
  expect(commands.slice(3)).toEqual([
    ["stop", "omg"],
    ["list", "--json", "omg"],
  ]);
  await expect(stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(vm.ready()).rejects.toThrow("closing");
});

it("borrows a running VM without an ownership receipt or stopping it", async () => {
  const { vm, directory, commands } = await lifecycle("Running");
  await vm.ready();
  await vm.close();
  expect(commands).toEqual([["list", "--json", "omg"]]);
  await expect(
    stat(path.join(directory, "manual-vm.lock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["Stopped", "Running"])("rechecks a previously successful %s VM and shares a same-instance restart", async (initial) => {
  const f = await lifecycle(initial);
  await f.vm.ready();
  const oldStarts = f.commands.filter((args) => args[0] === "start").length;
  f.setState("Stopped");
  const first = f.vm.ready(), second = f.vm.ready();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(f.commands.filter((args) => args[0] === "start")).toHaveLength(oldStarts + 1);
  const receipt = path.join(f.directory, "manual-vm.lock/owner.json");
  const saved = await readFile(receipt, "utf8");
  const inode = (await stat(receipt)).ino;
  const count = f.commands.length;
  await f.vm.ready();
  expect(f.commands.slice(count)).toEqual([["list", "--json", "omg"]]);
  expect(await readFile(receipt, "utf8")).toBe(saved);
  expect((await stat(receipt)).ino).toBe(inode);
  await f.vm.close();
  expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(1);
});

it.each([
  ["version", 2], ["instance", "other"], ["sessionId", "foreign-session"],
  ["ownerLaunchId", "a78ff150-0830-4625-9bfa-69db5539f015"],
  ["ownerPid", -1], ["ownerParentPid", -1], ["state", "foreign"],
] as const)("refuses a changed %s receipt without stopping a VM or clearing the receipt", async (field, value) => {
  const f = await lifecycle();
  await f.vm.ready();
  const receipt = path.join(f.directory, "manual-vm.lock/owner.json");
  const changed = { ...JSON.parse(await readFile(receipt, "utf8")), [field]: value };
  await writeFile(receipt, JSON.stringify(changed));
  const saved = await readFile(receipt, "utf8"), count = f.commands.length;
  const rejected = f.vm.ready();
  await expect(rejected).rejects.toThrow("lease changed");
  expect(f.vm.ready()).toBe(rejected);
  await expect(f.vm.close()).rejects.toThrow("lease changed");
  expect(f.commands).toHaveLength(count);
  expect(await readFile(receipt, "utf8")).toBe(saved);
});

it.each(["public-file", "public-directory", "linked-file", "hardlinked-file", "linked-directory"])(
  "refuses unsafe %s lease attributes before reusing or stopping its VM", async (kind) => {
    const f = await lifecycle();
    await f.vm.ready();
    const lock = path.join(f.directory, "manual-vm.lock"), receipt = path.join(lock, "owner.json");
    const saved = await readFile(receipt, "utf8"), count = f.commands.length;
    if (kind === "public-file") await chmod(receipt, 0o644);
    if (kind === "public-directory") await chmod(lock, 0o755);
    if (kind === "linked-file") {
      await rename(receipt, receipt + ".original");
      await symlink(receipt + ".original", receipt);
    }
    if (kind === "hardlinked-file") await link(receipt, receipt + ".other-link");
    if (kind === "linked-directory") {
      await rename(lock, lock + ".original");
      await symlink(lock + ".original", lock);
    }
    await expect(f.vm.ready()).rejects.toThrow("lease changed");
    await expect(f.vm.close()).rejects.toThrow("lease changed");
    expect(f.commands).toHaveLength(count);
    expect(await readFile(receipt, "utf8")).toBe(saved);
  },
);

it("latches a failed fresh start without another attempt and keeps confirmed cleanup possible", async () => {
  const f = await lifecycle();
  await f.vm.ready();
  f.setState("Stopped");
  f.setFailStart(true);
  const rejected = f.vm.ready();
  await expect(rejected).rejects.toThrow(/unavailable|control command failed/);
  const receipt = path.join(f.directory, "manual-vm.lock/owner.json");
  expect(JSON.parse(await readFile(receipt, "utf8")).state).toBe("starting");
  const count = f.commands.length;
  f.setState("Running"); f.setFailStart(false);
  expect(f.vm.ready()).toBe(rejected);
  await expect(f.vm.ready()).rejects.toThrow();
  expect(f.commands).toHaveLength(count);
  await f.vm.close();
  expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(1);
  await expect(stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["Running", "Stopped"])("rechecks a recovered read-only VM status without restarting it (initial=%s)", async initial => {
  const f = await lifecycle(initial);
  await f.vm.ready();
  f.setState("Unknown");
  await expect(f.vm.ready()).rejects.toThrow("unavailable");
  if (initial === "Running") await expect(stat(path.join(f.directory, "manual-vm.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  const count = f.commands.length;
  f.setState("Running");
  await f.vm.ready();
  expect(f.commands.slice(count)).toEqual([["list", "--json", "omg"]]);
  await f.vm.close();
  expect(f.commands.filter(args => args[0] === "start" || args[0] === "stop")).toHaveLength(initial === "Running" ? 0 : 2);
});

it.each(["Stopped", "Running"])("does not restart a previously successful %s VM after close begins during fresh status", async (initial) => {
  const f = await lifecycle(initial);
  await f.vm.ready();
  f.setState("Stopped");
  let release!: () => void;
  f.holdCommand("list", new Promise<void>((resolve) => { release = resolve; }));
  const starts = f.commands.filter((args) => args[0] === "start").length, count = f.commands.length;
  const preparing = f.vm.ready();
  const rejected = expect(preparing).rejects.toThrow("closing");
  await vi.waitFor(() => expect(f.commands.length).toBe(count + 1));
  const closing = f.vm.close();
  release();
  await Promise.all([rejected, closing]);
  expect(f.commands.filter((args) => args[0] === "start")).toHaveLength(starts);
  expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(initial === "Stopped" ? 1 : 0);
  await expect(stat(path.join(f.directory, "manual-vm.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.vm.ready()).rejects.toThrow("closing");
});

it("waits for an in-flight fresh restart before stopping its own VM", async () => {
  const f = await lifecycle();
  await f.vm.ready();
  f.setState("Stopped");
  let release!: () => void;
  f.holdCommand("start", new Promise<void>((resolve) => { release = resolve; }));
  const preparing = f.vm.ready();
  await vi.waitFor(() => expect(f.commands.filter((args) => args[0] === "start")).toHaveLength(2));
  const closing = f.vm.close();
  expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(0);
  release();
  await Promise.all([preparing, closing]);
  expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(1);
  await expect(stat(path.join(f.directory, "manual-vm.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed for an old lifecycle lease or missing launch identity", async () => {
  const { vm, directory, commands } = await lifecycle();
  await mkdir(path.join(directory, "manual-vm.lock"));
  await expect(vm.ready()).rejects.toThrow("existing lifecycle lease");
  expect(commands).toEqual([]);
  expect(() => new IsolatedVmLifecycle(directory, "")).toThrow(
    "launch identity",
  );
});

it("can acquire a lease after a confirmed competing owner releases it", async () => {
  const f = await lifecycle();
  const next = new IsolatedVmLifecycle(f.directory, f.launchId);
  await f.vm.ready();
  const commands = f.commands.length;
  await expect(next.ready()).rejects.toThrow("existing lifecycle lease");
  expect(f.commands).toHaveLength(commands);
  await f.vm.close();
  await next.ready();
  expect(f.commands.filter((args) => args[0] === "start")).toHaveLength(2);
  await next.close();
});

it("retries VM readiness after the lease directory becomes available", async () => {
  const f = await lifecycle();
  await rename(f.directory, f.directory + "-unavailable");
  try { await expect(f.vm.ready()).rejects.toThrow("lease could not be created"); }
  finally { await rename(f.directory + "-unavailable", f.directory); }
  expect(f.commands).toEqual([]);
  await f.vm.ready();
  expect(f.commands.filter(args => args[0] === "start")).toHaveLength(1);
  await f.vm.close();
});

it("does not create an unavailable VM and retains an uncertain start receipt for confirmed cleanup", async () => {
  const unavailable = await lifecycle("Unknown");
  await expect(unavailable.vm.ready()).rejects.toThrow(
    "creation and downloads are disabled",
  );
  expect(unavailable.commands).toEqual([["list", "--json", "omg"]]);
  await unavailable.vm.close();
  const { vm, directory, commands } = await lifecycle("Stopped", true);
  await expect(vm.ready()).rejects.toThrow("control command failed");
  expect(
    JSON.parse(
      await readFile(path.join(directory, "manual-vm.lock/owner.json"), "utf8"),
    ).state,
  ).toBe("starting");
  await vm.close();
  expect(commands.some((args) => args[0] === "stop")).toBe(true);
});

it("retains a valid owned receipt and lifecycle lock when stop cannot be confirmed", async () => {
  const { vm, directory, launchId, commands } = await lifecycle(
    "Stopped",
    false,
    true,
  );
  await vm.ready();
  await expect(vm.close()).rejects.toThrow("control command failed");
  expect(
    JSON.parse(
      await readFile(path.join(directory, "manual-vm.lock/owner.json"), "utf8"),
    ),
  ).toMatchObject({ ownerLaunchId: launchId, state: "owned" });
  expect(commands.filter((args) => args[0] === "stop")).toHaveLength(1);
  await expect(vm.ready()).rejects.toThrow("closing");
});

it("redacts a credential split between VM output frames", async () => {
  const { execution, project, workspacePath } = await fixture();
  let raw!: PassThrough;
  const implementation = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const child = implementation(...args);
    raw = child.stdout;
    return child;
  });
  const secret = "isolated-output-secret-canary";
  registerSensitiveValue(secret);
  const child = await execution.start(project, "build", workspacePath);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  for (const text of ["before isolated-output-", "secret-canary after"]) {
    raw.write(
      JSON.stringify({
        kind: "stdout",
        data: Buffer.from(text).toString("base64"),
      }) + "\n",
    );
  }
  child.emit("close", 0);
  expect(output).toBe("before [redacted] after");
});

it("serves updated page and media bytes on concurrent preview opens after an edit", async () => {
  const f = await fixture();
  const project: ProjectState = { ...f.project, type: "web-game", preview: { status: "stopped" } };
  await mkdir(path.join(f.workspacePath, "node_modules"));
  await writeFile(path.join(f.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
  const page = path.join(f.workspacePath, "index.html");
  const video = path.join(f.workspacePath, "intro.mp4");
  const clip = Buffer.from("....ftypisomV1");
  await writeFile(page, "<p>First title</p>");
  await writeFile(video, clip);
  let snapshot = new Map<string, Buffer>();
  f.handlers.set("prepare", (input, child, args) => {
    snapshot = new Map(input.files.map((file: { path: string; data: string }) => [file.path, Buffer.from(file.data, "base64")]));
    return f.defaultResponse(input, child, args);
  });
  // Only the guest is simulated. Its server can see exactly what prepare sent, never the live workspace.
  const server = createServer((req, res) => {
    const media = req.url === "/intro.mp4";
    res.setHeader("Content-Type", media ? "video/mp4" : "text/html");
    res.end(snapshot.get(media ? "intro.mp4" : "index.html"));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  vi.spyOn(f.execution, "ready").mockResolvedValue(undefined);
  vi.spyOn(f.execution, "connection").mockImplementation(() => createConnection((server.address() as AddressInfo).port, "127.0.0.1"));
  const matches = vi.spyOn(f.execution, "previewSourceMatches");
  const preview = new PreviewManager(new RuntimeEventBus(), { execution: f.execution });
  try {
    const url = await preview.ensureStarted(project, false);
    const movieUrl = new URL("/intro.mp4", url);
    expect(await (await fetch(url)).text()).toContain("First title");
    expect(Buffer.from(await (await fetch(movieUrl)).arrayBuffer())).toEqual(clip);
    await writeFile(page, "<p>Second title</p>");
    const replacement = Buffer.from("....ftypisomV2");
    await writeFile(video, replacement);
    expect(await (await fetch(url)).text()).toContain("First title");
    expect(await Promise.all([preview.ensureStarted(project, false), preview.ensureStarted(project)])).toEqual([url, url]);
    expect(matches).toHaveBeenCalledOnce();
    expect(await (await fetch(url)).text()).toContain("Second title");
    expect(Buffer.from(await (await fetch(movieUrl)).arrayBuffer())).toEqual(replacement);
    expect(await preview.ensureStarted(project)).toBe(url);
    expect(f.requests.filter(request => request.operation === "prepare")).toHaveLength(2);
  } finally {
    await preview.stopAll();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("handles a late proxy pipe failure after the HTTP consumer has detached", async () => {
  const { execution, project, workspacePath } = await fixture();
  let raw!: PassThrough;
  const implementation = spawn.getMockImplementation()!;
  spawn.mockImplementation((...args) => {
    const child = implementation(...args);
    raw = child.stdout;
    return child;
  });
  const child = await execution.start(
    project,
    "preview",
    workspacePath,
    ["run", "dev"],
    18080,
  );
  const operationId = spawn.mock.calls.find(
    (call) => call[1][8] === "run",
  )![1][9];
  raw.write(JSON.stringify({ kind: "ready", id: operationId }) + "\n");
  await execution.ready(child);
  const stream = execution.connection(child);
  // No request-owned error listener remains once a response has completed.
  expect(stream.listenerCount("error")).toBeGreaterThan(0);
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  children.at(-1)!.stdout!.destroy(new Error("late SSH pipe close"));
  await closed;
});

it("queues preview bursts within eight connections and cancels waiting requests", async () => {
  const { execution, project, workspacePath } = await fixture();
  const implementation = spawn.getMockImplementation()!;
  const proxies: ChildProcess[] = [];
  spawn.mockImplementation((...args) => {
    if (args[1][8] !== "proxy") return implementation(...args);
    const proxy = new ChildProcess();
    proxy.stdin = new PassThrough();
    proxy.stdout = new PassThrough();
    proxy.stderr = new PassThrough();
    proxies.push(proxy);
    return proxy;
  });
  const child = await execution.start(project, "preview", workspacePath, ["run", "dev"], 18080);
  const streams = Array.from({ length: 40 }, () => execution.connection(child));
  expect(proxies).toHaveLength(8);
  expect(() => execution.connection(child)).toThrow("queue is full");
  const closed = new Promise<void>((resolve) => streams[0]!.once("close", resolve));
  streams[0]!.destroy();
  await closed;
  expect(proxies).toHaveLength(9);
  // Cancelling a queued request must not start an extra guest transport.
  const queuedClosed = new Promise<void>((resolve) => streams.at(-1)!.once("close", resolve));
  streams.at(-1)!.destroy();
  await queuedClosed;
  expect(proxies).toHaveLength(9);
  await execution.stop(child);
  await vi.waitFor(() => expect(streams.every((stream) => stream.destroyed)).toBe(true));
  expect(proxies).toHaveLength(9);
});

it("confirms guest cancellation before closing its owned VM and refuses later tasks", async () => {
  const { project, workspacePath, handlers, defaultResponse } = await fixture();
  const order: string[] = [];
  const vm = {
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(async () => {
      order.push("vm-close");
    }),
  };
  const execution = Reflect.construct(IsolatedProjectExecution, [
    path.dirname(path.dirname(workspacePath)),
    vm,
  ]) as IsolatedProjectExecution;
  handlers.set("cancel", (input, child, args) => {
    order.push("guest-cancel");
    return defaultResponse(input, child, args);
  });
  await execution.start(project, "build", workspacePath);
  await execution.close();
  expect(order).toEqual(["guest-cancel", "vm-close"]);
  await expect(
    execution.start(project, "build", workspacePath),
  ).rejects.toThrow("closing");
});

it("refuses legacy guest health before preparing or running anything", async () => {
  const { execution, project, workspacePath, handlers, requests } =
    await fixture();
  handlers.set("health", () => ({ backend: "lima-vz-cgroup-v1", node: true }));
  const failure = await withIsolatedOperationScope(async () => {}, () => execution.start(project, "build", workspacePath)).catch(cause => cause);
  expect(failure).toMatchObject({ code: "PROTOCOL_MISMATCH", changed: false });
  expect(getIsolatedOperationReceipts(failure)?.at(-1)).toMatchObject({ phase: "input_rejected", rejection: "readiness_check" });
  expect(isolatedCommandsNotSubmitted(getIsolatedOperationReceipts(failure))).toBe(true);
  expect(requests.map((r) => r.operation)).toEqual(["health"]);
});

it("reports migration-required health as a protocol blocker without preparing data", async () => {
  const f = await fixture();
  f.handlers.set("health", () => ({
    protocolVersion: 2,
    ready: false,
    migrationRequired: true,
    limits: resourceLimits,
    error: "Legacy storage requires review",
  }));
  await expect(
    f.execution.start(f.project, "build", f.workspacePath),
  ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH", changed: false });
  expect(f.requests.map((r) => r.operation)).toEqual(["health"]);
});

it.each([
  { namespace: "manual", active: false, state: "resident" },
  { namespace: "test", active: "unknown", state: "resident" },
  { namespace: "test", active: false, state: "unknown" },
])(
  "refuses storage inventory with an unverified scope or activity state: %o",
  async (record) => {
    const f = await fixture();
    f.projects.set(f.project.id, {
      projectId: f.project.id,
      generation: 1,
      dirty: false,
      ...record,
    });
    await expect(f.execution.inventoryProject(f.project)).rejects.toThrow(
      "Invalid isolated project storage record",
    );
    expect(f.requests.filter((r) => r.operation === "retire")).toHaveLength(0);
  },
);

it("binds namespace, preallocated operation identity and generation through prepare and run", async () => {
  const f = await fixture("manual");
  const child = await f.execution.start(f.project, "build", f.workspacePath);
  const prepared = f.requests.find((r) => r.operation === "prepare")!.input;
  expect(prepared).toMatchObject({
    namespace: "manual",
    projectId: f.project.id,
    mode: "build",
  });
  expect(prepared.operationId).toMatch(/^[a-f0-9]{32}$/);
  expect([...f.runs.keys()]).toEqual([prepared.operationId]);
  expect(f.operations.get(prepared.operationId)).toMatchObject({
    namespace: "manual",
    generation: 1,
    leaseToken: "e".repeat(32),
  });
  f.completeRun(prepared.operationId);
  await f.execution.settled(child);
  expect(f.requests.find((r) => r.operation === "release")!.input).toEqual(
    f.operations.get(prepared.operationId),
  );
});

it("quiesces a prepare in flight without letting a late run start", async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  let payload: any;
  f.handlers.set("prepare", (input) => {
    payload = input;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const starting = f.execution.start(f.project, "build", f.workspacePath);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const stopped = f.execution.quiesceProject(f.project.id);
  finish(
    await f.defaultResponse(payload, new ChildProcess(), [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "prepare",
    ]),
  );
  await expect(starting).rejects.toThrow("being deleted");
  await stopped;
  expect(f.runs.size).toBe(0);
  expect(f.requests.find((r) => r.operation === "cancel")!.input).toMatchObject(
    {
      namespace: "test",
      projectId: f.project.id,
      operationId: payload.operationId,
    },
  );
  await expect(
    f.execution.start(f.project, "build", f.workspacePath),
  ).rejects.toThrow("being deleted");
  f.execution.resumeProject(f.project.id);
});

it("deletion preserves a typed guest refusal even when preflight inventory is clean", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, {
    projectId: f.project.id,
    namespace: "test",
    generation: 7,
    state: "resident",
    dirty: false,
    active: false,
  });
  f.handlers.set("retire", () => ({
    error: {
      code: "RECOVERY_REQUIRED",
      message: "Unsynced source remains",
      changed: false,
    },
  }));
  await f.execution.quiesceProject(f.project.id);
  const beforeRetire = vi.fn().mockResolvedValue(undefined);
  await expect(
    f.execution.retireProject(f.project, beforeRetire),
  ).rejects.toMatchObject({
    code: "RECOVERY_REQUIRED",
    changed: false,
  });
  expect(f.requests.find((r) => r.operation === "retire")!.input).toEqual({
    namespace: "test",
    projectId: f.project.id,
    generation: 7,
    confirmation: "DELETE_PROJECT_VOLUME",
  });
  expect(beforeRetire).toHaveBeenCalledOnce();
  f.execution.resumeProject(f.project.id);
});

it("only dispatches dirty storage retirement after confirmation of the current generation", async () => {
  const f = await fixture();
  const retained = {
    projectId: f.project.id,
    namespace: "test",
    generation: 7,
    state: "recovery-pending",
    dirty: true,
    active: false,
  };
  f.projects.set(f.project.id, retained);
  await f.execution.quiesceProject(f.project.id);
  const beforeRetire = vi.fn().mockResolvedValue(undefined);
  await expect(f.execution.retireProject(f.project, beforeRetire)).rejects.toMatchObject({ generation: "7" });
  f.projects.set(f.project.id, { ...retained, generation: 8 });
  await expect(f.execution.retireProject(f.project, beforeRetire, "7")).rejects.toMatchObject({ generation: undefined });
  f.projects.delete(f.project.id);
  await expect(f.execution.retireProject(f.project, beforeRetire, "8")).rejects.toMatchObject({ generation: undefined });
  expect(beforeRetire).not.toHaveBeenCalled();
  expect(f.requests.filter(request => request.operation === "retire")).toEqual([]);

  f.projects.set(f.project.id, { ...retained, generation: 8 });
  await expect(f.execution.retireProject(f.project, beforeRetire, "8")).resolves.toEqual({ deleted: true });
  expect(beforeRetire).toHaveBeenCalledOnce();
  expect(f.requests.filter(request => request.operation === "retire").map(request => request.input)).toEqual([{
    namespace: "test",
    projectId: f.project.id,
    generation: 8,
    confirmation: "DELETE_PROJECT_VOLUME",
    discardUnsynced: true,
  }]);
});

it("prepares a stopped VM before fresh absence verification, then stages exactly one retirement", async () => {
  let running = false;
  let finishReady!: () => void;
  const order: string[] = [];
  const vm = {
    ready: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("ready");
          finishReady = () => {
            running = true;
            resolve();
          };
        }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const f = await fixture("manual", vm);
  f.handlers.set("health", (...args) => {
    if (!running)
      throw new Error("instance `omg` is stopped, run `limactl start omg`");
    order.push("health");
    return f.defaultResponse(...args);
  });
  for (const operation of ["inventory", "retire"])
    f.handlers.set(operation, (...args) => {
      order.push(operation);
      return f.defaultResponse(...args);
    });
  const beforeRetire = vi.fn(async () => {
    order.push("stage");
  });
  await f.execution.quiesceProject(f.project.id);
  const retiring = f.execution.retireProject(f.project, beforeRetire);
  await vi.waitFor(() => expect(vm.ready).toHaveBeenCalledOnce());
  expect(f.requests).toEqual([]);
  expect(beforeRetire).not.toHaveBeenCalled();
  finishReady();
  await expect(retiring).resolves.toEqual({
    deleted: true,
    absent: true,
  });
  expect(order).toEqual(["ready", "health", "inventory", "stage", "retire"]);
  expect(f.requests.map((request) => request.operation)).toEqual([
    "health",
    "inventory",
    "retire",
  ]);
  expect(f.requests[2].input).toEqual({
    namespace: "manual",
    projectId: f.project.id,
    confirmation: "DELETE_PROJECT_VOLUME",
  });
  expect(beforeRetire).toHaveBeenCalledOnce();
  expect(vm.close).not.toHaveBeenCalled();
});

it.each(["start", "health", "protocol", "inventory", "malformed-inventory"])(
  "safely refuses %s preparation failures before journaling or requesting retirement",
  async (failure) => {
    const vm = {
      ready: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const f = await fixture("manual", vm);
    if (failure === "start")
      vm.ready.mockRejectedValue(new Error("/private/path raw Lima failure"));
    if (failure === "health" || failure === "inventory")
      f.handlers.set(failure, () => {
        throw new Error("/private/path raw Lima failure");
      });
    if (failure === "protocol")
      f.handlers.set("health", () => ({ protocolVersion: 1, ready: true }));
    if (failure === "malformed-inventory")
      f.handlers.set("inventory", () => ({
        protocolVersion: 2,
        namespace: "manual",
        projects: [{ projectId: f.project.id }],
      }));
    const beforeRetire = vi.fn().mockResolvedValue(undefined);
    await f.execution.quiesceProject(f.project.id);
    const error = await f.execution
      .retireProject(f.project, beforeRetire)
      .catch((error) => error);
    expect(error).toMatchObject({
      code: "EXECUTION_RETIREMENT_UNAVAILABLE",
      changed: false,
    });
    expect(error.message).not.toMatch(/private\/path|Lima|limactl/);
    expect(beforeRetire).not.toHaveBeenCalled();
    expect(f.requests.some((request) => request.operation === "retire")).toBe(
      false,
    );
  },
);

it("does not send retirement if its durable stage callback fails", async () => {
  const f = await fixture();
  const failure = new Error("journal write failed");
  const beforeRetire = vi.fn().mockRejectedValue(failure);
  await f.execution.quiesceProject(f.project.id);
  await expect(f.execution.retireProject(f.project, beforeRetire)).rejects.toBe(
    failure,
  );
  expect(beforeRetire).toHaveBeenCalledOnce();
  expect(f.requests.map((request) => request.operation)).toEqual([
    "health",
    "inventory",
  ]);
});

it.each(["GENERATION_CHANGED", "ACTIVE_OPERATION", "DELETE_UNCERTAIN"])(
  "preserves the guest %s result after the retirement stage",
  async (code) => {
    const f = await fixture();
    const changed = code === "DELETE_UNCERTAIN";
    f.projects.set(f.project.id, {
      projectId: f.project.id,
      namespace: "test",
      generation: 7,
      state: "resident",
      dirty: false,
      active: false,
    });
    f.handlers.set("retire", () => ({
      error: {
        code,
        message: "Guest retirement refused or uncertain",
        changed,
      },
    }));
    const beforeRetire = vi.fn().mockResolvedValue(undefined);
    await f.execution.quiesceProject(f.project.id);
    await expect(
      f.execution.retireProject(f.project, beforeRetire),
    ).rejects.toMatchObject({ code, changed });
    expect(beforeRetire).toHaveBeenCalledOnce();
    const requests = f.requests.filter(
      (request) => request.operation === "retire",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({
      namespace: "test",
      projectId: f.project.id,
      generation: 7,
      confirmation: "DELETE_PROJECT_VOLUME",
    });
  },
);

it.each([{}, { deleted: false }, undefined])(
  "does not retry an unconfirmed retirement response (%#)",
  async (response) => {
    const f = await fixture();
    f.handlers.set("retire", () => response);
    const beforeRetire = vi.fn().mockResolvedValue(undefined);
    await f.execution.quiesceProject(f.project.id);
    await expect(
      f.execution.retireProject(f.project, beforeRetire),
    ).rejects.toThrow(/not confirmed|Invalid isolated control response/);
    expect(beforeRetire).toHaveBeenCalledOnce();
    expect(
      f.requests.filter((request) => request.operation === "retire"),
    ).toHaveLength(1);
  },
);

it("refuses retirement once the execution backend is closed", async () => {
  const vm = {
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const f = await fixture("manual", vm);
  const beforeRetire = vi.fn().mockResolvedValue(undefined);
  await f.execution.quiesceProject(f.project.id);
  await f.execution.close();
  await expect(
    f.execution.retireProject(f.project, beforeRetire),
  ).rejects.toMatchObject({
    code: "EXECUTION_RETIREMENT_UNAVAILABLE",
    changed: false,
  });
  expect(vm.ready).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
  expect(beforeRetire).not.toHaveBeenCalled();
});

it("does not inspect or retire storage after shutdown during VM startup", async () => {
  let finishReady!: () => void;
  const vm = {
    ready: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReady = resolve;
        }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const f = await fixture("manual", vm);
  const beforeRetire = vi.fn().mockResolvedValue(undefined);
  await f.execution.quiesceProject(f.project.id);
  const retiring = f.execution.retireProject(f.project, beforeRetire);
  const failure = expect(retiring).rejects.toMatchObject({
    code: "EXECUTION_RETIREMENT_UNAVAILABLE",
    changed: false,
  });
  await vi.waitFor(() => expect(vm.ready).toHaveBeenCalledOnce());
  await f.execution.close();
  finishReady();
  await failure;
  expect(f.requests).toEqual([]);
  expect(beforeRetire).not.toHaveBeenCalled();
});

it("does not journal or retire storage after shutdown during its inventory read", async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  f.handlers.set(
    "inventory",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const beforeRetire = vi.fn().mockResolvedValue(undefined);
  await f.execution.quiesceProject(f.project.id);
  const retiring = f.execution.retireProject(f.project, beforeRetire);
  const failure = expect(retiring).rejects.toMatchObject({
    code: "EXECUTION_RETIREMENT_UNAVAILABLE",
    changed: false,
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await f.execution.close();
  finish({ protocolVersion: 2, namespace: "test", projects: [] });
  await failure;
  expect(beforeRetire).not.toHaveBeenCalled();
  expect(f.requests.some((request) => request.operation === "retire")).toBe(
    false,
  );
});

it.each(["close", "resume", "new-epoch"])(
  "does not send a late retirement after %s during journaling",
  async (change) => {
    const f = await fixture();
    let finish!: () => void;
    const beforeRetire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await f.execution.quiesceProject(f.project.id);
    const retiring = f.execution.retireProject(f.project, beforeRetire);
    const failure = expect(retiring).rejects.toMatchObject({
      code: "EXECUTION_RETIREMENT_UNAVAILABLE",
      changed: false,
    });
    await vi.waitFor(() => expect(beforeRetire).toHaveBeenCalledOnce());
    if (change === "close") await f.execution.close();
    else {
      f.execution.resumeProject(f.project.id);
      if (change === "new-epoch")
        await f.execution.quiesceProject(f.project.id);
    }
    finish();
    await failure;
    expect(f.requests.some((request) => request.operation === "retire")).toBe(
      false,
    );
  },
);

it("publishes guarded source before its exact snapshot acknowledgement and release", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  const before = sourceFile("counter.txt", "before"),
    after = sourceFile("counter.txt", "after");
  f.handlers.set("capture", (input) => ({
    files: [after],
    baselineFiles: [before],
    snapshotId: "b".repeat(64),
    generation: input.generation,
  }));
  f.handlers.set("acknowledge", async () => {
    expect(
      await readFile(path.join(f.workspacePath, "counter.txt"), "utf8"),
    ).toBe("after");
    return { acknowledged: true };
  });
  const result = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const op = [...f.runs.keys()][0];
  f.completeRun(op);
  await expect(result).resolves.toMatchObject({ changed: ["counter.txt"] });
  const calls = f.requests.filter((r) =>
    ["capture", "acknowledge", "release"].includes(r.operation),
  );
  expect(calls.map((r) => r.operation)).toEqual([
    "capture",
    "acknowledge",
    "release",
  ]);
  expect(calls[1].input).toEqual({
    ...f.operations.get(op),
    snapshotId: "b".repeat(64),
  });
});

it("retries only the idempotent acknowledgement after a lost response", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("capture", (input) => ({
    files: [sourceFile("counter.txt", "after")],
    baselineFiles: [sourceFile("counter.txt", "before")],
    snapshotId: "b".repeat(64),
    generation: input.generation,
  }));
  let attempts = 0;
  f.handlers.set("acknowledge", () => {
    if (++attempts === 1)
      throw new Error("ACK response lost after application");
    return { acknowledged: true };
  });
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  f.completeRun([...f.runs.keys()][0]);
  await task;
  const acknowledgements = f.requests.filter(
    (r) => r.operation === "acknowledge",
  );
  expect(acknowledgements).toHaveLength(2);
  expect(acknowledgements[0].input).toEqual(acknowledgements[1].input);
  expect(f.requests.filter((r) => r.operation === "prepare")).toHaveLength(1);
  expect(f.runs.size).toBe(1);
});

it("can reconcile an unknown ACK without preparing or rerunning the task", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("capture", (input) => ({
    files: [sourceFile("counter.txt", "after")],
    baselineFiles: [sourceFile("counter.txt", "before")],
    snapshotId: "b".repeat(64),
    generation: input.generation,
  }));
  f.handlers.set("acknowledge", () => {
    throw new Error("ACK response unavailable");
  });
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  const failed = expect(task).rejects.toThrow("ACK response unavailable");
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  f.completeRun([...f.runs.keys()][0]);
  await failed;
  expect(
    await readFile(path.join(f.workspacePath, "counter.txt"), "utf8"),
  ).toBe("after");
  f.handlers.delete("acknowledge");
  await expect(
    f.execution.recoverSource(f.project, async (operation) => operation(), "1"),
  ).resolves.toEqual({ changed: [] });
  expect(f.requests.filter((r) => r.operation === "prepare")).toHaveLength(1);
  expect(f.runs.size).toBe(1);
});

it("retains both sides when host source changed before capture and refuses unsafe recovery", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("capture", async (input) => {
    await writeFile(path.join(f.workspacePath, "counter.txt"), "external");
    return {
      files: [sourceFile("counter.txt", "guest")],
      baselineFiles: [sourceFile("counter.txt", "before")],
      snapshotId: "b".repeat(64),
      generation: input.generation,
    };
  });
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  const failed = expect(task).rejects.toThrow("host workspace changed");
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  f.completeRun([...f.runs.keys()][0]);
  await failed;
  expect(
    await readFile(path.join(f.workspacePath, "counter.txt"), "utf8"),
  ).toBe("external");
  await expect(
    f.execution.recoverSource(f.project, async (operation) => operation(), "1"),
  ).rejects.toThrow("both versions are retained");
  expect(f.requests.filter((r) => r.operation === "acknowledge")).toHaveLength(
    0,
  );
  expect(f.runs.size).toBe(1);
});

it("recovers media copies while preserving newer host files untouched by the guest", async () => {
  const f = await fixture();
  const model = Buffer.alloc(3 * 1024 * 1024);
  model.write("glTF"); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8);
  await mkdir(path.join(f.workspacePath, "assets/generated"), { recursive: true });
  await writeFile(path.join(f.workspacePath, "assets/generated/hunter.glb"), model);
  await writeFile(path.join(f.workspacePath, "main.js"), "newer host code");
  const media = { path: "assets/generated/hunter.glb", size: model.length, sha256: createHash("sha256").update(model).digest("hex") };
  const copied = { ...media, path: "public/models/hunter.glb" };
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 1, state: "recovery-pending", dirty: true, active: false });
  f.handlers.set("capture", input => ({
    files: [sourceFile("main.js", "old guest code"), media, copied],
    baselineFiles: [sourceFile("main.js", "old guest code"), media],
    snapshotId: "b".repeat(64), generation: input.generation,
  }));
  const result = await f.execution.recoverSource(f.project, operation => operation(), "1");
  expect(result.changed).toEqual([copied.path]);
  expect(await readFile(path.join(f.workspacePath, "main.js"), "utf8")).toBe("newer host code");
  expect(await readFile(path.join(f.workspacePath, copied.path))).toEqual(model);
  // A lost ACK is recovered without repeating the copy or reverting newer host work.
  await expect(f.execution.recoverSource(f.project, operation => operation(), "1")).resolves.toEqual({ changed: [] });
  expect(f.requests.filter(request => request.operation === "acknowledge")).toHaveLength(2);
  expect(f.requests.some(request => ["prepare", "prepare-media", "run"].includes(request.operation))).toBe(false);
});

it.each([0, 1] as const)("binds raster return policy %i, preserves originals and never reruns a command after a lost ACK", async policy => {
  const f = await fixture();
  const original = await sharp({ create: { width: 48, height: 48, channels: 4, background: "#33553388" } }).png().toBuffer();
  const after = await sharp(original).resize(24, 24).png().toBuffer();
  await mkdir(path.join(f.workspacePath, "public"));
  await writeFile(path.join(f.workspacePath, "public/forest.png"), original);
  const media = { path: "public/forest.png", size: original.length, sha256: createHash("sha256").update(original).digest("hex") };
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 22, state: "recovery-pending", dirty: true, active: false });
  f.handlers.set("recover", async (...args) => ({ ...await f.defaultResponse(...args) as object, rasterReturnVersion: policy }));
  f.handlers.set("capture", input => ({ files: [{ path: media.path, data: after.toString("base64"), sha256: createHash("sha256").update(after).digest("hex"), executable: false, rasterBaseSha256: media.sha256 }],
    baselineFiles: [media], snapshotId: "b".repeat(64), generation: input.generation, rasterReturnVersion: policy }));
  if (!policy) {
    await expect(f.execution.recoverSource(f.project, operation => operation(), "22")).rejects.toThrow("runtime asset changed");
    expect(await readFile(path.join(f.workspacePath, media.path))).toEqual(original);
    expect(f.requests.some(r => r.operation === "acknowledge")).toBe(false);
  } else {
    f.handlers.set("acknowledge", () => { throw new Error("lost mock ACK"); });
    await expect(f.execution.recoverSource(f.project, operation => operation(), "22")).rejects.toThrow();
    expect(await readFile(path.join(f.workspacePath, media.path))).toEqual(after);
    f.handlers.delete("acknowledge");
    await expect(f.execution.recoverSource(f.project, operation => operation(), "22")).resolves.toMatchObject({ changed: [] });
  }
  expect(f.requests.some(r => ["prepare", "prepare-media", "run"].includes(r.operation))).toBe(false);
});

it("refuses a capture that changes its negotiated raster policy before acknowledging anything", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 2, state: "recovery-pending", dirty: true, active: false });
  f.handlers.set("capture", input => ({ files: [], baselineFiles: [], snapshotId: "b".repeat(64), generation: input.generation, rasterReturnVersion: 1 }));
  await expect(f.execution.recoverSource(f.project, operation => operation(), "2")).rejects.toThrow();
  expect(f.requests.some(r => r.operation === "acknowledge")).toBe(false);
});

async function legacyReviewFixture(separateMedia = true) {
  const f = await fixture();
  const original = await sharp({ create: { width: 48, height: 48, channels: 4, background: "#22552288" } }).png().toBuffer();
  const after = await sharp(original).resize(24, 24).png().toBuffer();
  await mkdir(path.join(f.workspacePath, "public"));
  await writeFile(path.join(f.workspacePath, "public/forest.png"), original);
  const media = { path: "public/forest.png", size: original.length, sha256: createHash("sha256").update(original).digest("hex") };
  const raster = (name: string) => ({ path: name, data: after.toString("base64"), sha256: createHash("sha256").update(after).digest("hex"), executable: false });
  const files = [{ ...raster(media.path), ...(separateMedia ? { rasterBaseSha256: media.sha256 } : {}) }, raster("public/hunter.png"), sourceFile("public/sprites.json", '["hunter.png"]'), sourceFile("tools/artprep.py", "print('retained code, never executed by recovery')")];
  const before = separateMedia ? media : { path: media.path, data: original.toString("base64"), sha256: media.sha256, executable: false };
  f.handlers.set("health", () => ({ protocolVersion: 2, ready: true, sourceInspectionVersion: 1, legacyReviewVersion: 1, limits: resourceLimits }));
  f.projects.set(f.project.id, { namespace: "test", projectId: f.project.id, generation: 22, state: "recovery-pending", dirty: true, active: false });
  f.handlers.set("review-source", input => ({ namespace: "test", projectId: f.project.id, generation: input.generation, snapshotId: "b".repeat(64), files, baselineFiles: [before] }));
  f.handlers.set("recover", async (...args) => {
    const binding = { ...await f.defaultResponse(...args) as object, rasterReturnVersion: args[0].reviewSnapshotId ? 1 : 0 };
    f.operations.set(args[0].operationId, binding); return binding;
  });
  f.handlers.set("capture", input => ({ generation: input.generation, snapshotId: "b".repeat(64), files, baselineFiles: [before], rasterReturnVersion: input.rasterReturnVersion ?? 0 }));
  return { ...f, original, after, files, media };
}

it.each([true, false])("preserves the actual legacy transfer profile and reviewed permissions; separated=%s", async separated => {
  const f = await legacyReviewFixture(separated);
  await chmod(path.join(f.workspacePath, f.media.path), 0o640);
  const review = await f.execution.reviewSource(f.project, "22", operation => operation());
  expect(review.blockers).toEqual([]);
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  await f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId);
  expect((await stat(path.join(f.workspacePath, f.media.path))).mode & 0o777).toBe(separated ? 0o600 : 0o640);
});

it("reviews a legacy batch without a lease or source writes, then adopts only its approved snapshot", async () => {
  const f = await legacyReviewFixture();
  const review = await f.execution.reviewSource(f.project, "22", operation => operation());
  expect(review.blockers).toEqual([]);
  expect(review.approved).toBe(false);
  expect(review.files).toContainEqual(expect.objectContaining({ path: "tools/artprep.py", kind: "code", preview: expect.stringContaining("never executed") }));
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.original);
  expect(f.requests.some(r => ["recover", "prepare", "capture", "acknowledge"].includes(r.operation))).toBe(false);
  await expect(f.execution.assertSourceReviewSettled(f.project)).rejects.toThrow("awaits trusted user confirmation");
  const callsBeforeRefusal = f.requests.length;
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22")).rejects.toThrow("awaits trusted user confirmation");
  await expect(f.execution.start(f.project, "build", f.workspacePath)).rejects.toThrow("awaits trusted user confirmation");
  expect(f.requests).toHaveLength(callsBeforeRefusal);
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId)).rejects.toThrow("no trusted user approval");
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  await expect(f.execution.assertSourceReviewSettled(f.project)).resolves.toBeUndefined();
  expect((await f.execution.sourceReview(f.project, review.reviewId)).approved).toBe(true);
  const result = await f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId);
  expect(new Set(result.changed)).toEqual(new Set(f.files.map(file => file.path)));
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.after);
  expect(await readFile(path.join(path.dirname(f.workspacePath), result.recovery!, "original", f.media.path))).toEqual(f.original);
  expect(f.requests.find(r => r.operation === "recover")!.input.reviewSnapshotId).toBe(review.snapshotId);
  const before = f.requests.length;
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId)).resolves.toEqual({ changed: [] });
  expect(f.requests).toHaveLength(before);
  expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).toBe(true);
});

it("retains unapproved drafts as superseded history when the exact latest batch is approved", async () => {
  const f = await legacyReviewFixture();
  const first = await f.execution.reviewSource(f.project, "22", operation => operation());
  const latest = await f.execution.reviewSource(f.project, "22", operation => operation());
  expect(first.reviewId).not.toBe(latest.reviewId);
  await f.execution.approveSourceReview(f.project, latest.reviewId, operation => operation());
  expect((await f.execution.sourceReview(f.project, first.reviewId)).blockers).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("superseded") }));
  await expect(f.execution.assertSourceReviewSettled(f.project)).resolves.toBeUndefined();
  await f.execution.recoverSource(f.project, operation => operation(), "22", latest.reviewId);
  await expect(f.execution.assertSourceReviewSettled(f.project)).resolves.toBeUndefined();
});

it.each(["host", "guest", "expired", "corrupt-receipt", "wrong-project"])("refuses a stale or invalid %s legacy approval before source publication", async fault => {
  const f = await legacyReviewFixture();
  const review = await f.execution.reviewSource(f.project, "22", operation => operation());
  if (fault === "host") await writeFile(path.join(f.workspacePath, "notes.md"), "later user save");
  if (fault === "guest") f.handlers.set("review-source", input => ({ namespace: "test", projectId: f.project.id, generation: input.generation, snapshotId: "c".repeat(64), files: f.files, baselineFiles: [f.media] }));
  if (fault === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
  if (fault === "corrupt-receipt") {
    const target = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json");
    const record = JSON.parse(await readFile(target, "utf8")); record.review.files[0].afterSha256 = "d".repeat(64); await writeFile(target, JSON.stringify(record));
  }
  try { await expect(f.execution.approveSourceReview(fault === "wrong-project" ? { ...f.project, id: "another-project" } : f.project, review.reviewId, operation => operation())).rejects.toThrow(); }
  finally { vi.restoreAllMocks(); }
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.original);
  expect(f.requests.some(r => ["recover", "prepare", "capture", "acknowledge"].includes(r.operation))).toBe(false);
});

it("resumes an approved legacy batch after a lost ACK without requesting another approval or rerunning code", async () => {
  const f = await legacyReviewFixture();
  const review = await f.execution.reviewSource(f.project, "22", operation => operation());
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  f.handlers.set("acknowledge", () => { throw new Error("mock acknowledgement lost"); });
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId)).rejects.toThrow();
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.after);
  f.handlers.delete("acknowledge");
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22", review.reviewId)).resolves.toEqual({ changed: [] });
  expect(f.requests.filter(r => ["prepare", "run"].includes(r.operation))).toHaveLength(0);
});

it("invalidates approved consent after an independent host save and requires a new exact review", async () => {
  const f = await legacyReviewFixture();
  const originalReview = await f.execution.reviewSource(f.project, "22", operation => operation());
  await f.execution.approveSourceReview(f.project, originalReview.reviewId, operation => operation());
  await writeFile(path.join(f.workspacePath, "notes.md"), "later user save");
  await expect(f.execution.recoverSource(f.project, operation => operation(), "22", originalReview.reviewId)).rejects.toThrow("host changed");
  expect(f.requests.some(r => r.operation === "acknowledge")).toBe(false);
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.original);
  const fresh = await f.execution.reviewSource(f.project, "22", operation => operation());
  expect(fresh.reviewId).not.toBe(originalReview.reviewId);
  expect(fresh.approved).toBe(false);
  expect(fresh.blockers).toEqual([]);
  expect((await f.execution.sourceReview(f.project, originalReview.reviewId)).blockers).not.toEqual([]);
  await expect(f.execution.approveSourceReview(f.project, originalReview.reviewId, operation => operation())).rejects.toThrow("superseded");
  await f.execution.approveSourceReview(f.project, fresh.reviewId, operation => operation());
  await f.execution.recoverSource(f.project, operation => operation(), "22", fresh.reviewId);
  expect(await readFile(path.join(f.workspacePath, "notes.md"), "utf8")).toBe("later user save");
});

it("preserves superseded approval history when host contents later return to an earlier snapshot", async () => {
  const f = await legacyReviewFixture();
  const first = await f.execution.reviewSource(f.project, "22", operation => operation());
  await f.execution.approveSourceReview(f.project, first.reviewId, operation => operation());
  await writeFile(path.join(f.workspacePath, "notes.md"), "temporary independent save");
  await f.execution.reviewSource(f.project, "22", operation => operation());
  await rm(path.join(f.workspacePath, "notes.md"));
  const later = await f.execution.reviewSource(f.project, "22", operation => operation());
  expect(later.reviewId).not.toBe(first.reviewId);
  expect(later.approved).toBe(false);
  expect((await f.execution.sourceReview(f.project, first.reviewId)).blockers).not.toEqual([]);
  expect(await readFile(path.join(f.workspacePath, f.media.path))).toEqual(f.original);
});

it("cancels a transport-only close instead of releasing a possibly running task", async () => {
  const f = await fixture();
  const child = await f.execution.start(f.project, "build", f.workspacePath);
  child.emit("close", 0);
  await f.execution.settled(child);
  expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(1);
  expect(f.requests.filter((r) => r.operation === "release")).toHaveLength(0);
});

it("prevents a late recovery reservation after deletion begins during inventory", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, {
    projectId: f.project.id,
    namespace: "test",
    generation: 1,
    state: "resident",
    dirty: false,
    active: false,
  });
  let answer!: (value: unknown) => void;
  f.handlers.set(
    "inventory",
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const artifacts = f.execution.artifacts(f.project);
  const failed = expect(artifacts).rejects.toThrow("being deleted");
  await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
  const stopping = f.execution.quiesceProject(f.project.id);
  answer({
    protocolVersion: 2,
    namespace: "test",
    projects: [...f.projects.values()],
  });
  await failed;
  await stopping;
  expect(f.requests.filter((r) => r.operation === "recover")).toHaveLength(0);
  expect(f.requests.filter((r) => r.operation === "export")).toHaveLength(0);
});

it("rejects stale recovery generations before requesting a reservation", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, {
    projectId: f.project.id,
    namespace: "test",
    generation: 3,
    state: "recovery-pending",
    dirty: true,
    active: false,
  });
  await expect(
    f.execution.recoverSource(f.project, async (operation) => operation(), "2"),
  ).rejects.toThrow("storage changed");
  expect(f.requests.filter((r) => r.operation === "recover")).toHaveLength(0);
});

it("waits for guarded source return to drain before quiescence completes", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("capture", (input) => ({
    files: [sourceFile("counter.txt", "after")],
    baselineFiles: [sourceFile("counter.txt", "before")],
    snapshotId: "b".repeat(64),
    generation: input.generation,
  }));
  let guarded = 0,
    proceed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => {
      if (++guarded === 2) await waiting;
      return operation();
    },
  );
  const rejected = expect(task).rejects.toThrow("being deleted");
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  f.completeRun([...f.runs.keys()][0]);
  await vi.waitFor(() => expect(guarded).toBe(2));
  let stopped = false;
  const stopping = f.execution.quiesceProject(f.project.id).then(() => {
    stopped = true;
  });
  await vi.waitFor(() =>
    expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(1),
  );
  expect(stopped).toBe(false);
  proceed();
  await rejected;
  await stopping;
  expect(
    await readFile(path.join(f.workspacePath, "counter.txt"), "utf8"),
  ).toBe("before");
  expect(f.requests.filter((r) => r.operation === "acknowledge")).toHaveLength(
    0,
  );
});

it("cancels a late recovery snapshot without clearing a newer deletion gate", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, {
    projectId: f.project.id,
    namespace: "test",
    generation: 3,
    state: "recovery-pending",
    dirty: true,
    active: false,
  });
  let captured!: (value: unknown) => void;
  f.handlers.set(
    "capture",
    () =>
      new Promise((resolve) => {
        captured = resolve;
      }),
  );
  const task = f.execution.recoverSource(
    f.project,
    async (operation) => operation(),
    "3",
  );
  const rejected = expect(task).rejects.toThrow("being deleted");
  await vi.waitFor(() => expect(captured).toBeTypeOf("function"));
  let stopped = false;
  const stopping = f.execution.quiesceProject(f.project.id).then(() => {
    stopped = true;
  });
  await vi.waitFor(() =>
    expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(1),
  );
  expect(stopped).toBe(false);
  captured({
    files: [],
    baselineFiles: [],
    snapshotId: "b".repeat(64),
    generation: 3,
  });
  await rejected;
  await stopping;
  expect(f.requests.filter((r) => r.operation === "acknowledge")).toHaveLength(
    0,
  );
  await expect(
    f.execution.start(f.project, "build", f.workspacePath),
  ).rejects.toThrow("being deleted");
});

it("waits for a pending export and refuses its late host write after deletion starts", async () => {
  const f = await fixture();
  f.projects.set(f.project.id, {
    projectId: f.project.id,
    namespace: "test",
    generation: 1,
    state: "resident",
    dirty: false,
    active: false,
  });
  let exported!: (value: unknown) => void;
  f.handlers.set(
    "export",
    () =>
      new Promise((resolve) => {
        exported = resolve;
      }),
  );
  const task = f.execution.artifacts(f.project);
  const rejected = expect(task).rejects.toThrow("being deleted");
  await vi.waitFor(() => expect(exported).toBeTypeOf("function"));
  let stopped = false;
  const stopping = f.execution.quiesceProject(f.project.id).then(() => {
    stopped = true;
  });
  await vi.waitFor(() =>
    expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(1),
  );
  expect(stopped).toBe(false);
  exported({ files: [sourceFile("late.txt", "late")] });
  await rejected;
  await stopping;
  await expect(
    readFile(path.join(f.workspacePath, "late.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a mismatched reservation binding and cancels only its original scope", async () => {
  const f = await fixture();
  f.handlers.set("prepare", async (input, child, args) => ({
    ...((await f.defaultResponse(input, child, args)) as object),
    namespace: "manual",
  }));
  await expect(
    f.execution.start(f.project, "build", f.workspacePath),
  ).rejects.toThrow("Invalid isolated operation binding");
  expect(f.runs.size).toBe(0);
  const prepare = f.requests.find((r) => r.operation === "prepare")!.input;
  expect(f.requests.find((r) => r.operation === "cancel")!.input).toEqual({
    namespace: "test",
    projectId: f.project.id,
    operationId: prepare.operationId,
  });
});

it.each([1, 127])("confirms a nonzero command only after unchanged capture, ACK and release (exit %s)", async exitCode => {
  const f = await fixture(), receipts: IsolatedOperationReceipt[] = [];
  await writeFile(path.join(f.workspacePath, "existing.txt"), "retained");
  const files = [sourceFile("existing.txt", "retained")];
  f.handlers.set("capture", input => ({ files, baselineFiles: files, snapshotId: "b".repeat(64), generation: input.generation }));
  const pending = withIsolatedOperationScope(async history => { receipts.splice(0, receipts.length, ...history); }, () => f.execution.shell(f.project, "fixture-only", 5, async operation => operation())).catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); const operationId = [...f.runs.keys()][0]!;
  f.runOutputs.get(operationId)!.write(JSON.stringify({ kind: "stdout", data: Buffer.from("ENOENT: rig.json").toString("base64") }) + "\n");
  f.completeRun(operationId, exitCode);
  const failure = await pending;
  expect(failure.message).toContain(`Isolated command failed (${exitCode})`);
  expect(failure.message).toContain("ENOENT: rig.json");
  expect(getToolConfirmedFailure(failure)).toEqual({ reason: "isolated_command_failed", operationId, exitCode });
  expect(receipts.map(receipt => receipt.phase)).toEqual(["input_preflight", "prepare_submitting", "prepared", "run_submitting", "running", "captured", "acknowledged", "released"]);
  expect(await readFile(path.join(f.workspacePath, "existing.txt"), "utf8")).toBe("retained");
  expect(f.requests.filter(request => request.operation === "acknowledge")).toHaveLength(1);
  expect(f.runs.size).toBe(1);
});

it.each(["edited", "added", "deleted", "permissions", "wrong-baseline"])("retains failed command changes without ACK or confirmed-failure classification: %s", async variant => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "existing.txt"), "retained");
  const original = sourceFile("existing.txt", "retained");
  const files = variant === "deleted" ? [] : variant === "added" ? [original, sourceFile("new.txt", "partial")] :
    variant === "permissions" ? [{ ...original, executable: true }] : [sourceFile("existing.txt", "partial")];
  f.handlers.set("capture", input => ({ files, baselineFiles: variant === "wrong-baseline" ? files : [original], snapshotId: "b".repeat(64), generation: input.generation }));
  const pending = f.execution.shell(f.project, "fixture-only", 5, async operation => operation()).catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!, 1);
  const failure = await pending;
  expect(failure.message).toContain("Isolated command failed (1)"); expect(getToolConfirmedFailure(failure)).toBeUndefined();
  expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  expect(await readFile(path.join(f.workspacePath, "existing.txt"), "utf8")).toBe("retained");
  await expect(stat(path.join(f.workspacePath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["capture", "acknowledge", "release", "cancel"])("does not confirm an unchanged failure when %s is unconfirmed or cancelled", async boundary => {
  const f = await fixture(), controller = new AbortController();
  f.handlers.set(boundary === "cancel" ? "capture" : boundary, async (input, child, args) => {
    if (boundary !== "cancel") throw new Error("Fixture receipt unavailable");
    controller.abort(); return f.defaultResponse(input, child, args);
  });
  const pending = f.execution.shell(f.project, "fixture-only", 5, async operation => operation(), controller.signal).catch(cause => cause);
  await vi.waitFor(() => expect(f.runs.size).toBe(1)); f.completeRun([...f.runs.keys()][0]!, 1);
  expect(getToolConfirmedFailure(await pending)).toBeUndefined();
  if (["capture", "cancel"].includes(boundary)) expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  expect(f.runs.size).toBe(1);
});

it("does not capture or acknowledge after unconfirmed terminal cleanup", async () => {
  const f = await fixture();
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  const rejected = expect(task).rejects.toThrow(
    "without confirmed task cleanup",
  );
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const op = [...f.runs.keys()][0];
  f.runOutputs.get(op)!.write(
    JSON.stringify({
      kind: "error",
      message: "cleanup verification failed",
    }) + "\n",
  );
  f.runs.get(op)!.emit("close", 1);
  await rejected;
  expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(1);
  expect(
    f.requests.filter((r) => ["capture", "acknowledge"].includes(r.operation)),
  ).toHaveLength(0);
});

it("distinguishes a drained transport from a successful build when the terminal frame is missing", async () => {
  const f = await fixture();
  const child = await f.execution.start(f.project, "build", f.workspacePath);
  child.emit("close", 0);
  await f.execution.settled(child);
  await expect(f.execution.settled(child, true)).rejects.toThrow("without a confirmed successful exit");
  expect(f.requests.some(request => request.operation === "export")).toBe(false);
});

it.each([0, 2, null])("never imports a failed command when the transport reports a mismatched status (%s)", async transportCode => {
  const f = await fixture();
  await writeFile(path.join(f.workspacePath, "counter.txt"), "before");
  f.handlers.set("capture", (input) => ({
    files: [sourceFile("counter.txt", "failed-change")],
    baselineFiles: [sourceFile("counter.txt", "before")],
    snapshotId: "b".repeat(64),
    generation: input.generation,
  }));
  const task = f.execution.shell(
    f.project,
    "fixture-only",
    5,
    async (operation) => operation(),
  );
  const rejected = expect(task).rejects.toThrow(
    "terminal status did not match",
  );
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const op = [...f.runs.keys()][0];
  f.runOutputs
    .get(op)!
    .write(JSON.stringify({ kind: "exit", id: op, code: 1 }) + "\n");
  f.runs.get(op)!.emit("close", transportCode);
  await rejected;
  expect(
    f.requests.filter((r) => ["capture", "acknowledge"].includes(r.operation)),
  ).toHaveLength(0);
  expect(
    await readFile(path.join(f.workspacePath, "counter.txt"), "utf8"),
  ).toBe("before");
});

it("can reconcile a failed release without preparing a replacement operation", async () => {
  const f = await fixture();
  f.handlers.set("release", () => {
    throw new Error("Release reply unavailable");
  });
  const child = await f.execution.start(f.project, "build", f.workspacePath);
  const rejected = expect(f.execution.settled(child)).rejects.toThrow(
    "Release reply unavailable",
  );
  f.completeRun([...f.runs.keys()][0]);
  await rejected;
  expect(f.requests.filter((r) => r.operation === "release")).toHaveLength(2);
  f.handlers.delete("release");
  await f.execution.quiesceProject(f.project.id);
  expect(f.requests.filter((r) => r.operation === "prepare")).toHaveLength(1);
  expect(f.requests.filter((r) => r.operation === "cancel")).toHaveLength(0);
  expect(f.requests.filter((r) => r.operation === "release")).toHaveLength(3);
});


it.each(["ready", "control"])("serializes first-allocation capacity control against preparation during %s", async phase => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const ready = vi.fn(async () => { if (phase === "ready") { enter(); await pending; } });
  const f = await profileCaptureFixture({ vm: { ready } }), planId = "12345678-1234-1234-1234-123456789abc";
  f.projects.clear();
  f.handlers.set("plan-capacity", async () => { if (phase === "control") { enter(); await pending; } return { planId }; });
  f.handlers.set("inspect-capacity-plan", () => ({ planId, phase: "planned" }));
  const planning = f.execution.planCapacityMigration(f.project, { namespace: "test", projectId: f.project.id, planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" });
  try {
    await entered;
    await expect(f.execution.start(f.project, "build", f.workspacePath)).rejects.toSatisfy(
      cause => getToolPreflightFailure(cause)?.reason === "project_execution_busy");
    await expect(f.execution.planCapacityMigration(f.project, { namespace: "test", projectId: f.project.id, planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" })).rejects.toThrow("Wait for this project's isolated operations");
    await expect(f.execution.inspectCapacityPlan(f.project, { namespace: "test", projectId: f.project.id, planId })).rejects.toThrow("Wait for this project's isolated operations");
    expect(f.requests.some(item => item.operation.startsWith("prepare") || item.operation === "run")).toBe(false);
  } finally { finish(); await planning; }
  await expect(f.execution.inspectCapacityPlan(f.project, { namespace: "test", projectId: f.project.id, planId })).resolves.toEqual({ planId, phase: "planned" });
  expect(f.requests.filter(item => item.operation === "plan-capacity")).toHaveLength(1);
});

it.each(["cancel", "failure"])("releases the first-allocation host claim after %s before a guest plan is submitted", async outcome => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const ready = vi.fn(async () => { enter(); await pending; if (outcome === "failure") throw new Error("Fixture VM unavailable"); });
  const f = await profileCaptureFixture({ vm: { ready } }), controller = new AbortController(), planId = "12345678-1234-1234-1234-123456789abc";
  f.projects.clear();
  const planning = f.execution.planCapacityMigration(f.project, { namespace: "test", projectId: f.project.id, planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" }, controller.signal);
  const rejected = expect(planning).rejects.toThrow(outcome === "cancel" ? "Fixture cancelled" : "Fixture VM unavailable");
  await entered;
  if (outcome === "cancel") controller.abort(new Error("Fixture cancelled"));
  finish(); await rejected;
  expect(f.requests).toEqual([]);
  ready.mockResolvedValue(undefined);
  f.handlers.set("inspect-capacity-plan", () => ({ planId, phase: "unknown" }));
  await expect(f.execution.inspectCapacityPlan(f.project, { namespace: "test", projectId: f.project.id, planId })).resolves.toEqual({ planId, phase: "unknown" });
  expect(f.projects.size).toBe(0);
});

it("drains an in-flight first-allocation control before quiescence and refuses late submission", async () => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const ready = vi.fn(async () => { enter(); await pending; });
  const f = await profileCaptureFixture({ vm: { ready } }), planId = "12345678-1234-1234-1234-123456789abc";
  f.projects.clear();
  const planning = f.execution.planCapacityMigration(f.project, { namespace: "test", projectId: f.project.id, planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" });
  const rejected = expect(planning).rejects.toThrow("The isolated project is being deleted");
  await entered;
  let drained = false;
  const quiescing = f.execution.quiesceProject(f.project.id).then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  finish(); await rejected; await quiescing;
  expect(f.requests.some(item => ["plan-capacity", "migrate-capacity", "prepare", "run"].includes(item.operation))).toBe(false);
  expect(f.projects.size).toBe(0);
});

it("keeps an original native capacity inspection read-only during pending deletion while refusing a new plan", async () => {
  const f = await profileCaptureFixture();
  f.execution.setAdmission(() => { throw new Error("Deletion is pending"); });
  const planId = "12345678-1234-1234-1234-123456789abc";
  f.handlers.set("inspect-capacity-plan", input => ({ planId: input.planId, phase: "unknown" }));
  await expect(f.execution.inspectCapacityPlan(f.project, { namespace: "test", projectId: f.project.id, planId })).resolves.toEqual({ planId, phase: "unknown" });
  await expect(f.execution.planCapacityMigration(f.project, { namespace: "test", projectId: f.project.id, planId, capacityProfileVersion: 2, sourceProfileId: "capacity-128-v2" })).rejects.toThrow("Deletion is pending");
  expect(f.requests.filter(item => item.operation === "inspect-capacity-plan")).toHaveLength(1);
  expect(f.requests.some(item => item.operation === "plan-capacity")).toBe(false);
  expect(f.requests.some(item => ["prepare-begin", "migrate-capacity", "run"].includes(item.operation))).toBe(false);
});

it("media64 host profile uploads two exact 64 MiB windows and publishes a known-copy replacement with bounded original retention", async () => {
  const f = await profileCaptureFixture({ profileId: "capacity-128-media64-v3", mediaSizes: [64 * 1024 ** 2, 64 * 1024 ** 2], replaceMedia: true });
  const alloc = vi.spyOn(Buffer, "alloc"), unsafe = vi.spyOn(Buffer, "allocUnsafe");
  const outcome = await f.run(), largestAllocation = Math.max(0, ...alloc.mock.calls.map(call => call[0]), ...unsafe.mock.calls.map(call => call[0])); alloc.mockRestore(); unsafe.mockRestore();
  expect(outcome).not.toBeInstanceOf(Error); expect(largestAllocation).toBeLessThan(32 * 1024 ** 2);
  expect(f.receivedMedia).toEqual(f.media.map((entry, windowIndex) => ({ ...entry, windowIndex })));
  expect(f.requests.filter(request => request.operation === "prepare-append")).toHaveLength(2);
  expect(f.requests.filter(request => request.operation === "prepare-begin")).toHaveLength(1);
  expect(await inspectSafeProjectMedia(f.workspacePath, path.join(f.workspacePath, f.media[0]!.path), 64 * 1024 ** 2)).toMatchObject({ size: 64 * 1024 ** 2, sha256: f.media[1]!.sha256 });
  const root = path.join(path.dirname(f.workspacePath), "isolated-changes"), [id] = await readdir(root), journal = JSON.parse(await readFile(path.join(root, id!, "manifest.json"), "utf8"));
  expect(journal).toMatchObject({ version: 5, state: "committed", context: { sourceContract: { profileId: "capacity-128-media64-v3" } }, publicationDelta: { beforeMediaBytes: 64 * 1024 ** 2, afterMediaBytes: 64 * 1024 ** 2 } });
  expect(await inspectSafeProjectMedia(path.join(root, id!), path.join(root, id!, "original", f.media[0]!.path), 64 * 1024 ** 2)).toMatchObject({ size: f.media[0]!.size, sha256: f.media[0]!.sha256 });
}, 30_000);
it("media64 saved retained review reads a known 64 MiB source again and lost ACK verification never reuploads or reruns", async () => {
  const f = await profileCaptureFixture({ profileId: "capacity-128-media64-v3", mediaSizes: [64 * 1024 ** 2], image: true, lostAck: true });
  expect(await f.run()).toBeInstanceOf(Error);
  const review = await f.execution.reviewSource(f.project, "2", operation => operation()); expect(review.blockers).toEqual([]);
  const stored = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId); expect(stored.retained?.sourceContract).toMatchObject({ profileId: "capacity-128-media64-v3" });
  expect(stored.retained?.rawFiles.find(file => file.path.endsWith(".wav"))).toMatchObject({ kind: "verified-media", size: 64 * 1024 ** 2 });
  await f.execution.approveSourceReview(f.project, review.reviewId, operation => operation());
  const failed = await f.execution.recoverSource(f.project, operation => operation(), "2", review.reviewId).catch(cause => cause); expect(getIsolatedRepairPending(failed)).toMatchObject({ reviewId: review.reviewId });
  const start = f.requests.length; await expect(f.execution.verifySourceReview(f.project, review.reviewId)).resolves.toMatchObject({ changed: [] });
  expect(f.requests.slice(start).map(request => request.operation)).not.toEqual(expect.arrayContaining(["prepare-begin", "prepare-append", "recover", "capture", "acknowledge"])); expect(f.runs.size).toBe(1);
}, 30_000);
it.each(["old", "new", "wrong-version", "reordered", "changed-limit"])("media64 readonly capability probe validates exact health without booting the VM: %s", async fault => {
  const ready = vi.fn(), f = await profileCaptureFixture({ profileId: "capacity-128-media64-v3", vm: { ready } }), original = f.handlers.get("health")!;
  f.handlers.set("health", async (...args) => { const value = { ...await original(...args) as any }; if (fault === "old") { value.capacityProfileVersion = 2; value.capacityProfiles = [getRuntimeCapacityProfile("capacity-128-v2")]; } if (fault === "wrong-version") value.capacityProfileVersion = 2; if (fault === "reordered") value.capacityProfiles = [...value.capacityProfiles].reverse(); if (fault === "changed-limit") value.capacityProfiles = value.capacityProfiles.map((entry: any) => ({ ...entry, mediaFileBytes: 64 * 1024 ** 2 })); return value; });
  if (fault === "old" || fault === "new") await expect(f.execution.supportsCapacityProfile("capacity-128-media64-v3")).resolves.toBe(fault === "new");
  else await expect(f.execution.supportsCapacityProfile("capacity-128-media64-v3")).rejects.toThrow("incompatible capabilities");
  expect(ready).not.toHaveBeenCalled(); expect(f.requests.every(request => request.operation === "health")).toBe(true);
});

it("media64 does not adopt a new unverified 64 MiB non-raster descriptor even under a matching versioned manifest", async () => {
  const f = await profileCaptureFixture({ profileId: "capacity-128-media64-v3", mediaSizes: [64 * 1024 ** 2], header: (value, operation) => {
    if (operation !== "capture-media") return;
    value.files = [...value.files, { path: "public/unknown.wav", size: 64 * 1024 ** 2, sha256: "f".repeat(64) }];
    value.sourceManifest = fixtureProfileManifest(value.files, "capacity-128-media64-v3"); value.sourceResultManifestId = value.sourceManifest.manifestId;
    value.sourceDelta = planSourceDelta(value.sourceBaselineManifest, value.sourceManifest).summary; value.snapshotId = reviewSnapshotDigest(value.files);
  } });
  const outcome = await f.run(); expect(outcome).toBeInstanceOf(Error); expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false);
  await expect(stat(path.join(f.workspacePath, "public/unknown.wav"))).rejects.toMatchObject({ code: "ENOENT" }); expect(f.runs.size).toBe(1);
});

it.each(["public/new.png", "public/new.wav"])("media64 never treats an untrusted 64 MiB payload as a retained raster: %s", async relative => {
  const f = await profileCaptureFixture({ profileId: "capacity-128-media64-v3", header: (value, operation) => { if (operation === "capture-media") value.returnedRasters = [{ path: relative, size: 64 * 1024 ** 2, sha256: "f".repeat(64), executable: false }]; } });
  expect(await f.run()).toBeInstanceOf(Error); expect(f.requests.some(request => request.operation === "acknowledge")).toBe(false); await expect(stat(path.join(f.workspacePath, relative))).rejects.toMatchObject({ code: "ENOENT" });
});


it("retained image read loads raw and working variants from a cold saved review without guest requests or writes", async () => {
  const f = await retainedFixture(), initial = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation())), review = await f.owned(() => f.execution.optimizeSourceReview(f.project, initial.reviewId, { paths: [f.image.path], maxEdge: 256 }, operation => operation()));
  const record = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId), receiptPath = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json"), before = await readFile(receiptPath), requestCount = f.requests.length;
  const cold = Reflect.construct(IsolatedProjectExecution, [path.dirname(path.dirname(f.workspacePath)), undefined, "test"]) as IsolatedProjectExecution; executions.push(cold);
  const raw = await cold.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256);
  expect(raw.metadata).toMatchObject({ projectId: f.project.id, reviewId: review.reviewId, generation: "4", rawSnapshotId: f.snapshotId, variant: "raw", sourceSha256: f.image.sha256, sourceBytes: f.raw.length, sourceWidth: 1024, sourceHeight: 1024, freshGuest: false, adoptionApproved: false, isProxy: true });
  await expect(cold.readRetainedImage(f.project, review.reviewId, f.image.path, "working", f.image.sha256)).rejects.toThrow("digest differs");
  const working = await cold.readRetainedImage(f.project, review.reviewId, f.image.path, "working", record.retained!.images[f.image.path]!.workingSha256!);
  expect(working.metadata).toMatchObject({ variant: "working", sourceWidth: 256, sourceHeight: 256, displayWidth: 256, displayHeight: 256, freshGuest: false, adoptionApproved: false, isProxy: false });
  for (const result of [raw, working]) { expect(result.bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(result.metadata.displaySha256).toBe(createHash("sha256").update(result.bytes).digest("hex")); expect(Math.max(result.metadata.displayWidth, result.metadata.displayHeight)).toBeLessThanOrEqual(1536); expect(getIsolatedRepairProof(result)).toBeUndefined(); }
  expect(await readFile(receiptPath)).toEqual(before); expect(f.requests).toHaveLength(requestCount); expect(f.runs.size).toBe(0);
  expect(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).toEqual(f.raw);
  await expect(stat(path.join(f.workspacePath, f.image.path))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["sha", "path", "variant", "project", "namespace", "host", "expired", "superseded", "receipt", "raw-tamper", "working-tamper", "symlink", "hardlink", "executable"])("retained image read refuses a %s mismatch without invoking the guest or altering the batch", async fault => {
  const f = await retainedFixture({ small: true }), initial = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation())), review = await f.owned(() => f.execution.optimizeSourceReview(f.project, initial.reviewId, { paths: [f.image.path], maxEdge: 256 }, operation => operation()));
  const record = await readSourceReview(f.workspacePath, f.project.id, "test", review.reviewId), root = path.dirname(f.workspacePath), receipt = path.join(root, "isolated-reviews", review.reviewId + ".json"), original = path.join(root, "isolated-review-artifacts/raw", f.image.sha256);
  let project = f.project, execution = f.execution, relative = f.image.path, sha = f.image.sha256, variant: "raw" | "working" = "raw";
  if (fault === "sha") sha = "f".repeat(64);
  if (fault === "path") relative = "../isolated-review-artifacts/raw/" + sha;
  if (fault === "variant") variant = "url" as never;
  if (fault === "project") project = { ...project, id: "foreign-project" };
  if (fault === "namespace") { execution = Reflect.construct(IsolatedProjectExecution, [path.dirname(root), undefined, "manual"]) as IsolatedProjectExecution; executions.push(execution); }
  if (fault === "host") await writeFile(path.join(f.workspacePath, "outside-review.txt"), "a newer manual save");
  if (["expired", "superseded", "receipt"].includes(fault)) { const value = JSON.parse(await readFile(receipt, "utf8")); if (fault === "expired") value.review.expiresAt = "2000-01-01T00:00:00.000Z"; if (fault === "superseded") value.superseded = true; if (fault === "receipt") value.review.generation = "5"; await writeFile(receipt, JSON.stringify(value)); }
  if (fault === "raw-tamper") await writeFile(original, "tampered bytes");
  if (fault === "working-tamper") { variant = "working"; sha = record.retained!.images[f.image.path]!.workingSha256!; await writeFile(path.join(root, "isolated-review-artifacts", sha === f.image.sha256 ? "raw" : "working", sha), "tampered working bytes"); }
  if (fault === "symlink") { const retained = path.join(root, "owned-original.png"); await rename(original, retained); await symlink(retained, original); }
  if (fault === "hardlink") await link(original, path.join(root, "owned-link.png"));
  if (fault === "executable") await chmod(original, 0o700);
  const before = await readFile(receipt), requests = f.requests.length;
  await expect(execution.readRetainedImage(project, review.reviewId, relative, variant, sha)).rejects.toThrow();
  expect(await readFile(receipt)).toEqual(before); expect(f.requests).toHaveLength(requests); expect(f.runs.size).toBe(0);
});
it("retained image read remains read-only while the original adoption ACK is unknown", async () => {
  const f = await retainedFixture({ small: true, lostAck: true }), review = await approvedRetained(f);
  await f.owned(() => f.execution.recoverSource(f.project, operation => operation(), "4", review.reviewId)).catch(() => {});
  const receipt = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json"), before = await readFile(receipt), requests = f.requests.length;
  const result = await f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256);
  expect(result.metadata).toMatchObject({ freshGuest: false, adoptionApproved: false }); expect(getIsolatedRepairProof(result)).toBeUndefined(); expect(f.requests).toHaveLength(requests); expect(await readFile(receipt)).toEqual(before); expect((await f.execution.sourceReview(f.project, review.reviewId)).completed).not.toBe(true);
});
it("retained image read bounds pending requests before loading image bytes and cancels queued reads promptly", async () => {
  const f = await retainedFixture({ small: true }), review = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation()));
  let release!: () => void, entered = false; const gate = new Promise<void>(resolve => { release = resolve; }), held = imagePreparation.serializeWorkingImages(async () => { entered = true; await gate; }); await vi.waitFor(() => expect(entered).toBe(true));
  const calls = vi.spyOn(sourceReview, "readReviewedRetainedImage"), opened = vi.spyOn(fs, "open"), controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map(controller => f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256, controller.signal).catch(cause => cause));
  try { await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(4)); await expect(f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256)).rejects.toThrow("busy"); controllers.forEach(controller => controller.abort()); for (const pending of requests) expect(await pending).toBeInstanceOf(Error); expect(opened).not.toHaveBeenCalled(); }
  finally { release(); await held; await imagePreparation.serializeWorkingImages(async () => {}); calls.mockRestore(); opened.mockRestore(); }
  await expect(f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256)).resolves.toMatchObject({ metadata: { sourceSha256: f.image.sha256 } });
});
it.each(["abort", "policy", "receipt-change", "artifact-change"])("retained image read rejects a late %s before releasing an image", async fault => {
  const f = await retainedFixture({ small: true }), review = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation()));
  let release!: () => void, entered = false; const gate = new Promise<void>(resolve => { release = resolve; }), prepare = retainedDisplay.prepareSessionImageDisplay;
  const held = vi.spyOn(retainedDisplay, "prepareSessionImageDisplay").mockImplementation(async (...args) => { entered = true; await gate; return prepare(...args); }); const controller = new AbortController();
  const pending = f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256, controller.signal).catch(cause => cause);
  try { await vi.waitFor(() => expect(entered).toBe(true)); if (fault === "abort") controller.abort(); if (fault === "policy") registerSensitiveValue("retained-reader-new-policy-canary"); if (fault === "artifact-change") await writeFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256), "changed while display preparation was pending"); if (fault === "receipt-change") { const receipt = path.join(path.dirname(f.workspacePath), "isolated-reviews", review.reviewId + ".json"), value = JSON.parse(await readFile(receipt, "utf8")); value.superseded = true; await writeFile(receipt, JSON.stringify(value)); } release(); expect(await pending).toBeInstanceOf(Error); }
  finally { release(); await imagePreparation.serializeWorkingImages(async () => {}); held.mockRestore(); }
});

it("retained image read reduces an exact 32 MiB valid raw original to a bounded model display without changing the artifact", async () => {
  const base = referencePng({ width: 32, height: 32, noise: true, level: 0 }), padding = Buffer.alloc(32 * 1024 * 1024 - base.length); padding.writeUInt32BE(padding.length - 12); padding.write("vpAg", 4); padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
  const raw = Buffer.concat([base.subarray(0, -12), padding, base.subarray(-12)]), f = await retainedFixture({ raw }), review = await f.owned(() => f.execution.reviewSource(f.project, "4", operation => operation())), before = f.requests.length;
  expect(raw.length).toBe(32 * 1024 * 1024); const result = await f.execution.readRetainedImage(f.project, review.reviewId, f.image.path, "raw", f.image.sha256);
  expect(result.metadata).toMatchObject({ sourceBytes: raw.length, sourceWidth: 32, sourceHeight: 32, sourceSha256: f.image.sha256, isProxy: true }); expect(result.bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(f.requests).toHaveLength(before);
  expect((await stat(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).size).toBe(raw.length); expect(createHash("sha256").update(await readFile(path.join(path.dirname(f.workspacePath), "isolated-review-artifacts/raw", f.image.sha256))).digest("hex")).toBe(f.image.sha256);
}, 30_000);
