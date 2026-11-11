import type { CloudCatalog, CloudConnectionState, CloudGenerationJob, CloudQuotaSnapshot } from "../shared/cloud-models.js";
import type { MediaModelCatalog, Model3DModel, ProviderSummary } from "../shared/contracts.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DGenerationInput, type Model3DGenerator } from "./model3d.js";

export const LOCAL_CLOUD_UNAVAILABLE = "Account cloud services are not provided by the local secure edition.";
const unavailable = () => new Model3DGenerationError(LOCAL_CLOUD_UNAVAILABLE, 410);

/** Retained document contract; no account, transport or remote configuration is retained. */
export class CloudModelsClient implements Model3DGenerator {
  constructor(_apiUrl = "", _request?: typeof fetch, _wait?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>) {}
  async setSession(input: { accessToken: string; userId: string } | null): Promise<void> { if (input) throw unavailable(); }
  async refresh(_force = false): Promise<void> {}
  hasProvider(_providerId: string): boolean { return false; }
  providersSnapshot(_isEnabled: (id: string) => boolean): ProviderSummary[] { return []; }
  connection(_provider: string): CloudConnectionState { return { availability: "unavailable", message: LOCAL_CLOUD_UNAVAILABLE }; }
  catalogSnapshot(): CloudCatalog { return { providers: [], models: [] }; }
  async catalog(): Promise<MediaModelCatalog<Model3DModel>> { return { models: [], providers: [] }; }
  async quotas(): Promise<CloudQuotaSnapshot | null> { throw unavailable(); }
  async jobs(): Promise<CloudGenerationJob[]> { throw unavailable(); }
  async result(_id: string, _signal?: AbortSignal): Promise<Buffer> { throw unavailable(); }
  async generate(_input: Model3DGenerationInput, _signal?: AbortSignal): Promise<Generated3DModel> { throw unavailable(); }
}

export function cloudMessage(_cloud: CloudConnectionState): string { return LOCAL_CLOUD_UNAVAILABLE; }
