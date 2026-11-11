export type ExecutionStorageNamespace = "manual" | "test";

/** Working-image costs; these estimates do not certify a device or a frame rate. */
export interface IsolatedSourceImageCost {
  encodedBytes: number;
  pixelCount: number;
  decodedRgbaBytes: number;
  /** RGBA8 base level, without GPU format, alignment or driver overhead. */
  estimatedTextureBytes: number;
  /** Complete RGBA8 mip chain including the base level. */
  estimatedMipmapBytes: number;
  /** This tool's decoding boundary, not a device's texture or memory budget. */
  decodeLimitPixels: number;
  performanceStatus: "estimate-only";
}

export interface IsolatedSourceReviewFile {
  path: string;
  change: "added" | "modified";
  kind: "image" | "code" | "text" | "verified-media";
  bytes: number;
  beforeBytes?: number;
  beforeSha256?: string;
  afterSha256: string;
  preview?: string;
  imageCost?: IsolatedSourceImageCost;
  optimization?: {
    originalSha256: string;
    originalBytes: number;
    originalWidth?: number;
    originalHeight?: number;
    width?: number;
    height?: number;
    maxEdge?: number;
    hasAlpha?: boolean;
    originalRetained: boolean;
    needsMaxEdge?: boolean;
  };
}

/** Changes between complete source manifests; byte counts describe file contents, not wire traffic. */
export interface IsolatedSourceDelta {
  version: 1;
  beforeManifestId: string;
  afterManifestId: string;
  addedFiles: number;
  modifiedFiles: number;
  removedFiles: number;
  unchangedFiles: number;
  beforeSourceBytes: number;
  beforeMediaBytes: number;
  afterSourceBytes: number;
  afterMediaBytes: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface IsolatedSourceReview {
  reviewId: string;
  projectId: string;
  generation: string;
  snapshotId: string;
  files: IsolatedSourceReviewFile[];
  blockers: Array<{ path: string; reason: string }>;
  approved: boolean;
  completed?: boolean;
  expiresAt: string;
  reviewVersion?: 2;
  rawSnapshotId?: string;
  preparedSnapshotId?: string;
  optimizablePaths?: string[];
  publicationUnchanged?: boolean;
  sourceManifestVersion?: 1 | 2;
  sourceProfileId?: "capacity-128-v2" | "capacity-128-media64-v3";
  sourceRawDelta?: IsolatedSourceDelta;
  sourcePreparedDelta?: IsolatedSourceDelta;
}

export interface IsolatedSourceConfirmation {
  reviewId: string;
  filesReviewed: boolean;
  codeReviewed?: boolean;
}

export type RetainedImageVariant = "raw" | "working";
export type RetainedImageMimeType = "image/png" | "image/jpeg" | "image/webp";
/** Describes a read-only model display of one saved review, never approval or fresh guest state. */
export interface RetainedImageMetadata {
  namespace: "manual" | "test";
  projectId: string;
  reviewId: string;
  generation: string;
  rawSnapshotId: string;
  preparedSnapshotId?: string;
  path: string;
  variant: RetainedImageVariant;
  sourceSha256: string;
  sourceMimeType: RetainedImageMimeType;
  sourceBytes: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceHasAlpha: boolean;
  displaySha256: string;
  displayWidth: number;
  displayHeight: number;
  displayBytes: number;
  isProxy: boolean;
  scannerRevision: number;
  freshGuest: false;
  adoptionApproved: false;
}

export function validSourceConfirmation(
  review: IsolatedSourceReview,
  value: IsolatedSourceConfirmation | undefined,
): boolean {
  return (
    !!value &&
    value.reviewId === review.reviewId &&
    value.filesReviewed === true &&
    review.files.length > 0 &&
    review.blockers.length === 0 &&
    (review.sourceManifestVersion === undefined ||
      review.sourceManifestVersion === 1 ||
      review.sourceManifestVersion === 2) &&
    (review.sourceManifestVersion === undefined ||
      !!review.sourcePreparedDelta) &&
    (review.sourceManifestVersion !== 2 || !!review.sourceRawDelta) &&
    (review.sourceManifestVersion === 2
      ? review.sourceProfileId === "capacity-128-v2" || review.sourceProfileId === "capacity-128-media64-v3"
      : review.sourceProfileId === undefined) &&
    (review.reviewVersion !== 2 ||
      (review.snapshotId === review.rawSnapshotId &&
        /^[a-f0-9]{64}$/.test(review.rawSnapshotId ?? "") &&
        /^[a-f0-9]{64}$/.test(review.preparedSnapshotId ?? "") &&
        review.files.every(
          (file) =>
            file.kind !== "image" ||
            (file.optimization?.originalRetained === true &&
              !file.optimization.needsMaxEdge &&
              /^[a-f0-9]{64}$/.test(file.optimization.originalSha256) &&
              Number.isSafeInteger(file.optimization.originalBytes) &&
              file.optimization.originalBytes > 0 &&
              [
                file.optimization.originalWidth,
                file.optimization.originalHeight,
                file.optimization.width,
                file.optimization.height,
              ].every(
                (size) => Number.isSafeInteger(size) && Number(size) > 0,
              ) &&
              typeof file.optimization.hasAlpha === "boolean"),
        ))) &&
    (!review.files.some((file) => file.kind === "code") ||
      value.codeReviewed === true)
  );
}
export type ExecutionStorageTaskPhase =
  | "idle"
  | "prepared"
  | "running"
  | "finished-awaiting-ack"
  | "finished"
  | "cancel-requested"
  | "expired-uncertain";

export interface ExecutionStorageLimits {
  residentVolumes: number;
  volumeBytes: number;
  totalLogicalBytes: number;
  reserveBytes: number;
  globalOperations: number;
}

export interface ExecutionStorageProject {
  namespace: ExecutionStorageNamespace;
  projectId: string;
  generation: string;
  projectName: string | null;
  currentStore: boolean;
  residency: "resident" | "archived" | "creating" | "recovery";
  residentReserved: boolean;
  /** Present only in a validated versioned capacity overview. */
  residentReservationCount?: number;
  volumeProfileVersion?: 0 | 2 | 3;
  sourceProfileId?: "capacity-128-v2" | "capacity-128-media64-v3" | null;
  volumeId?: string;
  volumeBytes?: number;
  retainedVolumeBytes?: number;
  stagingVolumeBytes?: number;
  logicalBytes?: number;
  transition: {
    from: "resident" | "archived" | "creating" | "recovery";
    to: "resident" | "archived" | "deleted";
  } | null;
  dirty: boolean;
  pinned: boolean;
  syncPending: boolean;
  taskPhase: ExecutionStorageTaskPhase;
  expiredTask: boolean;
}

/** A target reservation durable in the guest before an absent project record exists. */
export interface ExecutionCapacityReservation {
  namespace: ExecutionStorageNamespace;
  projectId: string;
  planId: string;
  targetVolumeId: string;
  volumeBytes: 536870912;
  phase: "started" | "unknown";
  sourceAbsent: true;
}

export interface ExecutionStorageSnapshot {
  observedAt: string;
  limits: ExecutionStorageLimits;
  countsTrusted: boolean;
  allocatedProjects: number;
  residentReserved: number;
  freeResidentSlots: number | null;
  resident: number;
  sleeping: number;
  capacityOverviewVersion?: 1;
  allocatedLogicalBytes?: number;
  retainedBackupBytes?: number;
  stagingLogicalBytes?: number;
  capacityReservations?: ExecutionCapacityReservation[];
  projects: ExecutionStorageProject[];
}

export interface ExecutionStorageOverview {
  supported: boolean;
  vmState: "running" | "stopped" | "unknown";
  dataStatus: "current" | "stale" | "unavailable";
  checkedAt: string;
  reason?:
    | "not-configured"
    | "vm-stopped"
    | "vm-unavailable"
    | "snapshot-unavailable"
    | "review-required";
  snapshot: ExecutionStorageSnapshot | null;
  unallocatedProjects: { projectId: string; projectName: string }[] | null;
}
