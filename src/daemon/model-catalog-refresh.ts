import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MODEL_CATALOG_REFRESH_ERROR = "Automatic SDK catalogs are unavailable in the local secure edition. Configure or explicitly discover a reviewed provider.";

/** Retained coordinator contract; saved credentials and environment variables cannot restore background networking. */
export class ModelCatalogRefresh {
  constructor(_enabled: (provider: string) => boolean) {}
  canRefresh(_runtime: ModelRuntime, _provider: string): boolean { return false; }
  schedule(_runtime: ModelRuntime, _providers?: readonly string[]): string[] { return []; }
  refreshing(_provider: string): boolean { return false; }
  async refresh(_runtime: ModelRuntime, _provider: string, force = false): Promise<void> {
    if (force) throw new Error(MODEL_CATALOG_REFRESH_ERROR);
  }
  invalidate(_provider: string): void {}
  close(): void {}
}
