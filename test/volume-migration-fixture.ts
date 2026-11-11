import type {
  VolumeMigrationConfirmation,
  VolumeMigrationReview,
} from "../src/shared/volume-migration.js";

export function volumeMigrationReview(
  projectId = "project-1",
  create = false,
): VolumeMigrationReview {
  const MiB = 1024 * 1024;
  return {
    version: 1,
    planId: "11111111-1111-4111-8111-111111111111",
    projectId,
    generation: create ? 0 : 7,
    source: {
      profileId: create ? "unallocated" : "current-64",
      volumeBytes: create ? 0 : 256 * MiB,
      recoveryBytes: 512 * MiB,
      imageId: create ? null : "manual:project-1:1",
      imageSha256: create ? null : "a".repeat(64),
    },
    target: {
      profileId: "capacity-128-v2",
      volumeBytes: 512 * MiB,
      mediaBytes: 128 * MiB,
      recoveryBytes: 1024 * MiB,
    },
    resources: {
      globalBeforeBytes: create ? 0 : 256 * MiB,
      globalDuringBytes: (create ? 512 : 768) * MiB,
      guestRequiredBytes: 1536 * MiB,
      guestAvailableBytes: 4096 * MiB,
      hostRequiredBytes: 1026 * MiB,
      hostAvailableBytes: 4096 * MiB,
      requiredInodes: 8,
      availableInodes: 10000,
      recoveryUsedBytes: 32 * MiB,
      recoveryRequiredBytes: 598 * MiB,
    },
    oldVolumeRetention: "retained-no-auto-delete",
    supportsResume: false,
    supportsRollback: false,
    status: "ready",
    blockers: [],
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

export function volumeMigrationConfirmation(
  review: VolumeMigrationReview,
): VolumeMigrationConfirmation {
  return {
    planId: review.planId,
    generation: review.generation,
    sourceImageSha256: review.source.imageSha256,
    targetProfileId: review.target.profileId,
    capacityReviewed: true,
    oldVolumeRetained: true,
  };
}
