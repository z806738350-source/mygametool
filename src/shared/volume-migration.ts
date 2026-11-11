/** A backend-owned immutable plan. Displaying it never authorizes migration. */
export interface VolumeMigrationReview {
  version: 1;
  planId: string;
  projectId: string;
  generation: number;
  source: {
    profileId: string;
    volumeBytes: number;
    recoveryBytes?: number;
    imageId: string | null;
    imageSha256: string | null;
  };
  target: {
    profileId: "capacity-128-v2" | "capacity-128-media64-v3";
    volumeBytes: number;
    mediaBytes: number;
    recoveryBytes: number;
    mediaFileBytes?: number;
    largeMediaFileBytes?: number;
    mediaWindowBytes?: number;
    largeMediaFilePolicy?: "video-audio-glb-v1";
  };
  resources: {
    globalBeforeBytes: number | null;
    globalDuringBytes: number | null;
    guestRequiredBytes: number | null;
    guestAvailableBytes: number | null;
    hostRequiredBytes: number | null;
    hostAvailableBytes: number | null;
    requiredInodes: number | null;
    availableInodes: number | null;
    recoveryUsedBytes: number | null;
    recoveryRequiredBytes: number | null;
  };
  oldVolumeRetention: "retained-no-auto-delete";
  supportsResume: false;
  supportsRollback: false;
  status: "ready" | "blocked" | "unknown";
  blockers: string[];
  expiresAt: string;
}

export interface VolumeMigrationConfirmation {
  planId: string;
  generation: number;
  sourceImageSha256: string | null;
  targetProfileId: "capacity-128-v2" | "capacity-128-media64-v3";
  capacityReviewed: boolean;
  oldVolumeRetained: boolean;
}

const MiB = 1024 * 1024;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const resourceKeys = [
  "globalBeforeBytes",
  "globalDuringBytes",
  "guestRequiredBytes",
  "guestAvailableBytes",
  "hostRequiredBytes",
  "hostAvailableBytes",
  "requiredInodes",
  "availableInodes",
  "recoveryUsedBytes",
  "recoveryRequiredBytes",
] as const;

/** Structural gate for safe display; unknown budgets are valid display data. */
export function isVolumeMigrationReview(
  value: unknown,
): value is VolumeMigrationReview {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.planId !== "string" ||
    !uuid.test(value.planId) ||
    !opaque(value.projectId) ||
    !count(value.generation)
  )
    return false;
  const source = value.source,
    target = value.target,
    resources = value.resources;
  if (
    !object(source) ||
    !opaque(source.profileId) ||
    !count(source.volumeBytes) ||
    (source.recoveryBytes !== undefined &&
      ![512 * MiB, 1024 * MiB].includes(source.recoveryBytes as number))
  )
    return false;
  if (source.profileId === "unallocated") {
    if (
      value.generation !== 0 ||
      source.volumeBytes !== 0 ||
      source.imageId !== null ||
      source.imageSha256 !== null
    )
      return false;
  } else if (
    value.generation < 1 ||
    source.volumeBytes < 1 ||
    !opaque(source.imageId) ||
    typeof source.imageSha256 !== "string" ||
    !hash.test(source.imageSha256)
  )
    return false;
  if (
    !object(target) ||
    !["capacity-128-v2", "capacity-128-media64-v3"].includes(String(target.profileId)) ||
    target.volumeBytes !== 512 * MiB ||
    target.mediaBytes !== 128 * MiB ||
    target.recoveryBytes !== 1024 * MiB ||
    (target.profileId === "capacity-128-media64-v3"
      ? target.mediaFileBytes !== 32 * MiB || target.largeMediaFileBytes !== 64 * MiB || target.mediaWindowBytes !== 64 * MiB || target.largeMediaFilePolicy !== "video-audio-glb-v1"
      : ["mediaFileBytes", "largeMediaFileBytes", "mediaWindowBytes", "largeMediaFilePolicy"].some((key) => Object.hasOwn(target, key))) ||
    !object(resources) ||
    resourceKeys.some(
      (key) => resources[key] !== null && !count(resources[key]),
    ) ||
    value.oldVolumeRetention !== "retained-no-auto-delete" ||
    value.supportsResume !== false ||
    value.supportsRollback !== false ||
    !["ready", "blocked", "unknown"].includes(String(value.status)) ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > 64 ||
    value.blockers.some(
      (reason) => typeof reason !== "string" || reason.length > 2000,
    ) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    return false;
  return true;
}

/** UX/service gate only. Native execution must independently revalidate its immutable plan. */
export function validVolumeMigrationReview(
  value: unknown,
  now = Date.now(),
): boolean {
  if (
    !isVolumeMigrationReview(value) ||
    value.status !== "ready" ||
    value.blockers.length ||
    (value.target.profileId === "capacity-128-media64-v3" && value.source.profileId !== "unallocated" && (value.source.profileId !== "current-64" || value.source.volumeBytes !== 256 * MiB)) ||
    Date.parse(value.expiresAt) <= now
  )
    return false;
  const r = value.resources;
  if (resourceKeys.some((key) => !count(r[key]))) return false;
  return (
    r.globalDuringBytes! >= r.globalBeforeBytes! + value.target.volumeBytes &&
    r.globalDuringBytes! <= 4 * 1024 ** 3 &&
    value.target.volumeBytes >= value.source.volumeBytes &&
    r.guestRequiredBytes! <= r.guestAvailableBytes! &&
    r.hostRequiredBytes! <= r.hostAvailableBytes! &&
    r.requiredInodes! <= r.availableInodes! &&
    r.recoveryRequiredBytes! >= 598 * MiB &&
    r.recoveryUsedBytes! + r.recoveryRequiredBytes! <=
      value.target.recoveryBytes
  );
}

export function validVolumeMigrationConfirmation(
  review: unknown,
  value: unknown,
  now = Date.now(),
): value is VolumeMigrationConfirmation {
  if (
    !isVolumeMigrationReview(review) ||
    !validVolumeMigrationReview(review, now) ||
    !object(value) ||
    Object.keys(value).length !== 6
  )
    return false;
  return (
    value.planId === review.planId &&
    value.generation === review.generation &&
    value.sourceImageSha256 === review.source.imageSha256 &&
    value.targetProfileId === review.target.profileId &&
    value.capacityReviewed === true &&
    value.oldVolumeRetained === true
  );
}
