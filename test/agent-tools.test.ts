import { referenceWav } from "./audio-reference-fixture.js";
import { createHash } from "node:crypto";
import { knownSensitiveValueRevision } from "../src/shared/sensitive-values.js";
import { NodeIO } from "@gltf-transform/core";
import { model3DFixture, fbxFixture, TEST_GLB } from "./model3d-fixture.js";
import { readFile, readdir, symlink, writeFile, rm, truncate, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { temporaryTestDirectory } from "./temporary-test-directory.js";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runToolCall, type AgentToolCall } from "@earendil-works/pi-agent-core";
import { activePiToolNames, createAgentTools, planningPiToolNames, projectPiToolNames } from "../src/daemon/agent-tools.js";
import { createIsolatedRecoveryTool } from "../src/daemon/isolated-shell-tool.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { AgentAttachmentStore } from "../src/daemon/agent-attachments.js";
import { OpenAIImageGenerator, type ImageGenerator } from "../src/daemon/openai-image.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { projectFiles } from "../src/daemon/isolated-project-files.js";
import { readModelResources } from "../src/daemon/model-resources.js";
import { listWorkspaceFiles } from "../src/daemon/workspace.js";
import type { VideoGenerator } from "../src/daemon/video-generation.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter } from "../src/shared/playtest.js";
import { createNodeCodebase, createPlayableStarterCodebase } from "../src/daemon/playable-codebase.js";
import { KunpoVideoProvider } from "../src/daemon/kunpo-video-provider.js";
import { seedanceModel } from "../src/daemon/seedance-models.js";
import { referencePng } from "./video-reference-png-fixture.js";
import { VIDEO_REFERENCE_REQUEST_TARGET_BYTES } from "../src/daemon/video-reference-budget.js";
import { AutoContinueTools } from "../src/daemon/agent-auto-continue.js";
import { findAnimationAction } from "../src/daemon/agent-canvas-media.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import { tripoActions } from "../src/shared/model3d-operations.js";
import type { IsolatedSourceReview } from "../src/shared/execution-storage.js";
import { CAPACITY_PROFILES, planExecutionCapacityProposal, type CapacityProfileId } from "../src/shared/execution-capacity-profiles.js";
import { inspectExecutionCapacity, planInitialExecutionCapacity, proposeExecutionCapacity, type InitialExecutionCapacityPlan } from "../src/daemon/execution-capacity.js";

const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;

describe("retained image inspection", () => {
  const reviewId = "a".repeat(64), sourceSha = "b".repeat(64), relativePath = "public/sprites/atlas.png";
  const input = { action: "read_image" as const, reviewId, path: relativePath, variant: "raw" as const, sha256: sourceSha };
  function fixture() {
    const bytes = referencePng(), displaySha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = { reviewId, generation: "7", rawSnapshotId: "c".repeat(64), path: relativePath, variant: "raw" as "raw" | "working",
      sourceSha256: sourceSha, sourceBytes: 4096, sourceWidth: 2048, sourceHeight: 2048, sourceHasAlpha: true,
      displaySha256, displayWidth: 8, displayHeight: 8, displayBytes: bytes.length, isProxy: true, adoptionApproved: false as const, freshGuest: false as const, scannerRevision: knownSensitiveValueRevision() };
    const readImage = vi.fn(async () => ({ bytes, mimeType: "image/png" as const, metadata }));
    const inspect = vi.fn(), recover = vi.fn(), review = vi.fn(), adopt = vi.fn();
    const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, readImage });
    const call = (args: Parameters<typeof tool.execute>[1], vision: unknown = { model: { input: ["text", "image"] } }, signal?: AbortSignal) =>
      tool.execute("read-retained", args, signal, undefined, vision as never);
    return { bytes, metadata, readImage, inspect, recover, review, adopt, call };
  }
  it("returns real bound pixels and proxy metadata without granting approval or changing recovery", async () => {
    const f = fixture(), controller = new AbortController(), result = await f.call(input, undefined, controller.signal);
    expect(f.readImage).toHaveBeenCalledExactlyOnceWith(reviewId, relativePath, "raw", sourceSha, controller.signal);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not an approval") });
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: f.bytes.toString("base64") });
    expect(result.details).toEqual({ retainedImage: f.metadata });
    expect(result.details).not.toHaveProperty("bytes");
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expect(f.adopt).not.toHaveBeenCalled(); expect(f.recover).not.toHaveBeenCalled();
  });
  it("refuses text-only or unverified image capability without reading or claiming inspection", async () => {
    const f = fixture();
    for (const context of [null, {}, { model: { input: ["text"] } }]) await expect(f.call(input, context)).rejects.toThrow(/unavailable or unverified.*no retained image was read/);
    expect(f.readImage).not.toHaveBeenCalled();
  });
  it("also binds a working variant to its exact supplied SHA", async () => {
    const f = fixture(); f.readImage.mockResolvedValueOnce({ bytes: f.bytes, mimeType: "image/png", metadata: { ...f.metadata, variant: "working" } });
    const result = await f.call({ ...input, variant: "working" });
    expect(result.details).toMatchObject({ retainedImage: { reviewId, path: relativePath, variant: "working", sourceSha256: sourceSha, freshGuest: false } });
    expect(f.readImage).toHaveBeenCalledExactlyOnceWith(reviewId, relativePath, "working", sourceSha, undefined);
  });
  it("rejects arbitrary paths, malformed bindings and any extraneous or approval argument", async () => {
    const f = fixture();
    for (const invalid of [
      { ...input, path: "../atlas.png" }, { ...input, path: "/absolute.png" }, { ...input, path: "https://example.test/a.png" },
      { ...input, path: ".env" }, { ...input, path: "public/code.txt" }, { ...input, sha256: "bad" },
      { ...input, reviewId: "bad" }, { ...input, variant: "original" }, { ...input, approved: true }, { ...input, paths: [relativePath] },
      { action: "inspect", path: relativePath },
    ]) await expect(f.call(invalid as never)).rejects.toThrow();
    expect(f.readImage).not.toHaveBeenCalled();
  });
  it("refuses callback binding or displayed bytes that do not match the requested image", async () => {
    const f = fixture();
    for (const metadata of [
      { ...f.metadata, reviewId: "d".repeat(64) }, { ...f.metadata, path: "public/other.png" },
      { ...f.metadata, sourceSha256: "d".repeat(64) }, { ...f.metadata, displaySha256: "d".repeat(64) },
      { ...f.metadata, adoptionApproved: true as false }, { ...f.metadata, freshGuest: true as false }, { ...f.metadata, scannerRevision: -1 }, { ...f.metadata, isProxy: false }, { ...f.metadata, displayWidth: 1537 },
      { ...f.metadata, sourceWidth: 32768, sourceHeight: 32768 }, { ...f.metadata, sourceBytes: 32 * 1024 ** 2 + 1 },
      { ...f.metadata, sourceWidth: 4, displayWidth: 8 },
    ]) {
      f.readImage.mockResolvedValueOnce({ bytes: f.bytes, mimeType: "image/png", metadata });
      await expect(f.call(input)).rejects.toThrow(/display binding/);
    }
    const invalid = Buffer.from("not an image");
    f.readImage.mockResolvedValueOnce({ bytes: invalid, mimeType: "image/png", metadata: { ...f.metadata, displayBytes: invalid.length, displaySha256: createHash("sha256").update(invalid).digest("hex") } });
    await expect(f.call(input)).rejects.toThrow(/display binding/);
  });
  it("propagates cancellation before and after reading without returning pixels", async () => {
    const f = fixture(), pre = new AbortController(); pre.abort(new Error("cancelled before"));
    await expect(f.call(input, undefined, pre.signal)).rejects.toThrow("cancelled before"); expect(f.readImage).not.toHaveBeenCalled();
    const during = new AbortController();
    f.readImage.mockImplementationOnce(async () => { during.abort(new Error("cancelled during")); return { bytes: f.bytes, mimeType: "image/png", metadata: f.metadata }; });
    await expect(f.call(input, undefined, during.signal)).rejects.toThrow("cancelled during");
  });
});

it("requires an exact target only on a native capacity request without turning it into approval", async () => {
  const inspect = vi.fn(), recover = vi.fn(), upgradeCapacity = vi.fn(async () => ({ status: "blocked" })), inspectCapacityMigration = vi.fn();
  const tool = createIsolatedRecoveryTool(inspect, recover, { review: vi.fn(), adopt: vi.fn(), upgradeCapacity, inspectCapacityMigration });
  const signal = new AbortController().signal;
  const call = (input: Parameters<typeof tool.execute>[1]) => tool.execute("capacity-test", input, signal, undefined, {} as never);
  await call({ action: "upgrade_capacity" });
  expect(upgradeCapacity).toHaveBeenLastCalledWith("capacity-test", signal);
  await call({ action: "upgrade_capacity", targetProfileId: "capacity-128-media64-v3" });
  expect(upgradeCapacity).toHaveBeenLastCalledWith("capacity-test", signal, "capacity-128-media64-v3");
  for (const input of [
    { action: "upgrade_capacity", targetProfileId: "unknown" },
    { action: "upgrade_capacity", targetProfileId: "capacity-128-media64-v3", approved: true },
    { action: "inspect_capacity_migration", targetProfileId: "capacity-128-media64-v3" },
    { action: "capacity", targetProfileId: "capacity-128-media64-v3" },
  ]) await expect(call(input as never)).rejects.toThrow();
  expect(upgradeCapacity).toHaveBeenCalledTimes(2);
  expect(inspectCapacityMigration).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
});

describe("read-only capacity proposals", () => {
  function fixture() {
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation: "7" }));
    const recover = vi.fn(async () => ({ changed: [] as string[] })), review = vi.fn(), adopt = vi.fn(), capacity = vi.fn();
    const planCapacity = vi.fn(async (profileId: CapacityProfileId, _signal?: AbortSignal) => planExecutionCapacityProposal({ profileId }));
    const planFirstAllocation = vi.fn<(signal?: AbortSignal) => Promise<InitialExecutionCapacityPlan>>();
    const tool = createIsolatedRecoveryTool(inspect, recover, { review, adopt, capacity, planCapacity, planFirstAllocation });
    const call = (input: Parameters<typeof tool.execute>[1], signal?: AbortSignal) => tool.execute("capacity-proposal", input, signal, undefined, {} as never);
    return { inspect, recover, review, adopt, capacity, planCapacity, planFirstAllocation, tool, call };
  }

  async function firstAllocationReport() {
    const workspace = await temporaryTestDirectory("ohmygame-first-allocation-");
    const observe = () => inspectExecutionCapacity({ projectId: "first-allocation-fixture", workspace,
      localImageAnchor: async () => { throw new Error("No image ledger fixture"); } });
    return { workspace, observe, report: await observe() };
  }

  it("compares real first-allocation contracts without choosing, admitting or mutating them", async () => {
    const { report } = await firstAllocationReport(), before = structuredClone(report);
    const plan = planInitialExecutionCapacity(report);
    expect(plan).toMatchObject({ purpose: "first-allocation-planning-only", authorization: "none",
      applicability: "unknown", recommendedProfileId: null, smallestObservedEnvelope: "current-64",
      evidence: { metadataOnly: true, atomicSnapshot: false, completeForObservedEnvelope: true, guestCapabilities: "not-probed", futureWorkload: "unknown" },
      resources: { guestVolumeFreeBytes: null, allocationSpaceAndInodes: "requires-fresh-native-admission" },
      performance: { decodedMemory: "unknown", gpuMemory: "unknown", frameTime: "not-measured" } });
    expect(plan.choices.map(choice => [choice.profileId, choice.limits.volumeBytes, choice.limits.mediaBytes, choice.limits.mediaFileBytes, choice.limits.largeMediaFileBytes])).toEqual([
      ["current-64", 256 * 1024 ** 2, 64 * 1024 ** 2, 32 * 1024 ** 2, 32 * 1024 ** 2],
      ["capacity-128-v2", 512 * 1024 ** 2, 128 * 1024 ** 2, 32 * 1024 ** 2, 32 * 1024 ** 2],
      ["capacity-128-media64-v3", 512 * 1024 ** 2, 128 * 1024 ** 2, 32 * 1024 ** 2, 64 * 1024 ** 2],
    ]);
    for (const choice of plan.choices) expect(choice).toMatchObject({ readyForAllocation: false, simulationOnly: false, capabilityStatus: "not-probed", observedEnvelope: { status: "within" } });
    expect(report).toEqual(before);
    for (const allocation of ["present", "absent", "unknown"] as const) {
      report.guest.allocation = allocation;
      expect(planInitialExecutionCapacity(report)).toMatchObject({ allocation, recommendedProfileId: null,
        applicability: allocation === "present" ? "existing-volume-out-of-scope" : allocation === "absent" ? "unallocated-observation-only" : "unknown" });
    }
  });

  it("uses observed per-class maxima for first-allocation video and raster limits", async () => {
    const f = await firstAllocationReport(), video = path.join(f.workspace, "public/clip.mp4"), image = path.join(f.workspace, "public/atlas.png");
    await mkdir(path.join(f.workspace, "public"));
    await writeFile(video, ""); await truncate(video, 40 * 1024 ** 2);
    const videoReport = await f.observe();
    expect(videoReport.host.inventory).toMatchObject({ largestLargeMedia: { path: "public/clip.mp4", size: 40 * 1024 ** 2 }, scope: { mediaClassMaximaVersion: 1 } });
    const videoPlan = planInitialExecutionCapacity(videoReport);
    expect(videoPlan.choices.map(choice => choice.observedEnvelope.status)).toEqual(["exceeds", "exceeds", "within"]);
    expect(videoPlan.smallestObservedEnvelope).toBe("capacity-128-media64-v3");
    await writeFile(image, ""); await truncate(image, 40 * 1024 ** 2);
    const imageReport = await f.observe();
    expect(imageReport.host.inventory?.largestBaseMedia).toMatchObject({ path: "public/atlas.png", size: 40 * 1024 ** 2 });
    const imagePlan = planInitialExecutionCapacity(imageReport);
    expect(imagePlan.choices.every(choice => choice.observedEnvelope.status === "exceeds")).toBe(true);
    expect(imagePlan.smallestObservedEnvelope).toBeNull();
    expect(imagePlan.evidence.formatBasis).toBe("path-extension-not-content-validation");
  });

  it("keeps incomplete and unverified first-allocation inventories unknown", async () => {
    const { report } = await firstAllocationReport();
    for (const scope of [{ complete: false }, { scope: { ...report.host.inventory!.scope, unverifiedCanvasCandidateCount: 1 } }, { scope: { ...report.host.inventory!.scope, separateMedia: false } }]) {
      const incomplete = { ...report, host: { ...report.host, inventory: { ...report.host.inventory!, ...scope } } };
      const plan = planInitialExecutionCapacity(incomplete);
      expect(plan.smallestObservedEnvelope).toBeNull();
      expect(plan.choices.every(choice => choice.observedEnvelope.status === "unknown")).toBe(true);
    }
    report.host.inventory = null;
    expect(planInitialExecutionCapacity(report).choices.every(choice => choice.observedEnvelope.status === "unknown")).toBe(true);
  });

  it("does not infer a large-media class or usable capacity from an older inventory", async () => {
    const { report } = await firstAllocationReport(), inventory = report.host.inventory!;
    inventory.mediaBytes = 40 * 1024 ** 2; inventory.largestMedia = { path: "old.mp4", size: inventory.mediaBytes };
    delete inventory.scope.mediaClassMaximaVersion;
    const plan = planInitialExecutionCapacity(report);
    expect(plan.smallestObservedEnvelope).toBeNull();
    expect(plan.choices.every(choice => choice.observedEnvelope.status === "unknown")).toBe(true);
    inventory.mediaBytes = 129 * 1024 ** 2;
    expect(planInitialExecutionCapacity(report).choices.every(choice => choice.observedEnvelope.status === "exceeds")).toBe(true);
  });

  it("exposes first-allocation planning without inspection, recovery or approval authority", async () => {
    const { report } = await firstAllocationReport(), f = fixture(), controller = new AbortController();
    const plan = planInitialExecutionCapacity(report); f.planFirstAllocation.mockResolvedValue(plan);
    const result = await f.call({ action: "plan_first_allocation" }, controller.signal);
    expect(result.details).toEqual({ firstAllocationPlan: plan });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(plan) }]);
    expect(f.planFirstAllocation).toHaveBeenCalledExactlyOnceWith(controller.signal);
    for (const operation of [f.inspect, f.recover, f.review, f.adopt, f.capacity, f.planCapacity]) expect(operation).not.toHaveBeenCalled();
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("Inspect");
  });

  it("rejects first-allocation selectors and approvals before observing anything", async () => {
    const f = fixture();
    for (const extra of [{ profileId: "capacity-64-v1" }, { targetProfileId: "capacity-128-v2" }, { generation: "7" }, { reviewId: "a".repeat(64) }, { approved: true }, { paths: [] }, { maxEdge: 512 }])
      await expect(f.call({ action: "plan_first_allocation", ...extra } as never)).rejects.toThrow("only action");
    for (const operation of [f.planFirstAllocation, f.inspect, f.recover, f.review, f.adopt, f.capacity, f.planCapacity]) expect(operation).not.toHaveBeenCalled();
    const unavailable = createIsolatedRecoveryTool(f.inspect, f.recover);
    await expect(unavailable.execute("unavailable-first-allocation", { action: "plan_first_allocation" }, undefined, undefined, {} as never)).rejects.toThrow("First-allocation planning is unavailable");
  });

  it("honors first-allocation cancellation and keeps uncertain recovery bound to its original operation", async () => {
    const { report } = await firstAllocationReport(), f = fixture(), pre = new AbortController(); pre.abort();
    await expect(f.call({ action: "plan_first_allocation" }, pre.signal)).rejects.toThrow();
    expect(f.planFirstAllocation).not.toHaveBeenCalled();
    const during = new AbortController();
    f.planFirstAllocation.mockImplementationOnce(async () => { during.abort(); return planInitialExecutionCapacity(report); });
    await expect(f.call({ action: "plan_first_allocation" }, during.signal)).rejects.toThrow();
    f.recover.mockRejectedValueOnce(new Error("Original recovery unknown"));
    await f.call({ action: "inspect" });
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("Original recovery unknown");
    f.planFirstAllocation.mockResolvedValue(planInitialExecutionCapacity(report));
    await f.call({ action: "plan_first_allocation" });
    await f.call({ action: "inspect" });
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("uncertain");
    expect(f.recover).toHaveBeenCalledOnce();
  });

  it.each(CAPACITY_PROFILES)("returns the selected $id candidate without enabling, approving or recovering anything", async profile => {
    const f = fixture(), controller = new AbortController();
    const result = await f.call({ action: "plan_capacity", profileId: profile.id }, controller.signal);
    expect(result.details).toMatchObject({ capacityProposal: { profile, authorization: "none", readyForMigration: false, runtimeEnabled: false, assessment: "unknown" } });
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") expect(JSON.parse(result.content[0].text)).toEqual((result.details as { capacityProposal: unknown }).capacityProposal);
    expect(f.planCapacity).toHaveBeenCalledExactlyOnceWith(profile.id, controller.signal);
    for (const mutation of [f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(mutation).not.toHaveBeenCalled();
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("Inspect");
  });

  it.each([
    { generation: "7" }, { reviewId: "a".repeat(64) }, { paths: ["public/frame.png"] }, { maxEdge: 512 }, { approved: true }, { migrate: true },
  ])("rejects non-planning arguments before its callback: %j", async extra => {
    const f = fixture();
    await expect(f.call({ action: "plan_capacity", profileId: "capacity-128-v1", ...extra } as never)).rejects.toThrow("only action and one profileId");
    for (const operation of [f.planCapacity, f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([undefined, "current-64", "capacity-512-v1", true])("refuses an absent or unknown profile instead of choosing a default: %s", async profileId => {
    const f = fixture();
    await expect(f.call({ action: "plan_capacity", profileId } as never)).rejects.toThrow();
    for (const operation of [f.planCapacity, f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(operation).not.toHaveBeenCalled();
  });

  it("keeps capacity argument-free and refuses profile selection in recovery actions", async () => {
    const f = fixture();
    await expect(f.call({ action: "capacity", profileId: "capacity-64-v1" })).rejects.toThrow("Capacity accepts only action");
    for (const action of ["inspect", "review", "recover", "verify", "adopt", "optimize"] as const)
      await expect(f.call({ action, profileId: "capacity-64-v1" })).rejects.toThrow("only for a read-only plan_capacity");
    for (const operation of [f.planCapacity, f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(operation).not.toHaveBeenCalled();
  });

  it("reports unavailable planning without falling back to status, approval or another capacity action", async () => {
    const f = fixture(), tool = createIsolatedRecoveryTool(f.inspect, f.recover, { review: f.review, adopt: f.adopt, capacity: f.capacity });
    await expect(tool.execute("unavailable", { action: "plan_capacity", profileId: "capacity-128-v1" }, undefined, undefined, {} as never)).rejects.toThrow("Capacity proposals are unavailable");
    for (const operation of [f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(operation).not.toHaveBeenCalled();
  });

  it("honors cancellation before and during passive planning", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.call({ action: "plan_capacity", profileId: "capacity-128-v1" }, controller.signal)).rejects.toThrow();
    expect(f.planCapacity).not.toHaveBeenCalled();
    const late = new AbortController();
    f.planCapacity.mockImplementationOnce(async profileId => { late.abort(); return planExecutionCapacityProposal({ profileId }); });
    await expect(f.call({ action: "plan_capacity", profileId: "capacity-256-v1" }, late.signal)).rejects.toThrow();
    expect(f.planCapacity).toHaveBeenCalledOnce();
    for (const operation of [f.inspect, f.recover, f.review, f.adopt, f.capacity]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the original uncertain recovery across a candidate proposal; unavailable=%s", async unavailable => {
    const f = fixture(); f.recover.mockRejectedValueOnce(new Error("Original recovery result unknown"));
    await f.call({ action: "inspect" });
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("result unknown");
    if (unavailable) f.planCapacity.mockRejectedValueOnce(new Error("Passive proposal unavailable"));
    const planning = f.call({ action: "plan_capacity", profileId: "capacity-256-v1" });
    if (unavailable) await expect(planning).rejects.toThrow("proposal unavailable"); else await expect(planning).resolves.toMatchObject({ details: { capacityProposal: { authorization: "none" } } });
    await f.call({ action: "inspect" });
    await expect(f.call({ action: "recover", generation: "7" })).rejects.toThrow("uncertain");
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.planCapacity).toHaveBeenCalledOnce(); expect(f.adopt).not.toHaveBeenCalled();
  });

  it("keeps an unknown adoption bound to its original review after selecting another candidate", async () => {
    const f = fixture(), retained: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), files: [], blockers: [], approved: false, expiresAt: "2099-01-01T00:00:00Z" };
    f.review.mockResolvedValue(retained); f.adopt.mockRejectedValue(new Error("Original adoption unknown"));
    await f.call({ action: "review", generation: "7" });
    await expect(f.call({ action: "adopt", reviewId: retained.reviewId })).rejects.toThrow("adoption unknown");
    await f.call({ action: "plan_capacity", profileId: "capacity-128-v1" });
    await expect(f.call({ action: "adopt", reviewId: retained.reviewId })).rejects.toThrow("uncertain");
    expect(f.adopt).toHaveBeenCalledOnce(); expect(f.recover).not.toHaveBeenCalled();
  });

  it.each([
    { patch: { dirty: true }, blocked: "volume-clean" },
    { patch: { syncPending: true }, blocked: "volume-pending" },
    { patch: { transition: { from: "resident", to: "archived" } }, blocked: "volume-pending" },
    { patch: { taskPhase: "running" }, blocked: "volume-active" },
    { patch: { taskPhase: "cancel-requested" }, blocked: "volume-active" },
    { patch: { taskPhase: "finished-awaiting-ack" }, blocked: "volume-active" },
    { patch: { taskPhase: "expired-uncertain" }, blocked: "volume-pending" },
  ] as const)("blocks known negative guest metadata without manufacturing positive lifecycle evidence: $patch", async ({ patch, blocked }) => {
    const directory = await temporaryTestDirectory("ohmygame-capacity-negative-");
    try {
      const report = await inspectExecutionCapacity({ projectId: "capacity-fixture", workspace: directory, localImageAnchor: async () => { throw new Error("No image ledger fixture"); } });
      const idle = { generation: "7", residency: "resident" as const, dirty: false, syncPending: false, taskPhase: "idle" as const, transition: null };
      report.guest.currentProjectStateKnown = true; report.guest.project = { ...idle, ...patch };
      const proposal = proposeExecutionCapacity(report, "capacity-128-v1");
      expect(proposal).toMatchObject({ assessment: "blocked", authorization: "none", readyForMigration: false, runtimeEnabled: false });
      expect(proposal.constraints.find(item => item.code === blocked)?.status).toBe("blocked");
      for (const code of ["migration-direction", "volume-peak-bytes", "volume-peak-inodes", "guest-filesystem-inodes"])
        expect(proposal.constraints.find(item => item.code === code)?.status).toBe("unknown");
      report.guest.currentProjectStateKnown = false;
      const stale = proposeExecutionCapacity(report, "capacity-128-v1");
      expect(stale.assessment).toBe("unknown");
      for (const code of ["volume-clean", "volume-active", "volume-pending"])
        expect(stale.constraints.find(item => item.code === code)?.status).toBe("unknown");
      report.guest.currentProjectStateKnown = true; report.guest.project = idle;
      const unchanged = proposeExecutionCapacity(report, "capacity-128-v1");
      for (const code of ["volume-clean", "volume-active", "volume-pending"])
        expect(unchanged.constraints.find(item => item.code === code)?.status).toBe("unknown");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("adapts passive metadata without claiming a complete seed, real old-volume capacity or inode headroom", async () => {
    const directory = await temporaryTestDirectory("ohmygame-capacity-proposal-");
    try {
      await writeFile(path.join(directory, "main.js"), "export const fixture = true;\n");
      const before = await readdir(directory);
      const report = await inspectExecutionCapacity({ projectId: "capacity-fixture", workspace: directory, localImageAnchor: async () => { throw new Error("No image ledger fixture"); } });
      const proposal = proposeExecutionCapacity(report, "capacity-128-v1");
      expect(proposal).toMatchObject({ projectId: "capacity-fixture", basis: "eligible-workspace-metadata-with-unverified-canvas-excluded", authorization: "none", readyForMigration: false, runtimeEnabled: false, assessment: "unknown", contentOnlySmallestProfileId: null });
      const constraint = (code: string) => proposal.constraints.find(item => item.code === code);
      expect(constraint("source-set")?.required).toBe(Buffer.byteLength("export const fixture = true;\n"));
      for (const code of ["inventory-incomplete", "migration-direction", "volume-peak-bytes", "volume-peak-inodes", "global-volume-logical", "guest-physical-headroom", "guest-filesystem-inodes", "host-filesystem-inodes", "recovery-envelope"])
        expect(constraint(code)?.status).toBe("unknown");
      expect(constraint("migration-direction")).not.toHaveProperty("required");
      const known = structuredClone(report);
      Object.assign(known.recovery, { status: "complete", localImageStorage: "included" });
      Object.assign(known.recovery.filesystem, { status: "complete", availableBytes: 0 });
      Object.assign(known.recovery.promises, { ledger: "known" }); known.recovery.promises.sameDevice.diskBytes = 0;
      const noSpace = proposeExecutionCapacity(known, "capacity-64-v1");
      expect(noSpace.assessment).toBe("blocked");
      expect(noSpace.constraints.find(item => item.code === "host-physical-headroom")).toMatchObject({ status: "blocked", available: 0 });
      known.recovery.promises.ledger = "uncertain";
      const unknownSpace = proposeExecutionCapacity(known, "capacity-64-v1");
      expect(unknownSpace.assessment).toBe("unknown");
      expect(unknownSpace.constraints.find(item => item.code === "host-physical-headroom")).toMatchObject({ status: "unknown" });
      expect(unknownSpace.constraints.find(item => item.code === "host-physical-headroom")).not.toHaveProperty("available");
      expect(await readdir(directory)).toEqual(before); expect(await readFile(path.join(directory, "main.js"), "utf8")).toBe("export const fixture = true;\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("agent tools", () => {
  it("describes identity image preparation and explicit runtime resizing without categorical size defaults", async () => {
    const directory = await temporaryTestDirectory("ohmygame-image-policy-description-");
    const projects = new ProjectManager(directory), runner = new ToolRunner(directory, { generate: vi.fn() });
    try {
      const project = await projects.create("Offline image policy", "web-game");
      const tools = createAgentTools(project, runner, projects), tool = tools.find(tool => tool.name === "optimize_image_asset")!;
      expect(tool.description).toContain("Default identity preparation preserves original dimensions and pixels");
      expect(tool.description).toContain("Set maxEdge only for an explicit runtime derivative");
      expect(tool.description).toContain("atlas layout and anchors");
      expect(tool.description).toContain("do not verify device performance or FPS");
      expect(tool.description).not.toContain("Default maxEdge 1024");
      expect(tool.description).not.toContain("small icons");
      const generate = tools.find(tool => tool.name === "generate_image")!;
      expect(generate.description).toContain("preserves dimensions by default");
      expect(generate.description).toContain("execution transfer budgets");
      expect(generate.description).not.toContain("512 KiB");
      expect(generate.description).not.toContain("1024px maximum edge");
    } finally { await runner.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("reuses a completed generation across continuation without a second paid submission", async () => {
    const directory = await temporaryTestDirectory("ohmygame-continue-media-");
    const projects = new ProjectManager(directory), project = await projects.create("Continue", "web-game");
    const generate = vi.fn<ImageGenerator["generate"]>(async () => ({ bytes: referencePng(), mediaType: "image/png" }));
    const runner = new ToolRunner(directory, { generate });
    const guard = new AutoContinueTools(createAgentTools(project, runner, projects));
    const image = guard.wrap().find(tool => tool.name === "generate_image")!;
    try {
      const first = await image.execute("original", { prompt: "A forest moth" }, undefined, undefined, {} as never);
      expect(first.content[0]).toMatchObject({ text: expect.stringContaining("Local preparation preserves dimensions by default") });
      expect(first.content[0]).toMatchObject({ text: expect.stringContaining("Execution transfer budgets still apply") });
      await guard.prepare(new AbortController().signal);
      const replay = await image.execute("new-model-call", { prompt: "A forest moth" }, undefined, undefined, {} as never);
      expect(replay.details).toEqual(first.details);
      expect(replay.content).toEqual([expect.objectContaining({ text: expect.stringContaining("reused without executing it again") }), ...first.content]);
      expect(first.content[0]).not.toMatchObject({ text: expect.stringContaining("reused without executing it again") });
      expect(generate).toHaveBeenCalledOnce();
    } finally { await runner.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("queries an unknown generation through recovery and stops without buying a replacement", async () => {
    const directory = await temporaryTestDirectory("ohmygame-continue-unknown-");
    const projects = new ProjectManager(directory), project = await projects.create("Continue", "web-game");
    const generate = vi.fn<ImageGenerator["generate"]>().mockRejectedValue(new Error("Request result unknown"));
    const runner = new ToolRunner(directory, { generate });
    const guard = new AutoContinueTools(createAgentTools(project, runner, projects));
    const image = guard.wrap().find(tool => tool.name === "generate_image")!;
    try {
      await expect(image.execute("original", { prompt: "A forest moth" }, undefined, undefined, {} as never)).rejects.toThrow();
      await expect(guard.prepare(new AbortController().signal)).rejects.toThrow(/outcome.*unconfirmed/);
      expect(generate).toHaveBeenCalledOnce();
    } finally { await runner.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("looks up animation actions with the project's current model and rig", async () => {
    const directory = await temporaryTestDirectory("ohmygame-anim-model-");
    try {
      const projects = new ProjectManager(directory);
      const project = await projects.create("Animations", "web-game");
      const runner = new ToolRunner(directory, { generate: vi.fn() });
      const actions = vi.spyOn(runner, "animationActions").mockRejectedValue(new Error("Offline lookup ended"));
      const animate = createAgentTools(project, runner, projects).find(tool => tool.name === "animate_3d_asset")!;
      const model = { provider: "tripo", id: "P1-20260311" };
      await projects.setModelSelections(project.id, { "3d-generation": model, "3d-rig": { provider: "tripo", id: "v2.5-20260210" } });
      await writeFile(path.join(project.workspacePath, "character.glb"), TEST_GLB);
      await expect(animate.execute("lookup", { modelPath: "character.glb" }, undefined, undefined, {} as never)).rejects.toThrow("Offline lookup ended");
      expect(actions).toHaveBeenCalledWith(model, { rigModel: "v2.5-20260210" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("lists rig-specific animation names without uploading or generating a model", async () => {
    const directory = await temporaryTestDirectory("ohmygame-list-animation-actions-");
    const projects = new ProjectManager(directory), project = await projects.create("Animation catalog", "web-game");
    const animate = vi.fn(), generate = vi.fn(), animations = vi.fn(async (_signal, _model, options) => tripoActions(options?.rigModel, options?.rigType));
    const runner = new ToolRunner(directory, { generate: vi.fn() }, { generate, animate, animations });
    try {
      const model = { provider: "tripo", id: "v3.1-20260211" };
      await projects.setModelSelections(project.id, { "3d-generation": model, "3d-rig": { provider: "tripo", id: "v2.5-20260210" } });
      const registered = createAgentTools(project, runner, projects), guard = new AutoContinueTools(registered);
      const tool = guard.wrap().find(tool => tool.name === "list_animation_actions")!;
      const result = await tool.execute("catalog", { rigType: "quadruped" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ animationActions: { model, options: { rigModel: "v2.5-20260210", rigType: "quadruped" }, actions: [{ id: "preset:quadruped:walk", name: "Walk" }] } });
      expect(animations).toHaveBeenCalledOnce(); expect(animate).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
      expect(activePiToolNames([], [tool.name])).toContain(tool.name);
      expect(projectPiToolNames("planning", [], [tool.name])).toContain(tool.name);
      const cancelled = new AbortController(); cancelled.abort();
      await expect(tool.execute("cancelled-catalog", {}, cancelled.signal, undefined, {} as never)).rejects.toThrow();
      expect(animations).toHaveBeenCalledOnce();
      animations.mockRejectedValueOnce(new Error("Unknown animation from a failed catalog connection"));
      await expect(tool.execute("offline-catalog", {}, undefined, undefined, {} as never)).rejects.toThrow("failed catalog");
      await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
    } finally { await runner.close(); }
  });
  it("matches exact animation names with case/space normalization and rejects unavailable or ambiguous choices", () => {
    const library = tripoActions("v2.5-20260210", "quadruped");
    expect(findAnimationAction(library, "  wAlK  ").id).toBe("preset:quadruped:walk");
    for (const name of ["idle", "run", "attack"]) {
      let failure: unknown; try { findAnimationAction(library, name); } catch (error) { failure = error; }
      expect(getToolPreflightFailure(failure)).toEqual({ effect: "none", reason: "invalid_animation_action", disposition: "correctable" });
      expect(String(failure)).toContain('Available names for this rig: ["Walk"]');
    }
    expect(() => findAnimationAction([...library, { ...library[0]!, id: "other-walk" }], "Walk")).toThrow("Ambiguous");
    expect(() => findAnimationAction(library, "Wal")).toThrow("Unknown");
    expect(getToolPreflightFailure(Object.assign(new Error('Unknown animation "idle".'), { preflightFailure: { effect: "none", reason: "invalid_animation_action", disposition: "correctable" } }))).toBeUndefined();
  });
  it("corrects an unbound get_model_asset runtime path from project bindings without weakening ownership", async () => {
    const directory = await temporaryTestDirectory("ohmygame-model-reference-");
    const library = new AssetLibrary(directory); await library.load();
    const projects = new ProjectManager(directory, library); await projects.load();
    const project = await projects.create("Model reference", "web-game");
    await projects.addGeneratedAsset(project.id, "boar.glb", TEST_GLB);
    await mkdir(path.join(project.workspacePath, "public/media"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "public/media/bramble-boar-rigged.glb"), TEST_GLB);
    const generate = vi.fn(), runner = new ToolRunner(directory, { generate }, undefined, undefined, library); await runner.load();
    try {
      const guard = new AutoContinueTools(createAgentTools(project, runner, projects)), tool = guard.wrap().find(tool => tool.name === "get_model_asset")!;
      const adopt = vi.spyOn(projects, "ensureLibraryAsset"), prepare = vi.spyOn(projects, "materializeLibraryAsset");
      const input = { path: "public/media/bramble-boar-rigged.glb" };
      const failure = await tool.execute("unbound-model", input, undefined, undefined, {} as never).catch(error => error);
      expect(failure.statusCode).toBe(403); expect(getToolPreflightFailure(failure)?.reason).toBe("invalid_model_reference");
      expect(adopt).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
      await expect(guard.prepare(new AbortController().signal)).resolves.toBeUndefined();
      const listed = await tool.execute("list-bound-models", {}, undefined, undefined, {} as never);
      const bindings = (listed.details as { modelResources: { assetId: string; originalPath: string }[] }).modelResources;
      expect(bindings).toHaveLength(1); expect(bindings[0]!.originalPath).toBe("assets/generated/boar.glb");
      const result = await tool.execute("corrected-model-reference", { assetId: bindings[0]!.assetId }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ modelResources: { ready: true, assetId: bindings[0]!.assetId } });
      await expect(tool.execute("unbound-model", input, undefined, undefined, {} as never)).rejects.toThrow("does not match");
      expect(guard.recoverySummary).toContain("not_executed (invalid_model_reference)");
      expect(generate).not.toHaveBeenCalled();
    } finally { await runner.close(); }
  });

  it("keeps a failed recovery from turning into a paid generation after reopening", async () => {
    const directory = await temporaryTestDirectory("ohmygame-unresolved-recovery-");
    try {
      const projects = new ProjectManager(directory);
      const project = await projects.create("Recovery", "web-game");
      const generate = vi.fn<ImageGenerator["generate"]>();
      const openTool = (name = "generate_image") => createAgentTools(project, new ToolRunner(directory, { generate }), projects)
        .find(tool => tool.name === name)!;
      const ctx = {} as never;
      await expect(openTool("recover_media").execute("recover", { tool: "generate_image", recoverCallId: "old-call" }, undefined, undefined, ctx))
        .rejects.toThrow("original generation arguments");
      await expect(openTool("recover_media").execute("recover-with-input", { tool: "generate_image", recoverCallId: "old-call", originalArguments: { prompt: "A moth" } }, undefined, undefined, ctx))
        .rejects.toThrow(/No saved image result/);
      await expect(openTool().execute("rewritten", { prompt: "A forest moth" }, undefined, undefined, ctx))
        .rejects.toThrow(/old-call/);
      expect(generate).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("requires review after the SDK rejected a placeholder recovery ID before execution", async () => {
    const directory = await temporaryTestDirectory("ohmygame-placeholder-recovery-");
    try {
      const projects = new ProjectManager(directory);
      const project = await projects.create("Recovery", "web-game");
      const generate = vi.fn<ImageGenerator["generate"]>();
      const image = createAgentTools(project, new ToolRunner(directory, { generate }), projects)
        .find(tool => tool.name === "generate_image")!;
      const ctx = { sessionManager: { getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: image.name, id: "invalid-call", arguments: { prompt: "Moth", recoverCallId: null } }] } },
        { type: "message", message: { role: "toolResult", toolName: image.name, toolCallId: "invalid-call", isError: true } },
      ] } } as never;
      await expect(image.execute("omitted-id", { prompt: "Moth" }, undefined, undefined, ctx)).rejects.toThrow("Find the original request");
      expect(generate).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    { name: "generate_image", args: { prompt: "Moth", recoverCallId: "missing-original" }, attempted: false },
    { name: "generate_image", args: { recoverCallId: "null" }, attempted: false },
    { name: "recover_media", args: { tool: "generate_image", recoverCallId: "new" }, attempted: false },
    { name: "generate_image", args: { prompt: "Moth", recoverCallId: "null" }, attempted: true },
  ])("retains payment protection after rejecting $name with $args (journal=$attempted)", async ({ name, args, attempted }) => {
    const directory = await temporaryTestDirectory("ohmygame-rejected-recovery-");
    try {
      const projects = new ProjectManager(directory);
      const project = await projects.create("Recovery", "web-game");
      const generate = vi.fn<ImageGenerator["generate"]>();
      const runner = new ToolRunner(directory, { generate });
      vi.spyOn(runner, "mediaWasAttempted").mockResolvedValue(attempted);
      const image = createAgentTools(project, runner, projects).find(tool => tool.name === "generate_image")!;
      const ctx = { sessionManager: { getBranch: () => [
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, id: "rejected-call", arguments: args }] } },
        { type: "message", message: { role: "toolResult", toolName: name, toolCallId: "rejected-call", isError: true, content: [{ type: "text", text: `Validation failed for tool "${name}":\nInvalid field` }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "recover_media", id: "recovered-sibling", arguments: { tool: "generate_image", recoverCallId: "other-image" } }] } },
        { type: "message", message: { role: "toolResult", toolName: "recover_media", toolCallId: "recovered-sibling", isError: false } },
      ] } } as never;
      await expect(image.execute("clean", { prompt: "A moth" }, undefined, undefined, ctx)).rejects.toThrow("may already have been billed");
      expect(generate).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("maps enabled product tools to Pi tool names", () => {
    expect(planningPiToolNames()).toEqual(["read", "grep", "find", "ls", "questionnaire", "update_plan"]);
    expect(activePiToolNames([])).toEqual(["read", "write", "edit", "ls", "find", "grep", "update_plan"]);
    expect(activePiToolNames(["generate-image"])).toEqual([
      "read", "write", "edit", "ls", "find", "grep", "update_plan", "generate_image",
    ]);
    expect(activePiToolNames(["image-to-3d"])).toEqual([
      "read", "write", "edit", "ls", "find", "grep", "update_plan", "generate_3d_asset",
    ]);
    expect(activePiToolNames(["generate-video"])).toEqual([
      "read", "write", "edit", "ls", "find", "grep", "update_plan", "generate_video",
    ]);
    expect(activePiToolNames(["animate-3d"])).toEqual([
      "read", "write", "edit", "ls", "find", "grep", "update_plan", "animate_3d_asset",
    ]);
    expect(activePiToolNames(
      [],
      ["read", "generate_image", "web_search"],
    )).toEqual(["read", "write", "edit", "ls", "find", "grep", "update_plan"]);
    expect(projectPiToolNames("planning", ["generate-image"], ["canvas_check", "generate_canvas_media"])).toContain("canvas_check");
    expect(projectPiToolNames("planning", ["generate-image"], ["canvas_check", "generate_canvas_media"])).not.toContain("generate_canvas_media");
    expect(activePiToolNames(["generate-image"], ["canvas_check", "generate_canvas_media"])).toContain("generate_canvas_media");
    expect(activePiToolNames([], ["canvas_check", "generate_canvas_media"])).not.toContain("generate_canvas_media");
    expect(activePiToolNames([], ["canvas_initialize"])).toContain("canvas_initialize");
    expect(projectPiToolNames("planning", [], ["canvas_initialize"])).not.toContain("canvas_initialize");
    expect(projectPiToolNames("normal", [], ["questionnaire"])).not.toContain("questionnaire");
    expect(projectPiToolNames("executing", [], ["questionnaire"])).not.toContain("questionnaire");
    expect(projectPiToolNames("planning", [], ["questionnaire"])).toContain("questionnaire");
    expect(projectPiToolNames("planning", [], ["recall_image"])).toContain("recall_image");
    expect(activePiToolNames([], ["recall_image", "mcp", "bash"])).toContain("recall_image");
    expect(activePiToolNames([], ["recall_image", "mcp", "bash"])).not.toContain("mcp");
  });

  it("registers retained-change recovery only when the isolated backend provides it", async () => {
    expect(activePiToolNames([], ["recover_isolated_changes"])).toContain("recover_isolated_changes");
    expect(activePiToolNames([])).not.toContain("recover_isolated_changes");
    expect(projectPiToolNames("planning", [], ["recover_isolated_changes"])).not.toContain("recover_isolated_changes");
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation: "4" }));
    const recover = vi.fn(async () => ({ changed: ["public/hunter.glb"], recovery: "isolated-changes/fixture" }));
    const tool = createIsolatedRecoveryTool(inspect, recover);
    const call = (input: { action: "inspect" | "recover"; generation?: string }, signal?: AbortSignal) => tool.execute("recovery", input, signal, undefined, {} as never);
    await expect(call({ action: "recover", generation: "4" })).rejects.toThrow("Inspect");
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation: "5" })).rejects.toThrow("Inspect");
    expect(recover).not.toHaveBeenCalled();
    expect((await call({ action: "recover", generation: "4" })).content[0]).toMatchObject({ text: expect.stringContaining("public/hunter.glb") });
    expect(recover).toHaveBeenCalledExactlyOnceWith("4", undefined);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(call({ action: "inspect" }, cancelled.signal)).rejects.toThrow();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each([false, true])("inspects an uncertain recovery without repeating a possible publication; guestChangedFalse=%s", async (guestChangedFalse) => {
    let generation = "4";
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation }));
    const recover = vi.fn(async () => { throw Object.assign(new Error("Acknowledgement response lost"), guestChangedFalse ? { changed: false } : {}); });
    const tool = createIsolatedRecoveryTool(inspect, recover);
    const call = (input: { action: "inspect" | "recover"; generation?: string }) => tool.execute("recovery", input, undefined, undefined, {} as never);
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation })).rejects.toThrow("response lost");
    expect((await call({ action: "inspect" })).content[0]).toMatchObject({ text: expect.stringContaining("Do not retry") });
    await expect(call({ action: "recover", generation })).rejects.toThrow("uncertain");
    expect(recover).toHaveBeenCalledOnce();
    generation = "5";
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation })).rejects.toThrow("response lost");
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("permits fresh inspection after a confirmed not-started recovery refusal", async () => {
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation: "4" }));
    const recover = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Checkpoint is unfinished"), { recoveryNotStarted: true })).mockResolvedValueOnce({ changed: [] });
    const tool = createIsolatedRecoveryTool(inspect, recover);
    const call = (input: { action: "inspect" | "recover"; generation?: string }) => tool.execute("recovery", input, undefined, undefined, {} as never);
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation: "4" })).rejects.toThrow("Checkpoint");
    await expect(call({ action: "recover", generation: "4" })).rejects.toThrow("Inspect");
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation: "4" })).resolves.toMatchObject({ details: { changed: [] } });
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("reports the already-inspected legacy media blocker without another inspect/recover loop", async () => {
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: false, generation: "22", reason: "Existing runtime media was modified" }));
    const recover = vi.fn(async () => ({ changed: [] }));
    const tool = createIsolatedRecoveryTool(inspect, recover);
    await tool.execute("inspect", { action: "inspect" }, undefined, undefined, {} as never);
    await expect(tool.execute("recover", { action: "recover", generation: "22" }, undefined, undefined, {} as never)).rejects.toMatchObject({
      code: "ISOLATED_REVIEW_REQUIRED", recoveryNotStarted: true, message: expect.stringContaining("Do not repeat inspect/recover or regenerate"),
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it("lets the agent prepare a reviewed image at original dimensions before an explicit working size and exact adoption", async () => {
    const initial: IsolatedSourceReview = { reviewVersion: 2, reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), rawSnapshotId: "b".repeat(64), approved: false, expiresAt: "2099-01-01T00:00:00Z",
      files: [{ path: "public/frames/boss.png", kind: "image", change: "added", bytes: 728791, afterSha256: "c".repeat(64) }], blockers: [{ path: "public/frames/boss.png", reason: "Working return exceeds its current limit" }], optimizablePaths: ["public/frames/boss.png"] };
    const pending = { ...initial, reviewId: "d".repeat(64) };
    const prepared = { ...pending, reviewId: "e".repeat(64), preparedSnapshotId: "f".repeat(64), blockers: [] };
    const inspect = vi.fn(async () => ({ state: "unavailable", dirty: true, recoverable: false, generation: "7", reason: "Volume is stopped; request explicit read-only review" }));
    const review = vi.fn(async () => initial), optimize = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(prepared), adopt = vi.fn(async () => ({ changed: ["public/frames/boss.png"] }));
    const tool = createIsolatedRecoveryTool(inspect, vi.fn(), { review, optimize, adopt });
    const call = (id: string, input: Record<string, unknown>) => tool.execute(id, input as never, undefined, undefined, {} as never);
    await call("inspect", { action: "inspect" });
    await call("review", { action: "review", generation: "7" });
    expect(adopt).not.toHaveBeenCalled();
    await call("preserve", { action: "optimize", reviewId: initial.reviewId, paths: initial.optimizablePaths });
    expect(optimize.mock.calls[0][1]).toEqual({ paths: initial.optimizablePaths });
    await expect(call("stale", { action: "optimize", reviewId: initial.reviewId, paths: initial.optimizablePaths })).rejects.toThrow("current retained batch");
    await expect(call("blocked", { action: "adopt", reviewId: pending.reviewId })).rejects.toThrow("blocked files");
    await call("explicit-size", { action: "optimize", reviewId: pending.reviewId, paths: initial.optimizablePaths, maxEdge: 512 });
    expect(optimize.mock.calls[1][1]).toEqual({ paths: initial.optimizablePaths, maxEdge: 512 });
    await call("adopt", { action: "adopt", reviewId: prepared.reviewId });
    expect(adopt).toHaveBeenCalledExactlyOnceWith(prepared.reviewId, "adopt", undefined);
  });

  it("does not bypass an uncertain adoption with a new review, optimization or ordinary recovery", async () => {
    const initial: IsolatedSourceReview = { reviewId: "a".repeat(64), projectId: "fixture", generation: "7", snapshotId: "b".repeat(64), approved: false, expiresAt: "2099-01-01T00:00:00Z", files: [{ path: "notes.txt", kind: "text", change: "added", bytes: 4, afterSha256: "c".repeat(64) }], blockers: [] };
    const review = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, reviewId: "d".repeat(64) });
    const optimize = vi.fn(), recover = vi.fn(), adopt = vi.fn(async () => { throw new Error("ACK response lost"); });
    const tool = createIsolatedRecoveryTool(async () => ({ state: "recovery-pending", dirty: true, recoverable: true, generation: "7" }), recover, { review, optimize, adopt });
    const call = (input: Record<string, unknown>) => tool.execute("fixture", input as never, undefined, undefined, {} as never);
    await call({ action: "review", generation: "7" });
    await expect(call({ action: "adopt", reviewId: initial.reviewId })).rejects.toThrow("ACK response lost");
    await call({ action: "review", generation: "7" });
    await expect(call({ action: "adopt", reviewId: "d".repeat(64) })).rejects.toThrow("uncertain");
    await expect(call({ action: "optimize", reviewId: "d".repeat(64), paths: ["public/a.png"] })).rejects.toThrow("uncertain");
    await call({ action: "inspect" });
    await expect(call({ action: "recover", generation: "7" })).rejects.toThrow("uncertain");
    expect(adopt).toHaveBeenCalledOnce(); expect(optimize).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  });

  it("verifies an original transaction after tool recreation without submitting another recovery", async () => {
    const verify = vi.fn().mockRejectedValueOnce(new Error("The original ACK is not confirmed")).mockResolvedValueOnce({ changed: [], recovery: "isolated-changes/confirmed-fixture" });
    const recover = vi.fn(), adopt = vi.fn(), review = vi.fn();
    // A restarted tool has no reviewed closure state; the backend alone checks its exact approved record.
    const tool = createIsolatedRecoveryTool(async () => ({ state: "recovery-pending", dirty: true, recoverable: false }), recover, { review, adopt, verify });
    await expect(tool.execute("unconfirmed", { action: "verify", reviewId: "a".repeat(64) }, undefined, undefined, {} as never)).rejects.toThrow("not confirmed");
    const result = await tool.execute("confirmed", { action: "verify", reviewId: "a".repeat(64) }, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No replacement recovery or command was submitted") });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(review).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    await expect(tool.execute("malformed", { action: "verify", reviewId: "not-an-id" }, undefined, undefined, {} as never)).rejects.toThrow("original reviewed transaction");
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("requires a complete legacy review, blocks unknown reviews and retains uncertainty after adoption", async () => {
    const inspect = vi.fn(async () => ({ state: "recovery-pending", dirty: true, recoverable: false, generation: "22" }));
    const review = { reviewId: "a".repeat(64), generation: "22", projectId: "fixture", snapshotId: "b".repeat(64), files: [{ path: "tools/artprep.py", kind: "code" as const, change: "added" as const, bytes: 10, afterSha256: "c".repeat(64), preview: "untrusted" }], blockers: [] as Array<{ path: string; reason: string }>, approved: false, expiresAt: "2099-01-01T00:00:00Z" };
    const legacy = { review: vi.fn(async () => review), adopt: vi.fn(async () => { throw new Error("unknown publication result"); }) };
    const tool = createIsolatedRecoveryTool(inspect, vi.fn(async () => ({ changed: [] })), legacy);
    const call = (input: { action: "inspect" | "review" | "adopt"; generation?: string; reviewId?: string }) => tool.execute("call", input, undefined, undefined, {} as never);
    await expect(call({ action: "adopt", reviewId: review.reviewId })).rejects.toThrow("Review the complete");
    await call({ action: "inspect" });
    await expect(call({ action: "review", generation: "23" })).rejects.toThrow("Inspect");
    await call({ action: "review", generation: "22" });
    await expect(call({ action: "adopt", reviewId: "d".repeat(64) })).rejects.toThrow("Review");
    review.blockers.push({ path: "unknown.bin", reason: "unknown type" });
    await expect(call({ action: "adopt", reviewId: review.reviewId })).rejects.toThrow("blocked files");
    expect(legacy.adopt).not.toHaveBeenCalled();
    review.blockers.length = 0;
    await expect(call({ action: "adopt", reviewId: review.reviewId })).rejects.toThrow("unknown publication");
    await call({ action: "inspect" }); await call({ action: "review", generation: "22" });
    await expect(call({ action: "adopt", reviewId: review.reviewId })).rejects.toThrow("uncertain");
    expect(legacy.adopt).toHaveBeenCalledOnce();
  });

  it("uses the shared Pi tools for every project type", () => {
    expect(projectPiToolNames(
      "normal",
      ["generate-image", "generate-video"],
      ["read", "mcp", "web_search", "generate_image"],
    )).toEqual(["read", "write", "edit", "ls", "find", "grep", "update_plan", "generate_image", "generate_video"]);
    expect(projectPiToolNames(
      "planning",
      ["generate-image"],
      ["mcp", "questionnaire"],
    )).toEqual(["read", "grep", "find", "ls", "questionnaire", "update_plan"]);
    expect(projectPiToolNames("normal", [], ["web_search"])).toEqual([
      "read", "write", "edit", "ls", "find", "grep", "update_plan",
    ]);
  });

  it("makes the offline Three.js tool available to web games during implementation", async () => {
    const directory = await temporaryTestDirectory("ohmygame-agent-three-");
    try {
      const projects = new ProjectManager(directory);
      await projects.load();
      const game = await projects.create("Forest", "web-game");
      const runner = new ToolRunner(directory, { generate: vi.fn() });
      const registered = createAgentTools(game, runner, projects);
      const tools = registered.map((tool) => tool.name);
      expect(projectPiToolNames("normal", [], tools)).toContain("prepare_three_runtime");
      expect(projectPiToolNames("planning", [], tools)).not.toContain("prepare_three_runtime");
      const prepare = registered.find((tool) => tool.name === "prepare_three_runtime")!;
      const result = await prepare.execute("prepare", {}, undefined, undefined, {} as never);
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("three.module.js") }]);
      expect(await readdir(game.workspacePath)).not.toContain("node_modules");
      const general = await projects.create("Notes", "general");
      expect(createAgentTools(general, runner, projects).map((tool) => tool.name)).not.toContain("prepare_three_runtime");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["web-game", "general"] as const)("registers game use for %s only when a matching runtime adapter is available", async (type) => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-playtest-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Browser Game", type);
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const driver: GameRuntimeAdapter = {
      available: true,
      capabilities: WEB_GAME_USE_CAPABILITIES,
      request: async () => ({ operation: "closeAll" }),
      close: () => {},
    };

    expect(createAgentTools(project, runner, projects).some(({ name }) => name === "game_use")).toBe(false);
    const playtest = { driver, resolveOpenTarget: async () => ({ runtime: "web" as const, url: "http://127.0.0.1:43210/" }) };
    if (type === "general") {
      expect(project.webPreviewEnabled).toBe(true);
      expect(createAgentTools(project, runner, projects, undefined, playtest).some(({ name }) => name === "game_use")).toBe(true);
      await projects.setRunSettings(project.id, { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: false });
      expect(createAgentTools(project, runner, projects, undefined, playtest).some(({ name }) => name === "game_use")).toBe(false);
      await projects.setRunSettings(project.id, { startupDirectory: ".", startupScript: "dev", previewPath: "/", previewViewport: "fit", webPreviewEnabled: true });
    }
    expect(createAgentTools(project, runner, projects, undefined, playtest).some(({ name }) => name === "game_use")).toBe(true);
  });

  it("never offers plugin installation or external native preview to the main Agent", async () => {
    const projects = new ProjectManager(await temporaryTestDirectory("ohmygame-native-tools-"));
    const project = await projects.create("Bound project");
    const runner = new ToolRunner(project.workspacePath, { generate: vi.fn() });
    const names = createAgentTools(project, runner, projects).map(tool => tool.name);
    for (const name of ["install_plugin", "project_preview", "web_search"]) {
      expect(names).not.toContain(name);
      expect(activePiToolNames([], [name])).not.toContain(name);
    }
  });

  it("uses the actual Agent audio tool for an explicit voice candidate and unconditioned speech", async () => {
    const directory = await temporaryTestDirectory("ohmygame-agent-voice-");
    try {
      const projects = new ProjectManager(directory); await projects.load(); const project = await projects.create("Voice test");
      const library = new AssetLibrary(directory); await library.load();
      const model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
      const generate = vi.fn(async (_input: import("../src/shared/audio.js").AudioGenerationInput, _signal?: AbortSignal) => ({ bytes: referenceWav(), mediaType: "audio/wav" as const, model }));
      const runner = new ToolRunner(directory, { generate: vi.fn() } as unknown as ImageGenerator, undefined, undefined, library, undefined, { catalog: () => ({ models: [], providers: [] }), generate }); await runner.load();
      const tool = createAgentTools(project, runner, projects).find((item) => item.name === "generate_speech")!;
      expect((tool.parameters as { required: string[] }).required).not.toContain("referenceAssetId");
      await tool.execute("voice-candidate", { voiceDesign: true, voiceDescription: "Warm adult voice", text: "Good morning", model }, undefined, undefined, {} as never);
      expect(generate.mock.calls[0]![0]).toMatchObject({ voiceDesign: true, voiceDescription: "Warm adult voice", text: "Good morning" });
      expect(generate.mock.calls[0]![0].referenceAudio).toBeUndefined();
      await tool.execute("plain-speech", { text: "Begin the adventure", model }, undefined, undefined, {} as never);
      expect(generate.mock.calls[1]![0].referenceAudio).toBeUndefined(); expect(generate).toHaveBeenCalledTimes(2);
      const files = await listWorkspaceFiles(project.workspacePath);
      expect(files.filter((file) => file.path.endsWith(".wav"))).toHaveLength(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("generates an image into the current project workspace", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-tool-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const controller = new AbortController();
    const imageGenerator: ImageGenerator = {
      generate: async (_input, signal) => {
        expect(signal).toBe(controller.signal);
        return { bytes: await sharp({ create: { width: 32, height: 32, channels: 4, background: "transparent" } }).webp().toBuffer(), mediaType: "image/webp" };
      },
    };
    const runner = new ToolRunner(dataDirectory, imageGenerator);
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image");
    if (!tool) throw new Error("Expected image tool");

    const result = await tool.execute("call-1", { prompt: "A forest", size: "1536x1024" }, controller.signal, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = (result.details as { imageResource: { path: string } }).imageResource.path;

    expect(tool.name).toBe("generate_image");
    expect(relativePath).toMatch(/^assets\/generated\/image-[0-9a-f-]+\.webp$/);
    expect(text).toContain("Original retained");
    expect(result.details).toMatchObject({ artifact: { type: "image", path: relativePath, mediaType: "image/webp" } });
    expect((await sharp(await readFile(path.join(project.workspacePath, relativePath))).metadata()).width).toBe(32);
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

  it.each(["png", "webp"] as const)("passes original %s attachment bytes to a direct image request without Canvas", async (format) => {
    const directory = await temporaryTestDirectory("ohmygame-direct-attachment-");
    try {
      const projects = new ProjectManager(directory); await projects.load();
      const project = await projects.create("Direct reference");
      const bytes = format === "webp" ? await sharp(referencePng()).webp().toBuffer() : referencePng();
      const imageModel = format === "webp" ? { provider: "openai", id: "gpt-image-2.6-flare" } : undefined;
      const attachment = await new AgentAttachmentStore().store(project, { batchId: "f2da1f75-4d77-462f-a75b-48dff99b7212", name: `reference.${format}`, contents: bytes });
      const reference = `attachment:${attachment.batchId}/${attachment.id}`, runner = new ToolRunner(directory, { generate: vi.fn() });
      const run = vi.spyOn(runner, "run").mockRejectedValue(new Error("Offline request captured"));
      const tool = createAgentTools(project, runner, projects, undefined, undefined, undefined, "chat", undefined, ({ batchId, id }) => batchId === attachment.batchId && id === attachment.id).find(tool => tool.name === "generate_image")!;
      await expect(tool.execute("direct-reference", { prompt: "Forest", ...(imageModel ? { imageModel } : {}), imagePaths: [reference], resolution: "1K", aspectRatio: "1:1" }, undefined, undefined, {} as never)).rejects.toThrow("Offline request captured");
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]![1]).toMatchObject({ images: [{ mediaType: `image/${format}`, data: bytes.toString("base64") }] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["missing-authorizer", "other-branch", "authorization-changed", "text", "webp", "corrupt", "cancelled"])("rejects a %s attachment reference before generation", async kind => {
    const directory = await temporaryTestDirectory("ohmygame-image-attachment-");
    try {
      const projects = new ProjectManager(directory); await projects.load();
      const project = await projects.create("Attachment guard");
      const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: "gold" } }).png().toBuffer();
      const bytes = kind === "text" ? Buffer.from("untrusted text") : kind === "webp" ? await sharp(png).webp().toBuffer() : kind === "corrupt" ? png.subarray(0, 16) : png;
      const attachment = await new AgentAttachmentStore().store(project, { batchId: "f2da1f75-4d77-462f-a75b-48dff99b7212", name: kind === "text" ? "notes.txt" : "reference.data", contents: bytes });
      const reference = `attachment:${attachment.batchId}/${attachment.id}`;
      const runner = new ToolRunner(directory, { generate: vi.fn() });
      const run = vi.spyOn(runner, "run");
      const authorize = kind === "missing-authorizer" ? undefined : kind === "authorization-changed"
        ? vi.fn().mockReturnValueOnce(true).mockReturnValue(false) : () => kind !== "other-branch";
      const tool = createAgentTools(project, runner, projects, undefined, undefined, undefined, "chat", undefined, authorize).find(tool => tool.name === "generate_image")!;
      const controller = new AbortController(); if (kind === "cancelled") controller.abort();
      await expect(tool.execute("reference-guard", { prompt: "Forest", imagePaths: [reference], resolution: "1K", aspectRatio: "1:1" }, controller.signal, undefined, {} as never)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(path.join(project.workspacePath, ".data/agent-attachments", attachment.batchId, "files", attachment.relativePath))).toEqual(bytes);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps the generated run when durable original retention fails", async () => {
    const directory = await temporaryTestDirectory("ohmygame-image-retention-");
    try {
      const projects = new ProjectManager(directory);
      await projects.load();
      const project = await projects.create("Images");
      const bytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: "transparent" } }).png().toBuffer();
      const runner = new ToolRunner(directory, { generate: async () => ({ bytes, mediaType: "image/png" }) });
      await runner.load();
      vi.spyOn(projects, "addGeneratedWorkingImage").mockRejectedValueOnce(new Error("Original exceeds the 64 MiB secure retention limit"));
      const remove = vi.spyOn(runner, "removeRun");
      const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image")!;
      await expect(tool.execute("retention-failure", { prompt: "Test image" }, undefined, undefined, {} as never)).rejects.toThrow("generated result remains in tool run");
      expect(remove).not.toHaveBeenCalled();
      const [run] = await readdir(path.join(directory, "tools", "runs"));
      expect(run).toBeTruthy();
      const metadata = JSON.parse(await readFile(path.join(directory, "tools", "runs", run!, "run.json"), "utf8"));
      expect((await runner.file(run!, metadata.files[0].name))?.bytes).toEqual(bytes);
      // A historical provider could accept settings that today's creation tool would reject.
      const recovery = createAgentTools(project, runner, projects).find(tool => tool.name === "recover_media")!;
      const replay = vi.spyOn(runner, "run");
      await expect(recovery.execute("save-existing", { tool: "generate_image", recoverCallId: "retention-failure",
        originalArguments: { prompt: "Test image", outputFormat: "png", outputCompression: 95 } }, undefined, undefined, {} as never))
        .resolves.toHaveProperty("details.imageResource.ready", true);
      expect(replay).toHaveBeenCalledWith("generate-image", { prompt: "Test image", outputFormat: "png", outputCompression: 95 },
        undefined, project.id, expect.objectContaining({ imageRecoveryOnly: true }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reports an opaque PNG returned for a transparent sprite without regenerating", async () => {
    const directory = await temporaryTestDirectory("ohmygame-opaque-sprite-");
    try {
      const projects = new ProjectManager(directory); await projects.load();
      const project = await projects.create("Sprite");
      const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 100, g: 80, b: 40, alpha: 1 } } }).png().toBuffer();
      const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({ bytes, mediaType: "image/png" });
      const runner = new ToolRunner(directory, { generate }); await runner.load();
      const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image")!;
      const result = await tool.execute("sprite", { prompt: "An isolated transparent character", outputFormat: "png", background: "transparent" }, undefined, undefined, {} as never);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("no transparent pixels") });
      expect(result.details).toMatchObject({ imageResource: { ready: true, hasAlpha: true, hasTransparency: false } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("exposes configured image dimensions to the agent and forwards them to the generator", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-tool-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({
      bytes: Buffer.from("generated image"),
      mediaType: "image/png",
    });
    const runner = new ToolRunner(dataDirectory, { generate });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image");
    if (!tool) throw new Error("Expected image tool");

    expect(tool.parameters).toMatchObject({
      properties: {
        resolution: expect.any(Object),
        aspectRatio: expect.any(Object),
      },
    });
    await tool.execute("call-configured", {
      prompt: "A wide fantasy landscape",
      resolution: "2K",
      aspectRatio: "16:9",
    }, undefined, undefined, {} as never);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "A wide fantasy landscape",
      resolution: "2K",
      aspectRatio: "16:9",
    }), undefined);
  });

  it("forwards project references, a PNG mask and selected image parameters with conversation-scoped recovery", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-image-edit-");
    const projects = new ProjectManager(dataDirectory); await projects.load();
    const project = await projects.create("Image edit");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB84AAAAASUVORK5CYII=", "base64");
    await projects.addGeneratedAsset(project.id, "reference.png", png);
    await projects.addGeneratedAsset(project.id, "mask.png", png);
    const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({ bytes: png, mediaType: "image/png" });
    const runner = new ToolRunner(dataDirectory, { generate }); await runner.load();
    const run = vi.spyOn(runner, "run");
    const make = (scope: string) => createAgentTools(project, runner, projects, undefined, undefined, undefined, scope).find(({ name }) => name === "generate_image")!;
    const input = { prompt: "Keep the character and edit the background", imageModel: { provider: "openai-images", id: "gpt-image-2.5-sunburst" },
      resolution: "1K" as const, aspectRatio: "1:1" as const, imagePaths: ["assets/generated/reference.png"], maskPath: "assets/generated/mask.png",
      quality: "max" as const, outputFormat: "png" as const, background: "transparent" as const };
    await make("conversation-a").execute("same-call", input, undefined, undefined, {} as never);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ quality: "max", outputFormat: "png", background: "transparent",
      images: [{ mediaType: "image/png", data: png.toString("base64") }], mask: { mediaType: "image/png", data: png.toString("base64") } }), undefined);
    expect(run.mock.calls[0]?.[3]).toBe(project.id);
    expect(run.mock.calls[0]?.[4]?.recoveryId).toMatch(/^[a-f0-9]{64}$/);
    await make("conversation-b").execute("same-call", input, undefined, undefined, {} as never);
    expect(run.mock.calls[1]?.[4]?.recoveryId).not.toBe(run.mock.calls[0]?.[4]?.recoveryId);
  });

  it("offers a separate whole-reference call after rejecting a null mask and JPEG compression for PNG", async () => {
    const directory = await temporaryTestDirectory("ohmygame-whole-reference-");
    try {
      const projects = new ProjectManager(directory), project = await projects.create("Turnaround");
      const model = { provider: "openai", id: "gpt-image-2.5-sunburst" };
      await projects.setModelSelections(project.id, { image: model });
      const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "transparent" } }).png().toBuffer();
      const reference = await projects.addGeneratedAsset(project.id, "concept.png", png);
      const generate = vi.fn<ImageGenerator["generate"]>().mockResolvedValue({ bytes: png, mediaType: "image/png" });
      const runner = new ToolRunner(directory, { generate }); await runner.load();
      const tools = createAgentTools(project, runner, projects);
      const names = tools.map(tool => tool.name);
      const image = tools.find(tool => tool.name === "generate_image")!;
      const whole = tools.find(tool => tool.name === "generate_reference_image")!;
      const recover = tools.find(tool => tool.name === "recover_media")!;
      expect(activePiToolNames(["generate-image"], names)).toContain(whole.name);
      expect(activePiToolNames(["generate-video"], names)).not.toContain(whole.name);
      expect(projectPiToolNames("planning", ["generate-image"], names)).not.toContain(whole.name);
      const intended = { prompt: "Front T-pose view", imagePaths: [reference], resolution: "1K", aspectRatio: "3:4", quality: "high", background: "opaque" };
      const faulty = { ...intended, maskPath: "null", outputFormat: "png", outputCompression: 95, imageModel: model };
      const ctx = {} as never;
      const prepare = (args: Record<string, unknown>) => image.prepareArguments!(args);
      expect(() => prepare(faulty)).toThrow(/outputCompression.*maskPath.*fresh generate_reference_image/is);
      expect(() => prepare(faulty)).toThrow(JSON.stringify(intended));
      const override = { provider: "openai", id: "gpt-image-2.5-flare" };
      const explicit = { ...intended, outputFormat: "png", imageModel: override };
      expect(() => prepare({ ...faulty, imageModel: override })).toThrow(`fresh generate_image call with this exact object: ${JSON.stringify(explicit)}`);
      expect(() => prepare({ ...faulty, recoverCallId: "previous" })).not.toThrow(/fresh generate/);
      expect(() => prepare({ ...faulty, maskPath: "missing.png" })).not.toThrow(/fresh generate/);
      for (const extra of [{ maskPath: "null" }, { maskPath: "missing.png" }, { outputCompression: 95 }, { recoverCallId: "previous" }]) {
        await expect(whole.execute("invalid", { ...intended, ...extra }, undefined, undefined, ctx)).rejects.toThrow("No generation was submitted");
      }
      for (const imagePaths of [[], null]) {
        await expect(whole.execute("invalid", { ...intended, imagePaths }, undefined, undefined, ctx)).rejects.toThrow("imagePaths");
      }
      await expect(recover.execute("invalid", { tool: whole.name, recoverCallId: "missing-original", originalArguments: faulty }, undefined, undefined, ctx)).rejects.toThrow("No generation was submitted");
      expect(generate).not.toHaveBeenCalled();
      // Use a separate conversation so the failed recovery above cannot be mistaken for permission to submit.
      const fresh = createAgentTools(project, runner, projects, undefined, undefined, undefined, "fresh");
      await fresh.find(tool => tool.name === whole.name)!.execute("front", intended, undefined, undefined, ctx);
      expect(generate).toHaveBeenCalledTimes(1);
      const request = generate.mock.calls[0]![0];
      expect(request).toMatchObject({ prompt: intended.prompt, resolution: "1K", aspectRatio: "3:4", quality: "high", background: "opaque", images: [{ data: png.toString("base64") }] });
      for (const key of ["mask", "outputCompression", "outputFormat"]) expect(request).not.toHaveProperty(key);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["generate_image", "generate_reference_image"])("recovers a failed %s download after reopening without exposing its URL or submitting again", async (originalName) => {
    const directory = await temporaryTestDirectory("ohmygame-agent-image-recovery-");
    try {
      const projects = new ProjectManager(directory); await projects.load();
      const project = await projects.create("Images");
      const otherProject = await projects.create("Other project");
      const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "transparent" } }).png().toBuffer();
      const base = "http://127.0.0.1:43199/v1";
      const url = "http://127.0.0.1:43199/output.png?signature=private-fixture";
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: [{ url }] }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
      const openTool = async (owner = project, scope = "chat", toolName = "generate_image") => {
        const runner = new ToolRunner(directory, new OpenAIImageGenerator("fake-recovery-key", base, request));
        await runner.load();
        return createAgentTools(owner, runner, projects, undefined, undefined, undefined, scope).find(({ name }) => name === toolName)!;
      };
      const imagePath = await projects.addGeneratedAsset(project.id, "reference.png", png);
      await projects.addGeneratedAsset(otherProject.id, "reference.png", png);
      const referenceArgs = { prompt: "An amber lantern moth", quality: "high", imagePaths: [imagePath], resolution: "1K", aspectRatio: "1:1" };
      const args = originalName === "generate_reference_image" ? referenceArgs : { prompt: referenceArgs.prompt, quality: "high", size: "1024x1024" };
      const original = await openTool(project, "chat", originalName);
      const failure = original.execute("original-call", args, undefined, undefined, {} as never);
      await expect(failure).rejects.toThrow(JSON.stringify({ tool: originalName, recoverCallId: "original-call" }));
      await expect(failure).rejects.not.toThrow("private-fixture");
      const fresh = await openTool(project, "chat", originalName === "generate_image" ? "generate_reference_image" : "generate_image");
      await expect(fresh.execute("replacement", { ...referenceArgs, prompt: "The same amber-winged moth" }, undefined, undefined, {} as never)).rejects.toThrow(/original-call/);
      expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
      const recover = { tool: originalName, recoverCallId: "original-call" };
      const call = (id: string, input: object, name = originalName) => ({ type: "toolCall", id, name, arguments: input });
      const result = (id: string, isError: boolean, toolName = originalName) => ({ type: "message", message: { role: "toolResult", toolName, toolCallId: id, isError } });
      const branch = [
        { type: "message", message: { role: "assistant", content: [call(recover.recoverCallId, args), call("sibling", { prompt: "A different sprite" })] } },
        result(recover.recoverCallId, true), result("sibling", false),
      ];
      const ctx = { sessionManager: { getBranch: () => branch } } as never;
      // Simulate the pre-upgrade layout: provider result is durable but no agent marker exists.
      await rm(path.join(directory, "tools", "agent-media"), { recursive: true });
      await expect(fresh.execute("legacy-replacement", { ...referenceArgs, prompt: "A reworded moth" }, undefined, undefined, ctx)).rejects.toThrow(/original-call/);
      expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
      for (const foreign of [await openTool(otherProject, "chat", "recover_media"), await openTool(project, "other-chat", "recover_media")]) {
        await expect(foreign.execute("other-call", recover, undefined, undefined, ctx)).rejects.toThrow("No saved image result");
      }
      const reopened = await openTool(project, "chat", "recover_media");
      await expect(reopened.execute("no-history", { ...recover, originalArguments: { ...args, prompt: "Changed prompt" } }, undefined, undefined, {} as never)).rejects.toThrow("input or provider changed");
      const recovered = await reopened.execute("new-call", recover, undefined, undefined, ctx);
      expect(recovered.details).toMatchObject({ imageResource: { ready: true } });
      expect(JSON.stringify(recovered)).not.toContain("private-fixture");
      expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET", "GET"]);
      branch.push({ type: "message", message: { role: "assistant", content: [call("new-call", recover, "recover_media")] } }, result("new-call", false, "recover_media"));
      request.mockResolvedValueOnce(Response.json({ data: [{ b64_json: png.toString("base64") }] }));
      await expect(fresh.execute("new-asset", { ...referenceArgs, prompt: "A new tree" }, undefined, undefined, ctx)).resolves.toHaveProperty("details.imageResource.ready", true);
      expect(request).toHaveBeenCalledTimes(4);
      const afterDelivery = await openTool();
      await expect(afterDelivery.execute("new-asset", { ...referenceArgs, prompt: "A new tree" }, undefined, undefined, ctx)).resolves.toMatchObject({ details: { previouslyDeliveredCallId: "new-asset" } });
      expect(request).toHaveBeenCalledTimes(4);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects image inputs outside the project, symbolic links, non-PNG masks and incomplete dimensions before generation", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-image-paths-");
    const projects = new ProjectManager(dataDirectory); await projects.load();
    const project = await projects.create("Image paths");
    await projects.addGeneratedAsset(project.id, "reference.png", Buffer.from("reference"));
    await projects.addGeneratedAsset(project.id, "mask.jpg", Buffer.from("mask"));
    const outside = path.join(dataDirectory, "outside.png"); await writeFile(outside, "private-test-canary");
    await symlink(outside, path.join(project.workspacePath, "linked.png"));
    const generate = vi.fn<ImageGenerator["generate"]>();
    const runner = new ToolRunner(dataDirectory, { generate }); await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_image")!;
    const configured = { prompt: "Edit", resolution: "1K" as const, aspectRatio: "1:1" as const };
    for (const file of [outside, "../outside.png", "linked.png"]) {
      await expect(tool.execute(`bad-${file}`, { ...configured, imagePaths: [file] }, undefined, undefined, {} as never)).rejects.toThrow(/workspace|Symbolic|Invalid/);
    }
    await expect(tool.execute("bad-mask", { ...configured, imagePaths: ["assets/generated/reference.png"], maskPath: "assets/generated/mask.jpg" }, undefined, undefined, {} as never)).rejects.toThrow("require PNG");
    await expect(tool.execute("no-reference", { ...configured, maskPath: "assets/generated/mask.jpg" }, undefined, undefined, {} as never)).rejects.toThrow("requires at least one reference");
    await expect(tool.execute("no-dimensions", { prompt: "Edit", imagePaths: ["assets/generated/reference.png"] }, undefined, undefined, {} as never)).rejects.toThrow("resolution and aspect ratio together");
    await expect(tool.execute("too-many-references", { ...configured, imagePaths: Array(17).fill("assets/generated/reference.png") }, undefined, undefined, {} as never)).rejects.toThrow("up to 16");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects ambiguous recovery before Pi can normalize an optional null and explains the conflicting fields together", async () => {
    const directory = await temporaryTestDirectory("ohmygame-media-args-");
    try {
      const projects = new ProjectManager(directory); await projects.load();
      const project = await projects.create("Recovery");
      const runner = new ToolRunner(directory, { generate: vi.fn() });
      const run = vi.spyOn(runner, "run");
      const canvasBoard = vi.fn();
      const canvas = { board: canvasBoard } as unknown as import("../src/daemon/canvas-workspace.js").CanvasStore;
      const tools = createAgentTools(project, runner, projects, undefined, undefined, canvas);
      async function submit(name: string, args: AgentToolCall["arguments"]) {
        const tool = tools.find((candidate) => candidate.name === name)!;
        const result = await runToolCall({ type: "toolCall", id: "attempt", name, arguments: args }, {
          tools: [{ ...tool, execute: (id, input) => tool.execute(id, input, undefined, undefined, {} as never) }],
          assistantMessage: {} as never, context: { messages: [] },
        });
        if (result.isError) throw new Error(result.result.content.map((block) => block.type === "text" ? block.text : "").join("\n"));
        return result;
      }
      const badImage = { prompt: "Forest", size: "1024x1024", resolution: "1K", aspectRatio: "16:9", maskPath: "null", recoverCallId: "null" };
      const image = submit("generate_image", badImage);
      await expect(image).rejects.toThrow(/recoverCallId.*remove the size key.*Omit the unused maskPath/s);
      const badModel = submit("generate_3d_asset", { imagePath: "hero.png", imagePaths: [], sourcePath: "", recoverCallId: "null" });
      await expect(badModel).rejects.toThrow(/recoverCallId.*remove the imagePaths key.*Omit the unused sourcePath/s);
      for (const id of [null, "", "   ", "null", " NONE ", "undefined", false, 0]) {
        await expect(submit("generate_video", { prompt: "Forest", recoverCallId: id })).rejects.toThrow("recoverCallId requires the actual original ID");
        await expect(submit("generate_canvas_media", { nodeId: "node", boardId: "board", recoverJobId: id })).rejects.toThrow("recoverJobId requires the actual original ID");
      }
      await expect(submit("generate_image", { prompt: "Forest", recoverJobId: "old-job" })).rejects.toThrow(/Unknown field "recoverJobId".*use recover_media.*recoverCallId/);
      await expect(submit("generate_canvas_media", { nodeId: "node", boardId: "board", recoverJobId: "old", confirmedAudioJobId: "old" })).rejects.toThrow("Remove confirmedAudioJobId");
      expect(run).not.toHaveBeenCalled();
      expect(canvasBoard).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("recovers retained speech after a workspace save fails and the daemon reopens without the audio model", async () => {
    const directory = await temporaryTestDirectory("ohmygame-agent-audio-save-");
    const projects = new ProjectManager(directory); await projects.load();
    const project = await projects.create("Voice recovery");
    const input = { text: "Test voice", voiceDesign: true, voiceDescription: "Warm" };
    const bytes = referenceWav(), model = { provider: "volcengine-tts", id: "seed-audio-1.0" };
    const generate = vi.fn(async () => ({ bytes, model, mediaType: "audio/wav" as const }));
    const reopen = async (name = "generate_speech") => {
      const audio = name === "generate_speech" ? { catalog: () => ({ models: [], providers: [] }), generate } : undefined;
      const runner = new ToolRunner(directory, { generate: vi.fn() }, undefined, undefined, undefined, undefined, audio);
      await runner.load();
      const enabled = audio ? ["generate-speech" as const] : [];
      const registered = createAgentTools(project, runner, projects, undefined, undefined, undefined, "chat", () => enabled);
      expect(activePiToolNames(enabled, registered.map(tool => tool.name))).toContain(name);
      return registered.find(tool => tool.name === name)!;
    };
    const original = await reopen();
    const write = vi.spyOn(projects, "addGeneratedAsset").mockRejectedValueOnce(new Error("Fixture local write fault"));
    try { await expect(original.execute("voice-1", input, undefined, undefined, {} as never)).rejects.toThrow(/recoverCallId.*voice-1/); }
    finally { write.mockRestore(); }
    const fresh = await reopen("recover_media");
    const result = await fresh.execute("recover-2", { tool: "generate_speech", originalArguments: input, recoverCallId: "voice-1" }, undefined, undefined, {} as never);
    const saved = (result.details as { artifact: { path: string } }).artifact.path;
    expect(await readFile(path.join(project.workspacePath, saved))).toEqual(bytes);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("publishes a validated structured plan", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-tool-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "update_plan");
    if (!tool) throw new Error("Expected plan tool");

    const result = await tool.execute("call-plan", {
      explanation: " Starting implementation ",
      plan: [
        { step: " Inspect files ", status: "completed" },
        { step: "Implement change", status: "in_progress" },
      ],
    }, undefined, undefined, {} as never);

    expect(result.details).toEqual({ plan: {
      explanation: "Starting implementation",
      steps: [
        { step: "Inspect files", status: "completed" },
        { step: "Implement change", status: "in_progress" },
      ],
    } });
    expect(result.content).toEqual([{ type: "text", text: "Plan updated: 1/2 steps completed." }]);

    await expect(tool.execute("call-invalid", {
      plan: [
        { step: "First", status: "in_progress" },
        { step: "Second", status: "in_progress" },
      ],
    }, undefined, undefined, {} as never)).rejects.toThrow("at most one in_progress");
  });

  it("submits three WebP project views as separate PNGs and preserves all original files", async () => {
    const directory = await temporaryTestDirectory("ohmygame-agent-model-webp-");
    try {
      const projects = new ProjectManager(directory), project = await projects.create("Turnaround", "web-game");
      const generate = vi.fn<import("../src/daemon/model3d.js").Model3DGenerator["generate"]>().mockResolvedValue({ bytes: TEST_GLB, mediaType: "model/gltf-binary" });
      const runner = new ToolRunner(directory, { generate: vi.fn() }, { generate });
      await runner.load();
      const model = createAgentTools(project, runner, projects).find(tool => tool.name === "generate_3d_asset")!;
      const paths = ["front.webp", "left.webp", "back.webp"];
      const originals = await Promise.all(paths.map(async (file, index) => {
        const bytes = await sharp(referencePng({ width: 20 + index, height: 24 })).webp({ lossless: true }).toBuffer();
        await writeFile(path.join(project.workspacePath, file), bytes);
        return bytes;
      }));
      const originalCall = { imagePaths: paths, imagePath: "", sourcePath: "", options: { smartUv: false }, model: { provider: "tripo", id: "P1-20260311" } };
      expect(model.prepareArguments!(originalCall)).toEqual({ imagePaths: paths, options: {}, model: originalCall.model });
      await model.execute("three-webp-views", originalCall, undefined, undefined, {} as never);
      expect(originalCall).toMatchObject({ imagePath: "", sourcePath: "", options: { smartUv: false } });
      expect(generate).toHaveBeenCalledOnce();
      const { images } = generate.mock.calls[0]![0];
      expect(images).toHaveLength(3);
      for (const [index, image] of images.entries()) {
        const bytes = Buffer.from(image.data, "base64");
        expect(image.mediaType).toBe("image/png");
        expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 20 + index, height: 24, hasAlpha: true });
        expect(await sharp(bytes).raw().toBuffer()).toEqual(await sharp(originals[index]!).raw().toBuffer());
        expect(await readFile(path.join(project.workspacePath, paths[index]!))).toEqual(originals[index]);
      }
      await writeFile(path.join(project.workspacePath, "left.webp"), Buffer.from("broken image"));
      await expect(model.execute("corrupt-view", { imagePaths: paths }, undefined, undefined, {} as never)).rejects.toThrow("Could not convert the WebP");
      expect(generate).toHaveBeenCalledOnce();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps genuine 3D input conflicts and recovery requests out of the new modeling path", async () => {
    const directory = await temporaryTestDirectory("ohmygame-3d-inputs-");
    const projects = new ProjectManager(directory);
    const project = await projects.create("Views", "web-game");
    const runner = new ToolRunner(directory, { generate: vi.fn() });
    const run = vi.spyOn(runner, "run");
    const tool = createAgentTools(project, runner, projects).find(tool => tool.name === "generate_3d_asset")!;
    const imagePaths = ["front.png", "left.png", "back.png"];
    for (const fields of [
      { imagePath: "other.png" }, { imagePath: "null" }, { sourcePath: "existing.glb" },
      { options: { smartUv: true } }, { options: { referenceMode: "provided-views" } },
      { recoverCallId: "existing-call" }, { recoverJobId: "new" }, { imagePaths: ["front.png", "", "back.png"] },
    ]) {
      const attempt = tool.execute("failed", { imagePaths, prompt: "Keep a scar on the left hand", ...fields }, undefined, undefined, {} as never);
      await expect(attempt).rejects.toThrow("No generation was submitted");
      await expect(attempt).rejects.not.toThrow("with this object:");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks an incomplete turnaround and accepts a requested single-view study", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-tool-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const project = await projects.create("Game");
    const source = referencePng();
    const imagePath = await projects.addGeneratedAsset(project.id, "source.png", source);
    const generate = vi.fn(async () => ({ bytes: TEST_GLB, mediaType: "model/gltf-binary" as const }));
    const runner = new ToolRunner(dataDirectory, {
      generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }),
    }, {
      generate,
    });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_3d_asset");
    if (!tool) throw new Error("Expected 3D tool");

    await expect(tool.execute("formal-model", { imagePath }, undefined, undefined, {} as never)).rejects.toThrow("front, left, and back");
    const textOnly = { model: { input: ["text"] } } as never;
    await expect(tool.execute("text-only-formal", { imagePath }, undefined, undefined, textOnly)).rejects.toThrow("vision-capable main Agent");
    await expect(tool.execute("text-only-tripo", { imagePath, model: { provider: "tripo", id: "v3.1-20260211" },
      options: { pose: "t-pose", referenceMode: "provided-views" } }, undefined, undefined, textOnly)).rejects.toThrow("vision-capable main Agent");
    expect(generate).not.toHaveBeenCalled();
    const result = await tool.execute("requested-study", { imagePath, options: { referenceMode: "provided-views" } }, undefined, undefined, textOnly);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ images: [{ mediaType: "image/png", data: source.toString("base64") }] }), undefined);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated 3D model saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/model-[0-9a-f-]+\.glb$/);
    expect(await readFile(path.join(project.workspacePath, relativePath))).toEqual(TEST_GLB);
    const model = (await listWorkspaceFiles(project.workspacePath)).find((file) => file.path === relativePath);
    expect(model?.previewPath).toMatch(/^\.data\/asset-previews\/model-[0-9a-f-]+\.png$/);
    expect(await readFile(path.join(project.workspacePath, model?.previewPath ?? ""))).toEqual(source);
    expect(result.details).toEqual({ artifact: { type: "model", path: relativePath, mediaType: "model/gltf-binary" } });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
    const recover = createAgentTools(project, runner, projects).find(({ name }) => name === "recover_media")!;
    await expect(recover.execute("recover", { tool: tool.name, recoverCallId: "previous-model", originalArguments: { imagePath, options: { referenceMode: "turnaround" } } },
      undefined, undefined, textOnly)).rejects.toThrow("No saved 3D task");
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([true, false])("retains a large animated original and reports runnable resources honestly; splittable=%s", async (splittable) => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-animated-delivery-");
    const library = new AssetLibrary(dataDirectory), projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Animated character");
    const sourcePath = await projects.addGeneratedAsset(project.id, "source.glb", TEST_GLB);
    const io = new NodeIO(), document = await io.readBinary(await model3DFixture({ rigged: true, clips: ["ServerIdle", "ServerRun"] }));
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const vertices = splittable ? 90_000 : 180_000;
    primitive.getAttribute("POSITION")!.setArray(new Float32Array(vertices * 3));
    primitive.getAttribute("TEXCOORD_0")!.setArray(new Float32Array(vertices * 2));
    primitive.getAttribute("JOINTS_0")!.setArray(new Uint16Array(vertices * 4));
    const weights = new Float32Array(vertices * 4); for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
    primitive.getAttribute("WEIGHTS_0")!.setArray(weights);
    const animated = Buffer.from(await io.writeBinary(document));
    expect(animated.length).toBeGreaterThan(2 * 1024 * 1024);
    const animate = vi.fn(async () => ({ bytes: animated, mediaType: "model/gltf-binary" as const }));
    const runner = new ToolRunner(dataDirectory, { generate: vi.fn() }, { generate: vi.fn(), animate,
      animations: async () => [{ id: "preset:Idle", name: "Idle", category: "Fixture", subCategory: "Other" }, { id: "preset:Run", name: "Run", category: "Fixture", subCategory: "Other" }],
    }, undefined, library);
    await runner.load();
    try {
      const tool = createAgentTools(project, runner, projects).find(tool => tool.name === "animate_3d_asset")!;
      const result = await tool.execute("animate", { modelPath: sourcePath, actions: ["Idle", "Run"], model: { provider: "tripo", id: "v3.1-20260211" } }, undefined, undefined, {} as never);
      expect(animate).toHaveBeenCalledOnce();
      expect(result.details).toMatchObject({ savedClipNames: ["ServerIdle", "ServerRun"] });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Saved clip names: ServerIdle, ServerRun.") });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Requested actions: Idle, Run.") });
      const output = library.list().find(asset => asset.model3d?.animations?.includes("ServerRun"))!;
      expect(await readFile((await library.content(output.id)).absolutePath)).toEqual(animated);
      const resources = await readModelResources(project.workspacePath, output.id);
      expect(resources?.ready).toBe(true);
      expect(resources?.runtimeMode).toBe(splittable ? "split" : "media");
      expect(await readFile(path.join(project.workspacePath, resources!.originalPath))).toEqual(animated);
      expect(await readdir(path.join(project.workspacePath, "assets/generated"))).toEqual(["source.glb"]);
      await expect(projectFiles(project.workspacePath, [])).resolves.toBeDefined();
      if (splittable) {
        const json = JSON.parse(await readFile(path.join(project.workspacePath, resources!.runtimePath!), "utf8"));
        const files = Object.fromEntries(await Promise.all(resources!.resources.filter(file => !file.path.endsWith(".gltf")).map(async file => [path.posix.basename(file.path), await readFile(path.join(project.workspacePath, file.path))])));
        const restored = await io.readJSON({ json, resources: files });
        expect(restored.getRoot().listAnimations().map(clip => clip.getName())).toEqual(["ServerIdle", "ServerRun"]);
        expect(restored.getRoot().listAnimations().every(clip => clip.listChannels()[0]?.getTargetNode()?.getName() === "Root")).toBe(true);
        expect(restored.getRoot().listSkins()).toHaveLength(1);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining(resources!.runtimePath!) });
      } else {
        expect(resources!.runtimePath).toMatch(/^assets\/files\/models\/[a-f0-9]{64}\.glb$/);
        expect(await readFile(path.join(project.workspacePath, resources!.runtimePath!))).toEqual(animated);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining(resources!.runtimePath!) });
        expect(result.details).not.toHaveProperty("artifact");
      }
    } finally { await runner.close(); }
  }, 60_000);

  it("does not relabel an unsupported animation result as GLB", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-animation-format-");
    const library = new AssetLibrary(dataDirectory), projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Animation format");
    const sourcePath = await projects.addGeneratedAsset(project.id, "source.glb", TEST_GLB), original = fbxFixture();
    const retained = await library.add("animation.fbx", original);
    const runner = new ToolRunner(dataDirectory, { generate: vi.fn() }, { generate: vi.fn(),
      animations: async () => [{ id: 0, name: "Idle", category: "Fixture", subCategory: "Other" }],
    }, undefined, library);
    await runner.load();
    const run = vi.spyOn(runner, "run").mockResolvedValue({ id: "unsupported-animation", toolId: "animate-3d", files: [{ name: "animation.fbx", mediaType: retained.contentType, assetId: retained.id }] } as never);
    const file = vi.spyOn(runner, "file").mockResolvedValue({ bytes: original, mediaType: retained.contentType, assetId: retained.id });
    try {
      const tool = createAgentTools(project, runner, projects).find(tool => tool.name === "animate_3d_asset")!;
      await expect(tool.execute("animate", { modelPath: sourcePath, actions: ["Idle"] }, undefined, undefined, {} as never)).rejects.toThrow("not a supported GLB");
      expect(await readFile((await library.content(retained.id)).absolutePath)).toEqual(original);
      expect(await readdir(path.join(project.workspacePath, "assets/generated"))).toEqual(["source.glb"]);
    } finally { run.mockRestore(); file.mockRestore(); await runner.close(); }
  });

  it("generates a video from a project image", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-tool-");
    const library = new AssetLibrary(dataDirectory);
    const projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Game");
    await projects.addGeneratedAsset(project.id, "source.webp", Buffer.from("source image"));
    const videoGenerator: VideoGenerator = {
      generate: async (input) => {
        expect(input.prompt).toBe("Slow camera move");
        expect(input.model).toEqual(TEST_VIDEO_MODEL);
        expect(input.duration).toBe(8);
        expect(input.references).toHaveLength(1);
        expect(input.references?.[0]?.type).toBe("image");
        return { bytes: Buffer.from("generated mp4"), mediaType: "video/mp4" };
      },
    };
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) }, undefined, videoGenerator, library);
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_video");
    if (!tool) throw new Error("Expected video tool");

    const result = await tool.execute("call-1", { prompt: "Slow camera move", model: TEST_VIDEO_MODEL, imagePath: "assets/generated/source.webp", duration: 8 }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated video saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/video-[0-9a-f-]+\.mp4$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated mp4");
    expect(result.details).toEqual({ artifact: { type: "video", path: relativePath, mediaType: "video/mp4" } });
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });

  it("delivers an accepted video after a project write failure without another generation", async () => {
    const directory = await temporaryTestDirectory("ohmygame-agent-video-save-");
    const library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
    const generate = vi.fn<VideoGenerator["generate"]>().mockResolvedValue({ bytes: Buffer.from("video"), mediaType: "video/mp4" });
    const runner = () => new ToolRunner(directory, { generate: vi.fn() }, undefined, { generate }, library);
    const original = runner(), reopened = runner();
    try {
      await Promise.all([library.load(), projects.load(), original.load()]);
      const project = await projects.create("Video recovery");
      const imagePath = await projects.addGeneratedAsset(project.id, "reference.webp", Buffer.from("test reference"));
      const input = { prompt: "forest", model: TEST_VIDEO_MODEL, imagePath };
      const first = createAgentTools(project, original, projects).find(tool => tool.name === "generate_video")!;
      vi.spyOn(projects, "addGeneratedAsset").mockRejectedValueOnce(new Error("write unavailable"));
      await expect(first.execute("original-video", input, undefined, undefined, {} as never)).rejects.toThrow();
      await original.close();
      await reopened.load();
      const tools = createAgentTools(project, reopened, projects);
      const tool = tools.find(tool => tool.name === "generate_video")!;
      await expect(tool.execute("rephrased-video", { ...input, prompt: "the same forest" }, undefined, undefined, {} as never)).rejects.toThrow();
      await rm(path.join(project.workspacePath, imagePath));
      const ctx = { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "original-video", name: "generate_video", arguments: input }] } }] } };
      const result = await tools.find(candidate => candidate.name === "recover_media")!.execute("deliver-video", { tool: "generate_video", recoverCallId: "original-video" }, undefined, undefined, ctx as never);
      const item = result.content[0];
      expect(item?.type === "text" && item.text).toContain("Generated video saved");
      expect(generate).toHaveBeenCalledOnce();
      expect(await readdir(path.join(directory, "tools", "runs"))).toEqual([]);
    } finally { await original.close(); await reopened.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("applies the same full-request budget through the Agent video tool without modifying its workspace image", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-video-budget-"); let runner: ToolRunner | undefined;
    try {
      const library = new AssetLibrary(dataDirectory), projects = new ProjectManager(dataDirectory, library); await Promise.all([library.load(), projects.load()]);
      const project = await projects.create("Synthetic"), bytes = await sharp(referencePng({ width: 1024, height: 1024, color: 2, noise: true })).blur(0.7).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
      const source = await projects.addGeneratedAsset(project.id, "source.jpg", bytes), selected = seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!;
      let postedBytes = 0;
      const request = vi.fn<typeof fetch>(async (address, init) => {
        if (init?.method === "POST") { postedBytes = Buffer.byteLength(String(init.body)); expect(postedBytes).toBeLessThanOrEqual(VIDEO_REFERENCE_REQUEST_TARGET_BYTES); return Response.json({ id: "synthetic_agent_budget" }); }
        return String(address).endsWith("output.mp4") ? new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])) : Response.json({ status: "succeeded", content: { video_url: "http://127.0.0.1:43199/output.mp4" } });
      });
      const adapter = new KunpoVideoProvider({ name: "Synthetic", baseUrl: "http://127.0.0.1:43199/v1", apiKey: "synthetic-agent-budget-key" }, request, 0);
      runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("unused"), mediaType: "image/png" }) }, undefined, { generate: (input, signal) => adapter.generate(selected, input, signal) }, library); await runner.load();
      const tool = createAgentTools(project, runner, projects).find(tool => tool.name === "generate_video")!;
      const result = await tool.execute("synthetic-budget-call", { prompt: "Synthetic movement", imagePath: source, model: { provider: selected.provider, id: selected.id }, duration: 4, resolution: "480p", aspectRatio: "adaptive" }, undefined, undefined, {} as never);
      expect(postedBytes).toBeGreaterThan(0); expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(result.details).toMatchObject({ artifact: { type: "video", mediaType: "video/mp4" } }); expect(await readFile(path.join(project.workspacePath, source))).toEqual(bytes);
    } finally { await runner?.close(); await rm(dataDirectory, { recursive: true, force: true }); }
  });

  it("generates speech into the current project through the common audio tool", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-audio-");
    const library = new AssetLibrary(dataDirectory);
    const projects = new ProjectManager(dataDirectory, library);
    await Promise.all([library.load(), projects.load()]);
    const project = await projects.create("Story");
    const model = { provider: "volcengine-tts", id: "seed-tts-2.0" } as const;
    const generate = vi.fn().mockResolvedValue({ bytes: Buffer.from("generated mp3"), mediaType: "audio/mpeg" as const, model });
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) }, undefined, undefined, library, undefined, {
      catalog: () => ({ models: [], providers: [] }), generate,
    });
    await runner.load();
    const tool = createAgentTools(project, runner, projects).find(({ name }) => name === "generate_speech");
    if (!tool) throw new Error("Expected speech tool");

    const reference = await library.add("voice.wav", referenceWav(), { duration: 1, purpose: "reference" });
    const result = await tool.execute("call-speech", { text: "Welcome", referenceAssetId: reference.id, model, format: "mp3", sampleRate: 24_000 }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const relativePath = text.replace("Generated audio saved to ", "");

    expect(relativePath).toMatch(/^assets\/generated\/speech-[0-9a-f-]+\.mp3$/);
    expect(await readFile(path.join(project.workspacePath, relativePath), "utf8")).toBe("generated mp3");
    expect(result.details).toEqual({ artifact: { type: "audio", path: relativePath, mediaType: "audio/mpeg" } });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ operation: "speech", text: "Welcome", referenceAssetId: reference.id, referenceAudio: { bytes: referenceWav(), mediaType: "audio/wav" }, model }), undefined);
    expect(await readdir(path.join(dataDirectory, "tools", "runs"))).toEqual([]);
  });
  it("registers playable_add_node only for Interactive Story and creates the Node", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-playable-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const webGame = await projects.create("Browser Game");
    const story = await projects.create("Ash Club", "interactive-story");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    await createNodeCodebase(
      story.workspacePath,
      createPlayableStarterCodebase("Ash Club", { width: 1280, height: 720 }),
    );

    expect(createAgentTools(webGame, runner, projects).some(({ name }) => name === "playable_add_node")).toBe(false);
    const tool = createAgentTools(story, runner, projects).find(({ name }) => name === "playable_add_node");
    if (!tool) throw new Error("Expected the add Node tool");

    const result = await tool.execute("call-node", { preset: "blank", id: "opening" }, undefined, undefined, {} as never);

    expect(result.details).toEqual({ playableNode: {
      id: "opening",
      preset: "blank",
      files: ["nodes/opening/index.html", "nodes/opening/style.css", "nodes/opening/node.js"],
      signals: ["next"],
    } });
    const graph = JSON.parse(await readFile(path.join(story.workspacePath, "graph.json"), "utf8"));
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(["opening"]);
    expect(graph.entryNodeId).toBe("opening");
    await expect(tool.execute("call-dup", { preset: "blank", id: "opening" }, undefined, undefined, {} as never))
      .rejects.toThrow(/already exists/);
  });

  it("reports playable_check issues for Interactive Story projects", async () => {
    const dataDirectory = await temporaryTestDirectory("ohmygame-agent-playable-check-");
    const projects = new ProjectManager(dataDirectory);
    await projects.load();
    const webGame = await projects.create("Browser Game");
    const story = await projects.create("Ash Club", "interactive-story");
    const runner = new ToolRunner(dataDirectory, { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/webp" }) });
    await runner.load();
    await createNodeCodebase(
      story.workspacePath,
      createPlayableStarterCodebase("Ash Club", { width: 1280, height: 720 }),
    );

    expect(createAgentTools(webGame, runner, projects).some(({ name }) => name === "playable_check")).toBe(false);
    const tool = createAgentTools(story, runner, projects).find(({ name }) => name === "playable_check");
    if (!tool) throw new Error("Expected the check tool");

    const passing = await tool.execute("call-check", {}, undefined, undefined, {} as never);
    expect(passing.details).toEqual({ playableCheck: { mode: "draft", ok: true, issues: [] } });

    const graphPath = path.join(story.workspacePath, "graph.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    await writeFile(graphPath, JSON.stringify({ ...graph, entryNodeId: "missing" }));
    const failing = await tool.execute("call-check-again", { mode: "publish" }, undefined, undefined, {} as never);
    const text = failing.content[0]?.type === "text" ? failing.content[0].text : "";
    expect(failing.details).toMatchObject({ playableCheck: { mode: "publish", ok: false } });
    expect(text).toMatch(/publish validation issue/);
    expect(text).toContain("missing");
  });
});
