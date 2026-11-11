import type {
  ExecutionStorageNamespace,
  ExecutionStorageOverview,
} from "../shared/execution-storage.js";
import {
  inspectProjectSourceBudget,
  PROJECT_SOURCE_LIMITS,
  type ProjectSourceBudget,
} from "./isolated-project-files.js";
import {
  inspectRecoveryCapacity,
  planRecoverySpace,
  type LocalImageRecoveryAnchor,
} from "./recovery-space.js";
import {
  LEGACY_RASTER_BYTES,
  RASTER_BYTES,
  RASTER_PIXELS,
} from "./raster-policy.js";
import {
  planExecutionCapacityProposal,
  getRuntimeCapacityProfile,
  RUNTIME_CAPACITY_PROFILES,
  type CapacityProfileId,
} from "../shared/execution-capacity-profiles.js";

const MiB = 1024 * 1024;

export interface ExecutionCapacityOptions {
  projectId: string;
  workspace: string;
  namespace?: ExecutionStorageNamespace;
  localImageAnchor: () => Promise<LocalImageRecoveryAnchor>;
  /** The existing passive overview must not start, mount or repair a VM. */
  storageOverview?: () => Promise<ExecutionStorageOverview>;
}

/** Observations and upper bounds only. No returned field grants admission, approval or retry authority. */
export async function inspectExecutionCapacity(
  options: ExecutionCapacityOptions,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const started = performance.now(),
    observedAt = new Date().toISOString();
  const issues: string[] = [];
  let overview: ExecutionStorageOverview | null = null;
  if (options.storageOverview) {
    try {
      overview = await options.storageOverview();
    } catch {
      signal?.throwIfAborted();
      issues.push("guest-overview-unavailable");
    }
  }
  signal?.throwIfAborted();
  const currentSnapshot =
    overview?.dataStatus === "current" ? overview.snapshot : null;
  const reservationCoverageKnown =
    currentSnapshot?.capacityOverviewVersion === 1 &&
    Array.isArray(currentSnapshot.capacityReservations) &&
    !!options.namespace;
  const currentReservation = reservationCoverageKnown
    ? (currentSnapshot.capacityReservations?.find(
        (item) =>
          item.namespace === options.namespace &&
          item.projectId === options.projectId,
      ) ?? null)
    : null;
  const capacityReservationStatus = reservationCoverageKnown
    ? currentReservation
      ? ("pending" as const)
      : ("none" as const)
    : ("unknown" as const);
  const guestCurrent =
    overview?.dataStatus === "current" &&
    overview.snapshot?.countsTrusted === true &&
    (overview.snapshot.capacityOverviewVersion !== 1 ||
      (reservationCoverageKnown &&
        overview.snapshot.capacityReservations!.length === 0));
  const project = guestCurrent
    ? overview!.snapshot!.projects.find(
        (item) =>
          item.namespace === options.namespace &&
          item.projectId === options.projectId,
      )
    : undefined;
  const profileKnown =
    overview?.snapshot?.capacityOverviewVersion === 1 &&
    !!project &&
    (project.volumeProfileVersion === 0 ||
      (project.volumeProfileVersion === 2 &&
        project.sourceProfileId === "capacity-128-v2") ||
      (project.volumeProfileVersion === 3 &&
        project.sourceProfileId === "capacity-128-media64-v3"));
  const profile =
    profileKnown &&
    (project?.volumeProfileVersion === 2 || project?.volumeProfileVersion === 3)
      ? (project.sourceProfileId ?? undefined)
      : undefined;
  const activeProfileId = profileKnown
    ? (profile ?? ("current-64" as const))
    : null;
  const mediaSetLimit = profile
    ? getRuntimeCapacityProfile(profile).mediaBytes
    : PROJECT_SOURCE_LIMITS.mediaBytes;
  const effectiveLimits = {
    ...PROJECT_SOURCE_LIMITS,
    mediaBytes: mediaSetLimit,
    ...(profile === "capacity-128-media64-v3"
      ? {
          largeMediaFileBytes:
            getRuntimeCapacityProfile(profile).largeMediaFileBytes,
          largeMediaFilePolicy: "video-audio-glb-v1" as const,
        }
      : {}),
  };
  let inventory: ProjectSourceBudget | null = null;
  try {
    inventory = await inspectProjectSourceBudget(
      options.workspace,
      [],
      true,
      signal,
      { profile },
    );
  } catch {
    signal?.throwIfAborted();
    issues.push("host-inventory-unavailable");
  }
  signal?.throwIfAborted();
  let anchor: LocalImageRecoveryAnchor | undefined;
  try {
    anchor = await options.localImageAnchor();
  } catch {
    signal?.throwIfAborted();
    issues.push("local-image-anchor-unavailable");
  }
  const recovery = await inspectRecoveryCapacity(
    options.workspace,
    anchor,
    signal,
    profile,
  );
  if (recovery.localImageStorage === "not-supplied") {
    recovery.status = "incomplete";
    Object.assign(recovery.quota, {
      usedBytes: null,
      remainingBytes: null,
      entries: null,
      transactions: null,
    });
    recovery.promises.ledger = "uncertain";
    Object.assign(recovery.promises.own, {
      count: null,
      logicalBytes: null,
      diskBytes: null,
    });
    Object.assign(recovery.promises.sameDevice, {
      count: null,
      logicalBytes: null,
      diskBytes: null,
    });
  }
  signal?.throwIfAborted();
  const hostWithinProfile =
    !!inventory?.complete &&
    Object.values(inventory.overage).every((value) => value === 0);
  const maximumSourceAndMediaBytes =
    PROJECT_SOURCE_LIMITS.totalBytes + mediaSetLimit;
  let envelope: ReturnType<typeof planRecoverySpace> | null = null;
  if (profileKnown && recovery.filesystem.allocationUnitBytes !== null) {
    try {
      envelope = planRecoverySpace({
        ...(profile ? { profileId: profile } : {}),
        rawBytes: 72 * MiB,
        workingBytes: 64 * MiB,
        beforeBytes: maximumSourceAndMediaBytes,
        afterBytes: 72 * MiB,
        manifestBytes: 2 * MiB,
        reviewBytes: 8 * MiB,
        allocationUnitBytes: recovery.filesystem.allocationUnitBytes,
      });
    } catch {
      issues.push("current-envelope-estimate-unavailable");
    }
  } else issues.push("current-envelope-estimate-unavailable");
  if (!profileKnown) issues.push("active-volume-profile-unknown");
  const recoveryComplete =
    recovery.status === "complete" && recovery.localImageStorage === "included";
  const promisesKnown = recovery.promises.ledger === "known";
  const ownOutstanding = recovery.promises.own.count;
  const available = recovery.filesystem.availableBytes,
    outstanding = recovery.promises.sameDevice.diskBytes;
  const unreservedAfterFloor =
    promisesKnown && available !== null && outstanding !== null
      ? Math.max(0, available - outstanding - recovery.filesystem.floorBytes)
      : null;
  // Include the same intent allowance used by admission, but never reuse a promise
  // or claim that this estimate passed actual file/decoder/publication checks.
  const quotaNeed = envelope ? envelope.requiredBytes + 16384 : null;
  const quotaEstimate =
    hostWithinProfile &&
    recoveryComplete &&
    quotaNeed !== null &&
    recovery.quota.remainingBytes !== null &&
    ownOutstanding === 0
      ? quotaNeed <= recovery.quota.remainingBytes
      : null;
  const diskEstimate =
    hostWithinProfile &&
    envelope &&
    unreservedAfterFloor !== null &&
    ownOutstanding === 0
      ? envelope.diskBytes <= unreservedAfterFloor
      : null;
  const recommendations: Array<{ code: string; message: string }> = [];
  const recommend = (code: string, message: string) =>
    recommendations.push({ code, message });
  if (!inventory?.complete)
    recommend(
      "complete-host-inventory",
      "Obtain a complete eligible-workspace metadata inventory before planning. Unavailable values are unknown; an incomplete scan reports lower bounds. This action does not inspect image pixels or validate file content.",
    );
  if (inventory?.overage.mediaBytes)
    recommend(
      "media-set-over-limit",
      profileKnown
        ? `The complete eligible media set exceeds the current ${mediaSetLimit / MiB} MiB contract. Incremental upload or smaller transport chunks do not change this limit. Keep originals; choose an explicitly reviewed runtime derivative or another supported workflow. Do not regenerate or silently resize.`
        : "The complete eligible media set exceeds the default legacy 64 MiB host limit; the active volume profile is unknown. Keep originals and verify the current guest profile before drawing a conclusion.",
    );
  if (inventory?.overage.mediaFileBytes)
    recommend(
      "media-file-over-limit",
      profile === "capacity-128-media64-v3"
        ? "At least one runtime file exceeds its format-specific limit: raster/base 32 MiB; MP4/MOV/WebM/M4A/MP3/WAV/OGG/GLB 64 MiB. Keep originals and inspect content, device decoding, model/GPU requirements and supported derivatives. Unknown large rewritten outputs remain blocked; image optimization cannot authorize large audio/video/models."
        : "At least one runtime file exceeds 32 MiB. Preserve it; inspect its actual media and runtime requirements. Image optimization applies only to supported static images and requires an explicit size choice for resizing.",
    );
  if (
    inventory &&
    Object.entries(inventory.overage).some(
      ([key, value]) =>
        !["mediaBytes", "mediaFileBytes"].includes(key) && value > 0,
    )
  )
    recommend(
      "source-budget-over-limit",
      "Inspect ordinary-source bytes, file count and entry limits separately. Do not discard files, rename media to bypass checks or increase isolation limits from the Agent.",
    );
  if (!recoveryComplete || !promisesKnown)
    recommend(
      "inspect-recovery-accounting",
      "Recovery history, a durable promise or its ledger could not be established completely. Inspect the retained records and storage status; do not release reservations, delete originals or retry an uncertain operation.",
    );
  if (ownOutstanding !== null && ownOutstanding > 0)
    recommend(
      "preserve-original-operation",
      "This project has an outstanding space promise. Inspect and verify the original operation or review ID before any new work; capacity observation does not settle or replace that operation.",
    );
  if (quotaEstimate === false)
    recommend(
      "recovery-history-headroom",
      "The profile-maximum envelope plus existing retained bytes exceeds the shared recovery quota. This conservative estimate is not a final refusal: exact baseline and verified artifact deductions can change actual admission. Keep history and originals; use the existing controlled workflow rather than pruning or replaying an uncertain operation.",
    );
  if (diskEstimate === false)
    recommend(
      "disk-headroom",
      "Observed disk space after the safety floor and known promises does not cover the profile-maximum envelope. Confirm the exact budget through the existing controlled workflow; do not infer final admission or refusal from this estimate, or replay an uncertain operation to obtain another estimate. Available space is advisory, not an OS reservation.",
    );
  if (currentReservation)
    recommend(
      "inspect-original-capacity-plan",
      `A source-absent capacity reservation remains ${currentReservation.phase} for original plan ${currentReservation.planId}. Use inspect_capacity_migration for that exact plan; do not allocate another volume or submit another migration.`,
    );
  if (!profileKnown)
    recommend(
      "active-volume-profile-unknown",
      "The active volume profile is unknown; the 64 MiB value shown in the host inventory is only the legacy default. Do not infer current limits or migrate from this observation.",
    );
  if (!guestCurrent)
    recommend(
      "guest-state-unknown",
      "The guest's current project state and free volume space are unknown. A stopped VM, missing overview or stale snapshot is not an empty volume. This action does not start or mount it.",
    );
  if (
    project &&
    [
      "prepared",
      "running",
      "cancel-requested",
      "expired-uncertain",
      "finished-awaiting-ack",
    ].includes(project.taskPhase)
  )
    recommend(
      "wait-original-operation",
      "An existing guest operation is running, finishing or unconfirmed. Wait for its own outcome or inspect its retained status; do not submit a replacement, stop another task or treat this capacity report as completion.",
    );
  if (
    project?.transition ||
    project?.residency === "creating" ||
    project?.residency === "recovery"
  )
    recommend(
      "storage-transition-pending",
      "A storage lifecycle transition remains pending. Inspect its original recorded state; capacity observation does not complete, migrate or release it.",
    );
  if (project?.dirty || project?.syncPending)
    recommend(
      "inspect-original-generation",
      "Inspect the current retained generation with recover_isolated_changes action inspect. If explicit read-only review is needed, use the existing review workflow. Keep original task IDs and approvals; do not replay commands or generate replacements.",
    );
  recommend(
    "measure-runtime-performance",
    "File size and storage headroom do not certify decode memory, GPU memory or FPS. Check actual dimensions/frame layout and target-device MAX_TEXTURE_SIZE, loading, draw calls and frame time through controlled project instrumentation; no quality increase is implied.",
  );
  return {
    version: 1 as const,
    observedAt,
    projectId: options.projectId,
    basis: "metadata-only" as const,
    status:
      inventory?.complete &&
      recoveryComplete &&
      promisesKnown &&
      guestCurrent &&
      profileKnown
        ? ("observed" as const)
        : ("partial" as const),
    scope: "eligible-host-workspace-and-private-recovery" as const,
    authorization: "none" as const,
    host: {
      inventory,
      limits: inventory?.limits ?? effectiveLimits,
      limitsBasis: profileKnown
        ? ("current-volume-profile" as const)
        : ("legacy-host-default-profile-unknown" as const),
      consistency: "bounded-metadata-observation" as const,
    },
    transfer: {
      mediaLimitScope: "complete-eligible-media-set-not-per-chunk" as const,
      ordinaryFileLimitBytes: PROJECT_SOURCE_LIMITS.fileBytes,
      ordinarySetLimitBytes: PROJECT_SOURCE_LIMITS.totalBytes,
      mediaFileLimitBytes: PROJECT_SOURCE_LIMITS.mediaFileBytes,
      largeMediaFileLimitBytes:
        profile === "capacity-128-media64-v3"
          ? getRuntimeCapacityProfile(profile).largeMediaFileBytes
          : null,
      largeMediaFilePolicy:
        profile === "capacity-128-media64-v3"
          ? ("video-audio-glb-v1" as const)
          : null,
      mediaSetLimitBytes: profileKnown ? mediaSetLimit : null,
      mediaWindowLimitBytes: profileKnown ? 64 * MiB : null,
      changedMediaReturnLimitBytes: profileKnown ? 64 * MiB : null,
      observedEligiblePayloadBytes: inventory?.complete
        ? inventory.totalBytes + inventory.mediaBytes
        : null,
      incrementalBytes: null,
      reason:
        "Payload size is a metadata observation, not an admitted seed size. Canvas candidates were excluded without validating content. Missing guest content and trusted baselines were not compared. No transfer was prepared or submitted.",
    },
    preservation: {
      trustedChangedBeforeBytes: null,
      trustedChangedAfterBytes: null,
      estimateBasis:
        "current-enforced-maxima-without-artifact-deductions" as const,
      conservativeNewOperationEnvelope: envelope,
      intentAllowanceBytes: 16384,
      quotaEstimateFits: quotaEstimate,
      diskEstimateFits: diskEstimate,
      reason:
        "This is not a captured change set or admission decision. Retention, content, decode, baseline, approvals, publication and acknowledgement are checked by their existing controlled operations.",
    },
    recovery: {
      ...recovery,
      quota: {
        ...recovery.quota,
        limitBytes: profileKnown ? recovery.quota.limitBytes : null,
        remainingBytes: profileKnown ? recovery.quota.remainingBytes : null,
      },
      profileBasis: profileKnown
        ? ("current-volume-profile" as const)
        : ("unknown" as const),
    },
    filesystem: {
      observedUnreservedAfterFloorBytes: unreservedAfterFloor,
      coverage: "known-ledger-and-inspected-project" as const,
      guarantee: "advisory-not-an-os-reservation" as const,
    },
    guest: {
      configured: !!options.storageOverview,
      vmState: overview?.vmState ?? "unknown",
      dataStatus: overview?.dataStatus ?? "unavailable",
      observedAt: overview?.snapshot?.observedAt ?? null,
      currentProjectStateKnown: !!guestCurrent,
      currentProfileId: activeProfileId,
      capacityReservationStatus,
      pendingCapacityReservation: currentReservation,
      allocation: guestCurrent
        ? project
          ? ("present" as const)
          : ("absent" as const)
        : ("unknown" as const),
      project: project
        ? {
            generation: project.generation,
            residency: project.residency,
            dirty: project.dirty,
            syncPending: project.syncPending,
            taskPhase: project.taskPhase,
            transition: project.transition,
            ...(project.volumeProfileVersion !== undefined
              ? {
                  volumeProfileVersion: project.volumeProfileVersion,
                  sourceProfileId: project.sourceProfileId,
                  volumeBytes: project.volumeBytes,
                  retainedVolumeBytes: project.retainedVolumeBytes,
                  stagingVolumeBytes: project.stagingVolumeBytes,
                  logicalBytes: project.logicalBytes,
                }
              : {}),
          }
        : null,
      observedLimits: overview?.snapshot?.limits ?? null,
      volumeUsedBytes: null,
      volumeFreeBytes: null,
      reason:
        "The passive overview supplies no authoritative used/free filesystem measurement. The nominal image length is not free space.",
    },
    contracts: {
      hostSupported: {
        executionLifecycle: 2,
        runtimeMedia: 1,
        buildMedia: 1,
        sourceInspection: 1,
        capture: 3,
        retainedReview: 2,
        sourceManifest: 1,
        sourcePublication: 4,
        spacePlan: 1,
        sourceSpaceIntent: 2,
        mediumProfile: {
          capacityProfile: 2,
          capture: 4,
          sourceManifest: 2,
          sourcePublication: 5,
          spacePlan: 2,
          sourceSpaceIntent: 3,
        },
        largeMediaProfile: {
          capacityProfile: 3,
          profileId: "capacity-128-media64-v3",
          descriptor: getRuntimeCapacityProfile("capacity-128-media64-v3"),
          capture: 4,
          sourceManifest: 2,
          sourcePublication: 5,
          spacePlan: 2,
          sourceSpaceIntent: 3,
        },
      },
      staticRasterReturns: {
        legacyFileBytes: LEGACY_RASTER_BYTES,
        controlledV2FileBytes: RASTER_BYTES,
        decodeLimitPixels: RASTER_PIXELS,
      },
      guestPerGenerationRasterPolicy: null,
      guestCapabilities: "not-probed-by-capacity-action" as const,
      legacyRecoveryLimitBytes: 32 * MiB,
      currentRecoveryLimitBytes: profileKnown
        ? recovery.quota.limitBytes
        : null,
      reason:
        "Supported host versions are not a claim about an old generation. Legacy contracts and approvals are not upgraded by this observation.",
    },
    recommendations,
    issues,
    inspection: {
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      assetPayloadsRead: false,
      imagePixelsDecoded: false,
      controlMetadataMayBeRead: true,
    },
  };
}

export type ExecutionCapacityReport = Awaited<
  ReturnType<typeof inspectExecutionCapacity>
>;

/** Compare existing runtime contracts using metadata, without selecting, allocating or migrating anything. */
export function planInitialExecutionCapacity(report: ExecutionCapacityReport) {
  const inventory = report.host.inventory;
  const complete =
    inventory?.complete === true &&
    inventory.scope.separateMedia === true &&
    inventory.scope.unverifiedCanvasCandidateCount === 0;
  const profiles = [
    {
      id: "current-64" as const,
      version: 0,
      volumeBytes: 256 * MiB,
      mediaBytes: PROJECT_SOURCE_LIMITS.mediaBytes,
      sourceBytes: PROJECT_SOURCE_LIMITS.totalBytes,
      sourceFileBytes: PROJECT_SOURCE_LIMITS.fileBytes,
      fileCount: PROJECT_SOURCE_LIMITS.fileCount,
      entryCount: PROJECT_SOURCE_LIMITS.entries,
      mediaFileBytes: PROJECT_SOURCE_LIMITS.mediaFileBytes,
      largeMediaFileBytes: PROJECT_SOURCE_LIMITS.mediaFileBytes,
      mediaWindowBytes: 64 * MiB,
      recoveryBytes: 512 * MiB,
      inodeCount: 8192,
    },
    ...RUNTIME_CAPACITY_PROFILES.map((profile) => ({
      ...profile,
      largeMediaFileBytes:
        profile.largeMediaFileBytes ?? profile.mediaFileBytes,
    })),
  ];
  const count = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  const mediaMaximum = (
    kind: "largestBaseMedia" | "largestLargeMedia",
  ): number | null => {
    if (!inventory) return null;
    if (inventory.mediaBytes === 0) return 0;
    if (inventory.scope.mediaClassMaximaVersion === 1)
      return inventory[kind]?.size ?? 0;
    if (inventory[kind]) return inventory[kind]!.size;
    // Older reports have no per-class maxima. The overall maximum can prove a bound, never class absence.
    if (
      inventory.largestMedia &&
      inventory.largestMedia.size <= PROJECT_SOURCE_LIMITS.mediaFileBytes
    )
      return inventory.largestMedia.size;
    return null;
  };
  const choices = profiles.map((profile) => {
    const constraint = (code: string, observed: unknown, limit: number) => ({
      code,
      observedBytesOrCount: count(observed) ? observed : null,
      limit,
      status:
        count(observed) && observed > limit
          ? ("exceeds" as const)
          : !complete || !count(observed)
            ? ("unknown" as const)
            : ("within" as const),
    });
    const constraints = [
      constraint(
        "ordinary-source-set",
        inventory?.totalBytes,
        profile.sourceBytes,
      ),
      constraint(
        "ordinary-file",
        inventory?.largestFiles[0]?.size ??
          (inventory?.totalBytes === 0 ? 0 : null),
        profile.sourceFileBytes,
      ),
      constraint("media-set", inventory?.mediaBytes, profile.mediaBytes),
      constraint(
        "base-media-file",
        mediaMaximum("largestBaseMedia"),
        profile.mediaFileBytes,
      ),
      constraint(
        "video-audio-glb-file",
        mediaMaximum("largestLargeMedia"),
        profile.largeMediaFileBytes,
      ),
      constraint("project-file-count", inventory?.fileCount, profile.fileCount),
      constraint(
        "project-entry-count",
        inventory?.entryCount,
        profile.entryCount,
      ),
    ];
    const status = constraints.some((item) => item.status === "exceeds")
      ? ("exceeds" as const)
      : constraints.some((item) => item.status === "unknown")
        ? ("unknown" as const)
        : ("within" as const);
    return {
      profileId: profile.id,
      contractVersion: profile.version,
      limits: {
        volumeBytes: profile.volumeBytes,
        mediaBytes: profile.mediaBytes,
        mediaFileBytes: profile.mediaFileBytes,
        largeMediaFileBytes: profile.largeMediaFileBytes,
        mediaWindowBytes: profile.mediaWindowBytes,
        sourceBytes: profile.sourceBytes,
        sourceFileBytes: profile.sourceFileBytes,
        fileCount: profile.fileCount,
        entryCount: profile.entryCount,
        inodeCount: profile.inodeCount,
        recoveryBytes: profile.recoveryBytes,
      },
      simulationOnly: false as const,
      capabilityStatus: "not-probed" as const,
      observedEnvelope: { status, constraints },
      allocationPath:
        profile.id === "current-64"
          ? ("existing-legacy-prepare" as const)
          : ("existing-native-create-approval" as const),
      readyForAllocation: false as const,
    };
  });
  return {
    version: 1 as const,
    projectId: report.projectId,
    observedAt: report.observedAt,
    purpose: "first-allocation-planning-only" as const,
    authorization: "none" as const,
    allocation: report.guest.allocation,
    newProjectOrigin: "not-established-by-empty-volume" as const,
    applicability:
      report.guest.allocation === "present"
        ? ("existing-volume-out-of-scope" as const)
        : report.guest.allocation === "absent"
          ? ("unallocated-observation-only" as const)
          : ("unknown" as const),
    recommendedProfileId: null,
    smallestObservedEnvelope: complete
      ? (choices.find((choice) => choice.observedEnvelope.status === "within")
          ?.profileId ?? null)
      : null,
    choices,
    evidence: {
      metadataOnly: true as const,
      atomicSnapshot: false as const,
      traversalComplete: inventory?.complete ?? null,
      unverifiedCanvasCandidateCount:
        inventory?.scope.unverifiedCanvasCandidateCount ?? null,
      completeForObservedEnvelope: complete,
      formatBasis: "path-extension-not-content-validation" as const,
      futureWorkload: "unknown" as const,
      guestCapabilities: "not-probed" as const,
    },
    resources: {
      hostUnreservedAfterFloorBytes:
        report.filesystem.observedUnreservedAfterFloorBytes,
      hostSpaceGuarantee: "advisory-not-reserved" as const,
      guestVolumeFreeBytes: null,
      pendingCapacityReservation: report.guest.pendingCapacityReservation,
      recoveryAccountingStatus: report.recovery.status,
      recoveryProfileBasis: report.recovery.profileBasis,
      allocationSpaceAndInodes: "requires-fresh-native-admission" as const,
    },
    performance: {
      decodedMemory: "unknown" as const,
      gpuMemory: "unknown" as const,
      frameTime: "not-measured" as const,
      instructions:
        "Estimate decode and GPU peaks separately from encoded bytes. On the actual WebGL target read MAX_TEXTURE_SIZE and check atlas dimensions, frame mapping and transparent edges. Measure loading, seek, draw calls and frame time; the maximum texture size is not a performance budget.",
    },
    nextSteps: [
      "Describe future media plus dependency, cache, build/staging bytes and inode peaks separately from observed files. Metadata within limits does not prove a usable seed, workload fit or target-device performance.",
      "Inspect actual content, excluded Canvas candidates and the negotiated guest contract before transfer. Existing approved media/seed/recovery limits still apply; retain originals.",
      "An unknown or stopped guest is not an absent volume. Pending operations require inspection of their original IDs; do not replan, migrate old projects or replay them.",
      "No automatic first-allocation decision is enabled. A durable first-intent claim, initial-only guest check and safe cancellation must be validated before integrating automatic selection. A native create plan alone does not close the prepare race.",
    ],
  };
}

export type InitialExecutionCapacityPlan = ReturnType<typeof planInitialExecutionCapacity>;

/** A passive inventory is not a verified seed, volume snapshot or migration approval. */
export function proposeExecutionCapacity(
  report: ExecutionCapacityReport,
  profileId: CapacityProfileId,
) {
  const inventory = report.host.inventory;
  const recovery = report.recovery;
  const recoveryKnown =
    recovery.status === "complete" && recovery.localImageStorage === "included";
  const hostKnown =
    recoveryKnown &&
    recovery.filesystem.status === "complete" &&
    recovery.promises.ledger === "known";
  const project = report.guest.currentProjectStateKnown
    ? report.guest.project
    : null;
  const active =
    project &&
    ["running", "cancel-requested", "finished-awaiting-ack"].includes(
      project.taskPhase,
    );
  const pending =
    !!report.guest.pendingCapacityReservation ||
    !!(
      project &&
      (project.syncPending === true ||
        project.transition != null ||
        project.taskPhase === "expired-uncertain")
    );
  const proposal = planExecutionCapacityProposal({
    profileId,
    observed: {
      ...(project || pending
        ? {
            currentVolume: {
              // Negative lifecycle evidence blocks planning; the converse is not a verified clean snapshot.
              ...(project?.dirty === true ? { clean: false } : {}),
              ...(active ? { active: true } : {}),
              ...(pending ? { pending: true } : {}),
            },
          }
        : {}),
      ...(inventory
        ? {
            content: {
              // Canvas candidates remain unverified and can be outside these observed totals.
              complete: false,
              sourceBytes: inventory.totalBytes,
              mediaBytes: inventory.mediaBytes,
              files: inventory.fileCount,
              entries: inventory.entryCount,
            },
          }
        : {}),
      ...(hostKnown
        ? {
            host: {
              availableBytes: recovery.filesystem.availableBytes,
              reservedBytes: recovery.promises.sameDevice.diskBytes,
            },
          }
        : {}),
      ...(recoveryKnown
        ? { recovery: { usedBytes: recovery.quota.usedBytes } }
        : {}),
    },
  });
  return {
    ...proposal,
    projectId: report.projectId,
    observedAt: report.observedAt,
    basis:
      "eligible-workspace-metadata-with-unverified-canvas-excluded" as const,
  };
}

export type ExecutionCapacityProposal = ReturnType<
  typeof proposeExecutionCapacity
>;
