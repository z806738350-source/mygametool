/** Local source-edition cleanup. Paths are display-only; mutations accept opaque IDs. */
export const STORAGE_CATEGORIES = [
  "finder-metadata",
  "tool-cache",
  "install-archives",
  "browser-cache",
  "runtime-temp",
  "upgrade-tests",
  "library-residue",
  "protected-data",
] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];
export type StorageCleanupReason =
  | "unsupported"
  | "protected"
  | "running"
  | "unknown"
  | "changed"
  | "in-use"
  | "permission"
  | "linked"
  | "tracked"
  | "unverified"
  | "limit"
  | "expired"
  | "busy"
  | "invalid"
  | "failed";
export interface StorageBytes {
  logicalBytes: number;
  allocatedBytes: number;
}
export interface StorageCleanupItem extends StorageBytes {
  id: string;
  category: StorageCategory;
  relativePath: string;
  fileCount: number;
  state: "eligible" | "blocked";
  reason?: StorageCleanupReason;
  impact: "regenerable" | "installer-copy" | "preserved";
  measurementComplete?: boolean;
}
export interface StorageCleanupScan extends StorageBytes {
  supported: boolean;
  rootPath?: string;
  reason?: StorageCleanupReason;
  scanId: string;
  createdAt: string;
  expiresAt: string;
  items: StorageCleanupItem[];
  errors: { relativePath: string; reason: StorageCleanupReason }[];
  measurementComplete?: boolean;
}
export interface StorageCleanupPlanRequest {
  scanId: string;
  itemIds: string[];
}
export interface StorageCleanupEntry extends StorageBytes {
  id: string;
  itemId: string;
  category: StorageCategory;
  relativePath: string;
}
export interface StorageCleanupPlan extends StorageBytes {
  scanId: string;
  planId: string;
  confirmationToken: string;
  expiresAt: string;
  entries: StorageCleanupEntry[];
  permanent: true;
}
export interface StorageCleanupExecuteRequest {
  planId: string;
  confirmationToken: string;
  confirmation: "PERMANENT_DELETE";
}
export interface StorageCleanupResult {
  planId: string;
  completedAt: string;
  entries: (StorageCleanupEntry & {
    status: "deleted" | "retained" | "failed";
    reason?: StorageCleanupReason;
  })[];
  deletedLogicalBytes: number;
  deletedAllocatedBytes: number;
}
export interface DesktopStorageCleanup {
  scan(): Promise<StorageCleanupScan>;
  plan(request: StorageCleanupPlanRequest): Promise<StorageCleanupPlan>;
  execute(request: StorageCleanupExecuteRequest): Promise<StorageCleanupResult>;
  result(planId: string): Promise<StorageCleanupResult | undefined>;
}
