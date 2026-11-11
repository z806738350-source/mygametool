const MiB = 1024 ** 2;
export type CapacityProfileId =
  | "capacity-64-v1"
  | "capacity-128-v1"
  | "capacity-256-v1"
  | RuntimeCapacityProfileId;
export type RuntimeCapacityProfileId =
  "capacity-128-v2" | "capacity-128-media64-v3";

/** Candidate contracts are separate from the existing current-64 runtime contract. */
export interface CapacityProfile {
  readonly version: 1 | 2 | 3;
  readonly id: CapacityProfileId;
  readonly volumeBytes: number;
  readonly mediaBytes: number;
  readonly inodeCount: number;
  readonly sourceFileBytes: number;
  readonly sourceBytes: number;
  readonly mediaFileBytes: number;
  readonly largeMediaFileBytes?: number;
  readonly largeMediaFilePolicy?: "video-audio-glb-v1";
  readonly mediaWindowBytes: number;
  readonly fileCount: number;
  readonly entryCount: number;
  readonly requestHeaderBytes: number;
  readonly responseHeaderBytes: number;
  readonly recoveryBytes: number;
  readonly globalVolumeBytes: number;
  readonly residentVolumes: number;
  readonly globalOperations: number;
  readonly reserveBytes: number;
  readonly runtimeEnabled: boolean;
  readonly simulationOnly: boolean;
}

export const CAPACITY_PROFILES: readonly CapacityProfile[] = Object.freeze(
  [64, 128, 256].map((media, index) =>
    Object.freeze({
      version: 1 as const,
      id: `capacity-${media}-v1` as CapacityProfileId,
      volumeBytes: 4 * media * MiB,
      mediaBytes: media * MiB,
      inodeCount: 8192 * 2 ** index,
      sourceFileBytes: 2 * MiB,
      sourceBytes: 8 * MiB,
      mediaFileBytes: 32 * MiB,
      mediaWindowBytes: 64 * MiB,
      fileCount: 2000,
      entryCount: 4000,
      requestHeaderBytes: 24 * MiB,
      responseHeaderBytes: 16 * MiB,
      recoveryBytes: 512 * MiB,
      globalVolumeBytes: 4096 * MiB,
      residentVolumes: 8,
      globalOperations: 2,
      reserveBytes: 1024 * MiB,
      runtimeEnabled: false as const,
      simulationOnly: true as const,
    }),
  ),
);

/** A distinct contract; availability still requires the exact negotiated guest capability. */
const mediumProfile = Object.freeze({
  ...CAPACITY_PROFILES[1]!,
  version: 2 as const,
  id: "capacity-128-v2" as const,
  recoveryBytes: 1024 * MiB,
  runtimeEnabled: true as const,
  simulationOnly: false as const,
});
export const RUNTIME_CAPACITY_PROFILES = Object.freeze([
  mediumProfile,
  Object.freeze({
    ...mediumProfile,
    version: 3 as const,
    id: "capacity-128-media64-v3" as const,
    largeMediaFileBytes: 64 * MiB,
    largeMediaFilePolicy: "video-audio-glb-v1" as const,
  }),
]);

export function getRuntimeCapacityProfile(id: unknown) {
  const profile = RUNTIME_CAPACITY_PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error("Unknown runtime execution capacity profile");
  return profile;
}

/** Format classification only; this grants no file, verified-copy or publication authority. */
export function runtimeLargeMediaSupported(relativePath: string): boolean {
  return (
    typeof relativePath === "string" &&
    /\.(?:mp4|mov|webm|m4a|mp3|wav|ogg|glb)$/i.test(relativePath)
  );
}

/** Limits require a trusted, negotiated profile; old and unknown generations never inherit media64. */
export function runtimeMediaFileLimit(
  relativePath: string,
  profileId?: RuntimeCapacityProfileId,
): number {
  const profile =
    profileId === undefined ? undefined : getRuntimeCapacityProfile(profileId);
  return profile?.id === "capacity-128-media64-v3" &&
    runtimeLargeMediaSupported(relativePath)
    ? profile.largeMediaFileBytes
    : (profile?.mediaFileBytes ?? 32 * MiB);
}

export function getCapacityProfile(id: unknown): CapacityProfile {
  const profile = [...CAPACITY_PROFILES, ...RUNTIME_CAPACITY_PROFILES].find(
    (item) => item.id === id,
  );
  if (!profile) throw new Error("Unknown execution capacity profile");
  return profile;
}

type Count = number | null;
export interface CapacityProfileObservation {
  content?: {
    complete?: boolean;
    sourceBytes?: Count;
    mediaBytes?: Count;
    files?: Count;
    entries?: Count;
  };
  currentVolume?: {
    bytes?: Count;
    allocatedBytes?: Count;
    usedBytes?: Count;
    usedInodes?: Count;
    clean?: boolean | null;
    active?: boolean | null;
    pending?: boolean | null;
  };
  guest?: {
    availableBytes?: Count;
    availableInodes?: Count;
    reservedPhysicalBytes?: Count;
    /** Remaining growth of every other registered/backup image, excluding currentVolume. */
    unallocatedOtherVolumeBytes?: Count;
    reservedInodes?: Count;
    logicalVolumeBytes?: Count;
    residentVolumes?: Count;
    activeOperations?: Count;
  };
  host?: {
    availableBytes?: Count;
    availableInodes?: Count;
    reservedBytes?: Count;
    reservedInodes?: Count;
  };
  /** Disjoint category peaks, including retained old build/cache outputs where applicable. */
  workload?: {
    dependencyBytes?: Count;
    cacheBytes?: Count;
    buildBytes?: Count;
    stagingBytes?: Count;
    additionalInodes?: Count;
  };
  recovery?: { usedBytes?: Count; transactionBytes?: Count };
}

export interface CapacityConstraint {
  code: string;
  status: "pass" | "blocked" | "unknown";
  required?: number;
  available?: number;
  reason: string;
}
function number(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(
      "Invalid capacity observation; unknown values must be null",
    );
  return value as number;
}
function sum(...values: unknown[]): number | null {
  const counts = values.map(number);
  if (counts.some((value) => value === null)) return null;
  const result = (counts as number[]).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) throw new Error("Capacity sum overflow");
  return result;
}

/** Planning is neither admission nor authorization, and never changes a project profile. */
export function planExecutionCapacityProposal(input: {
  profileId: unknown;
  observed?: CapacityProfileObservation;
}) {
  const profile = getCapacityProfile(input.profileId);
  const o = input.observed ?? {};
  const constraints: CapacityConstraint[] = [];
  const compare = (
    code: string,
    required: number | null,
    available: number | null,
    reason: string,
  ) => {
    constraints.push({
      code,
      status:
        required === null || available === null
          ? "unknown"
          : required <= available
            ? "pass"
            : "blocked",
      ...(required === null ? {} : { required }),
      ...(available === null ? {} : { available }),
      reason,
    });
  };
  const source = number(o.content?.sourceBytes),
    media = number(o.content?.mediaBytes);
  const files = number(o.content?.files),
    entries = number(o.content?.entries);
  const complete = o.content?.complete === true;
  compare(
    "source-set",
    source,
    profile.sourceBytes,
    "The ordinary-source limit remains separate from media capacity.",
  );
  compare(
    "media-set",
    media,
    profile.mediaBytes,
    "Every eligible path counts, including equal-SHA paths; transport windows do not reset this limit.",
  );
  compare(
    "project-files",
    files,
    profile.fileCount,
    "Dependencies and filesystem inodes have separate limits.",
  );
  compare(
    "project-entries",
    entries,
    profile.entryCount,
    "This is the bounded project inventory, not the volume's total inode usage.",
  );
  if (!complete)
    constraints.push({
      code: "inventory-incomplete",
      status: "unknown",
      reason:
        "Observed totals are lower bounds; inspect a complete inventory before choosing a usable profile.",
    });

  const current = o.currentVolume;
  for (const [key, wanted] of [
    ["clean", true],
    ["active", false],
    ["pending", false],
  ] as const) {
    const value = current?.[key];
    if (value !== null && value !== undefined && typeof value !== "boolean")
      throw new Error("Invalid volume lifecycle observation");
    constraints.push({
      code: `volume-${key}`,
      status:
        typeof value !== "boolean"
          ? "unknown"
          : value === wanted
            ? "pass"
            : "blocked",
      reason:
        "Migration is limited to a known clean, idle volume with no unfinished recovery, sync or allocation.",
    });
  }
  const bytes = number(current?.bytes),
    allocated = number(current?.allocatedBytes);
  if (bytes !== null && allocated !== null && allocated > bytes)
    throw new Error("Allocated image bytes exceed the known volume capacity");
  compare(
    "migration-direction",
    bytes,
    profile.volumeBytes,
    "Initial migration supports equal or larger volumes; it does not shrink existing filesystems.",
  );
  const workload = o.workload;
  const workspace = complete ? sum(source, media) : null;
  const categoryPeak = sum(
    workspace,
    workload?.dependencyBytes,
    workload?.cacheBytes,
    workload?.buildBytes,
    workload?.stagingBytes,
  );
  const existingPeak = sum(current?.usedBytes, workload?.stagingBytes);
  // The estimate is deliberately separate from the formatted filesystem's real free-space check.
  const overhead = Math.max(16 * MiB, Math.ceil(profile.volumeBytes * 0.02));
  const peak =
    categoryPeak === null || existingPeak === null
      ? null
      : sum(Math.max(categoryPeak, existingPeak), overhead);
  compare(
    "volume-peak-bytes",
    peak,
    profile.volumeBytes,
    "Include dependency expansion, cache, old/new build outputs, staging and filesystem overhead; a later backend must recheck real filesystem free space.",
  );
  compare(
    "volume-peak-inodes",
    complete
      ? sum(entries, current?.usedInodes, workload?.additionalInodes)
      : null,
    profile.inodeCount,
    "Conservative inode planning is separate from bytes; the backend must measure the formatted target rather than assume the nominal inode count.",
  );

  const guest = o.guest;
  compare(
    "global-volume-logical",
    sum(guest?.logicalVolumeBytes, profile.volumeBytes),
    profile.globalVolumeBytes,
    "The existing ledger must already include the source and every retained backup; add the entire new volume before any switch.",
  );
  compare(
    "resident-slots",
    sum(guest?.residentVolumes, 1),
    profile.residentVolumes,
    "The new staging volume also needs a resident slot during migration.",
  );
  compare(
    "global-operations",
    sum(guest?.activeOperations, 1),
    profile.globalOperations,
    "Migration consumes its own operation slot; it never stops another operation.",
  );
  const unallocatedSource =
    bytes === null || allocated === null ? null : bytes - allocated;
  compare(
    "guest-physical-headroom",
    sum(
      profile.volumeBytes,
      unallocatedSource,
      guest?.unallocatedOtherVolumeBytes,
      guest?.reservedPhysicalBytes,
      profile.reserveBytes,
      2 * MiB,
    ),
    number(guest?.availableBytes),
    "Reserve the full target, remaining source growth and other promises, plus a 1 GiB floor; a free-space snapshot is not an OS reservation.",
  );
  compare(
    "guest-filesystem-inodes",
    sum(guest?.reservedInodes, 8),
    number(guest?.availableInodes),
    "Outer storage needs new image, journal and directory inodes in addition to the inodes inside the project filesystem.",
  );
  compare(
    "host-physical-headroom",
    sum(o.host?.reservedBytes, profile.reserveBytes, 2 * MiB),
    number(o.host?.availableBytes),
    "Host control metadata and existing promises need independent physical headroom.",
  );
  compare(
    "host-filesystem-inodes",
    sum(o.host?.reservedInodes, 8),
    number(o.host?.availableInodes),
    "Unknown inode availability is not treated as unlimited.",
  );
  compare(
    "recovery-envelope",
    sum(o.recovery?.usedBytes, o.recovery?.transactionBytes),
    profile.recoveryBytes,
    "The shared 512 MiB recovery budget remains unchanged. Larger cumulative media does not authorize a larger or partial recovery transaction.",
  );
  const contentOnlySmallestProfileId =
    complete &&
    source !== null &&
    media !== null &&
    files !== null &&
    entries !== null
      ? (CAPACITY_PROFILES.find(
          (item) =>
            source <= item.sourceBytes &&
            media <= item.mediaBytes &&
            files <= item.fileCount &&
            entries <= item.entryCount,
        )?.id ?? null)
      : null;
  const assessment = constraints.some((item) => item.status === "blocked")
    ? ("blocked" as const)
    : constraints.some((item) => item.status === "unknown")
      ? ("unknown" as const)
      : ("fits-observed-budgets" as const);
  return {
    version: 1 as const,
    profile,
    authorization: "none" as const,
    readyForMigration: false as const,
    runtimeEnabled: false as const,
    assessment,
    contentOnlySmallestProfileId,
    constraints,
    revalidation:
      "Fresh space, inode, ledger, source identity, complete target integrity and explicit durable native authorization are required at execution. These candidate contracts are not enabled in the existing runtime.",
    performance:
      "Encoded size and volume capacity do not establish decode peaks, GPU texture limits, draw calls or frame time. Choose the smallest observed-budget fit and measure the target device.",
  };
}

export type ExecutionCapacityProposal = ReturnType<
  typeof planExecutionCapacityProposal
>;
