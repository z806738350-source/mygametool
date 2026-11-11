import { createHash } from "node:crypto";
import { isPrivateProjectPath } from "../shared/private-project-paths.js";
import {
  getRuntimeCapacityProfile,
  runtimeMediaFileLimit,
  type RuntimeCapacityProfileId,
} from "../shared/execution-capacity-profiles.js";

const MiB = 1024 * 1024;
const hash = /^[a-f0-9]{64}$/;
export interface SourceManifestEntryV1 {
  readonly path: string;
  readonly kind: "source" | "media";
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}
export interface SourceManifestV1 {
  readonly version: 1;
  readonly profile: "current-64";
  readonly permissionSemantics: "executable-only";
  readonly manifestId: string;
  readonly files: readonly SourceManifestEntryV1[];
}
export interface SourceManifestV2 {
  readonly version: 2;
  readonly profile: RuntimeCapacityProfileId;
  readonly limits: ReturnType<typeof getRuntimeCapacityProfile>;
  readonly permissionSemantics: "executable-only";
  readonly manifestId: string;
  readonly files: readonly SourceManifestEntryV1[];
}
export type SourceManifest = SourceManifestV1 | SourceManifestV2;
export interface SourceManifestScopeV2 {
  sourceManifestVersion: 2;
  sourceProfileId: RuntimeCapacityProfileId;
}
export interface SourceDeltaSummaryV1 {
  readonly version: 1;
  readonly beforeManifestId: string;
  readonly afterManifestId: string;
  readonly addedFiles: number;
  readonly modifiedFiles: number;
  readonly removedFiles: number;
  readonly unchangedFiles: number;
  readonly beforeSourceBytes: number;
  readonly beforeMediaBytes: number;
  readonly afterSourceBytes: number;
  readonly afterMediaBytes: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}
export interface SourceDeltaChangeV1 {
  readonly path: string;
  readonly change: "added" | "modified" | "removed" | "unchanged";
  readonly before?: SourceManifestEntryV1;
  readonly after?: SourceManifestEntryV1;
}
export interface SourceDeltaPlanV1 {
  readonly summary: SourceDeltaSummaryV1;
  readonly changes: readonly SourceDeltaChangeV1[];
}
export interface SourceContractV1 {
  readonly version: 1;
  readonly baseManifestId: string;
  readonly rawManifestId: string;
  readonly preparedManifestId?: string;
}
export interface SourceContractV2 {
  readonly version: 2;
  readonly profileId: RuntimeCapacityProfileId;
  readonly baseManifestId: string;
  readonly rawManifestId: string;
  readonly preparedManifestId?: string;
}
export type SourceContract = SourceContractV1 | SourceContractV2;

function invalid(): never {
  throw new Error("Invalid versioned isolated source manifest or delta");
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** The transfer-path policy only; this grants no file, media or publication authority. */
export function assertSourceManifestPath(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1000 ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          ["node_modules", "dist", "build", "out"].includes(part),
      ) ||
    isPrivateProjectPath(value)
  )
    invalid();
}

/** Unicode code-point order agrees with Python, including supplementary characters. */
function comparePath(left: string, right: string): number {
  const a = Array.from(left),
    b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

/** Equivalent to Python json.dumps(rows, ensure_ascii=True, separators=(',', ':')). */
export function canonicalSourceManifestRows(
  files: readonly SourceManifestEntryV1[],
): string {
  return JSON.stringify(
    [...files]
      .sort((a, b) => comparePath(a.path, b.path))
      .map((file) => [
        file.path,
        file.kind,
        file.size,
        file.sha256,
        file.executable,
      ]),
  ).replace(
    /[\u007f-\uffff]/g,
    (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** Metadata classification is descriptive, never a verified-copy or raster receipt. */
function validatedEntries(
  entries: readonly SourceManifestEntryV1[],
  mediaLimit: number,
  profileId?: RuntimeCapacityProfileId,
): readonly SourceManifestEntryV1[] {
  if (!Array.isArray(entries) || entries.length > 2000) invalid();
  let sourceBytes = 0,
    mediaBytes = 0;
  const paths = new Set<string>();
  const files = entries
    .map((entry: SourceManifestEntryV1) => {
      if (!exact(entry, ["path", "kind", "size", "sha256", "executable"]))
        invalid();
      assertSourceManifestPath(entry.path);
      if (
        paths.has(entry.path) ||
        !["source", "media"].includes(entry.kind) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sha256 !== "string" ||
        !hash.test(entry.sha256) ||
        typeof entry.executable !== "boolean"
      )
        invalid();
      paths.add(entry.path);
      if (entry.kind === "media") {
        if (
          entry.executable ||
          entry.size < 1 ||
          entry.size > runtimeMediaFileLimit(entry.path, profileId) ||
          !/(?:^|\/)(?:public|src)\/|^assets\/(?:imported|generated|files)\//.test(
            entry.path,
          ) ||
          !/\.(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|m4a|mp3|wav|ogg|glb)$/i.test(
            entry.path,
          )
        )
          invalid();
        mediaBytes += entry.size;
      } else {
        if (entry.size > 2 * MiB) invalid();
        sourceBytes += entry.size;
      }
      if (sourceBytes > 8 * MiB || mediaBytes > mediaLimit) invalid();
      return Object.freeze({
        path: entry.path,
        kind: entry.kind,
        size: entry.size,
        sha256: entry.sha256,
        executable: entry.executable,
      });
    })
    .sort((a, b) => comparePath(a.path, b.path));
  for (const name of paths) {
    const parts = name.split("/");
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join("/"))) invalid();
  }
  return Object.freeze(files);
}

export function createSourceManifest(
  entries: readonly SourceManifestEntryV1[],
): SourceManifestV1 {
  const files = validatedEntries(entries, 64 * MiB);
  const manifestId = createHash("sha256")
    .update(
      "ohmygame-source-manifest-v1\n" + canonicalSourceManifestRows(files),
      "ascii",
    )
    .digest("hex");
  return Object.freeze({
    version: 1,
    profile: "current-64",
    permissionSemantics: "executable-only",
    manifestId,
    files: Object.freeze(files),
  });
}

export function createSourceManifestV2(
  profileId: RuntimeCapacityProfileId,
  entries: readonly SourceManifestEntryV1[],
): SourceManifestV2 {
  const limits = getRuntimeCapacityProfile(profileId),
    files = validatedEntries(entries, limits.mediaBytes, limits.id);
  const canonical = JSON.stringify([
    limits,
    JSON.parse(canonicalSourceManifestRows(files)),
  ]).replace(
    /[\u007f-\uffff]/g,
    (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const manifestId = createHash("sha256")
    .update("ohmygame-source-manifest-v2\n" + canonical, "ascii")
    .digest("hex");
  return Object.freeze({
    version: 2,
    profile: limits.id,
    limits,
    permissionSemantics: "executable-only",
    manifestId,
    files,
  });
}

export function parseSourceManifest(value: unknown): SourceManifest {
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2
  ) {
    const supplied = value as Record<string, unknown>;
    if (
      !exact(supplied, [
        "version",
        "profile",
        "limits",
        "permissionSemantics",
        "manifestId",
        "files",
      ]) ||
      supplied.permissionSemantics !== "executable-only" ||
      !Array.isArray(supplied.files)
    )
      invalid();
    const limits = getRuntimeCapacityProfile(supplied.profile),
      suppliedLimits = supplied.limits;
    if (
      !exact(suppliedLimits, Object.keys(limits)) ||
      Object.entries(limits).some(
        ([key, field]) => suppliedLimits[key] !== field,
      )
    )
      invalid();
    const manifest = createSourceManifestV2(
      limits.id,
      supplied.files as SourceManifestEntryV1[],
    );
    if (supplied.manifestId !== manifest.manifestId) invalid();
    return manifest;
  }
  if (
    !exact(value, [
      "version",
      "profile",
      "permissionSemantics",
      "manifestId",
      "files",
    ]) ||
    value.version !== 1 ||
    value.profile !== "current-64" ||
    value.permissionSemantics !== "executable-only" ||
    typeof value.manifestId !== "string" ||
    !hash.test(value.manifestId) ||
    !Array.isArray(value.files)
  )
    invalid();
  const manifest = createSourceManifest(value.files as SourceManifestEntryV1[]);
  if (manifest.manifestId !== value.manifestId) invalid();
  return manifest;
}

/** Compact legacy baseline sizes are positional only after canonical path sorting. */
export function sourceManifestFromLegacyBaseline(
  baseline: readonly {
    path: string;
    sha256: string;
    executable?: boolean;
    size?: number;
  }[],
  sizes: readonly number[],
  scope?: SourceManifestScopeV2,
): SourceManifest {
  if (
    scope &&
    (!exact(scope, ["sourceManifestVersion", "sourceProfileId"]) ||
      scope.sourceManifestVersion !== 2)
  )
    invalid();
  if (
    !Array.isArray(baseline) ||
    !Array.isArray(sizes) ||
    baseline.length !== sizes.length ||
    baseline.length > 2000
  )
    invalid();
  for (const file of baseline) {
    if (!file || typeof file !== "object") invalid();
    assertSourceManifestPath(file.path);
  }
  const entries: SourceManifestEntryV1[] = [...baseline]
    .sort((a, b) => comparePath(a.path, b.path))
    .map((file, index) => {
      const size = sizes[index]!;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (file.executable !== undefined &&
          typeof file.executable !== "boolean") ||
        (Object.hasOwn(file, "size") && file.size !== size)
      )
        invalid();
      return {
        path: file.path,
        kind: Object.hasOwn(file, "size") ? "media" : "source",
        size,
        sha256: file.sha256,
        executable: file.executable === true,
      };
    });
  return scope
    ? createSourceManifestV2(scope.sourceProfileId, entries)
    : createSourceManifest(entries);
}

export function parseSourceContract(value: unknown): SourceContract {
  const prepared =
    !!value &&
    typeof value === "object" &&
    Object.hasOwn(value, "preparedManifestId");
  const version2 =
    !!value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2;
  if (
    !exact(value, [
      "version",
      "baseManifestId",
      "rawManifestId",
      ...(version2 ? ["profileId"] : []),
      ...(prepared ? ["preparedManifestId"] : []),
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.baseManifestId !== "string" ||
    !hash.test(value.baseManifestId) ||
    typeof value.rawManifestId !== "string" ||
    !hash.test(value.rawManifestId) ||
    (prepared &&
      (typeof value.preparedManifestId !== "string" ||
        !hash.test(value.preparedManifestId)))
  )
    invalid();
  if (version2)
    return Object.freeze({
      version: 2,
      profileId: getRuntimeCapacityProfile(value.profileId).id,
      baseManifestId: value.baseManifestId,
      rawManifestId: value.rawManifestId,
      ...(prepared
        ? { preparedManifestId: value.preparedManifestId as string }
        : {}),
    });
  return Object.freeze({
    version: 1,
    baseManifestId: value.baseManifestId,
    rawManifestId: value.rawManifestId,
    ...(prepared
      ? { preparedManifestId: value.preparedManifestId as string }
      : {}),
  });
}

/** Counts both sides independently. A tiny replacement never erases its large before. */
export function planSourceDelta(
  before: SourceManifest,
  after: SourceManifest,
): SourceDeltaPlanV1 {
  before = parseSourceManifest(before);
  after = parseSourceManifest(after);
  if (before.version !== after.version || before.profile !== after.profile)
    invalid();
  const originals = new Map(before.files.map((file) => [file.path, file])),
    returned = new Map(after.files.map((file) => [file.path, file]));
  const summary = {
    version: 1 as const,
    beforeManifestId: before.manifestId,
    afterManifestId: after.manifestId,
    addedFiles: 0,
    modifiedFiles: 0,
    removedFiles: 0,
    unchangedFiles: 0,
    beforeSourceBytes: 0,
    beforeMediaBytes: 0,
    afterSourceBytes: 0,
    afterMediaBytes: 0,
    beforeBytes: 0,
    afterBytes: 0,
  };
  const changes: SourceDeltaChangeV1[] = [
    ...new Set([...originals.keys(), ...returned.keys()]),
  ]
    .sort(comparePath)
    .map((name) => {
      const original = originals.get(name),
        result = returned.get(name);
      const change = !original
        ? "added"
        : !result
          ? "removed"
          : original.kind === result.kind &&
              original.size === result.size &&
              original.sha256 === result.sha256 &&
              original.executable === result.executable
            ? "unchanged"
            : "modified";
      summary[`${change}Files`]++;
      if (change !== "unchanged") {
        if (original) {
          summary[
            original.kind === "source"
              ? "beforeSourceBytes"
              : "beforeMediaBytes"
          ] += original.size;
          summary.beforeBytes += original.size;
        }
        if (result) {
          summary[
            result.kind === "source" ? "afterSourceBytes" : "afterMediaBytes"
          ] += result.size;
          summary.afterBytes += result.size;
        }
      }
      return Object.freeze({
        path: name,
        change,
        ...(original ? { before: original } : {}),
        ...(result ? { after: result } : {}),
      });
    });
  return Object.freeze({
    summary: Object.freeze(summary),
    changes: Object.freeze(changes),
  });
}

export function assertSourceDeltaSummary(
  value: unknown,
  before: SourceManifest,
  after: SourceManifest,
): void {
  const expected = planSourceDelta(before, after).summary;
  if (
    !exact(value, Object.keys(expected)) ||
    Object.entries(expected).some(([key, field]) => value[key] !== field)
  )
    invalid();
}
