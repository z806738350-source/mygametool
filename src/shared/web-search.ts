export type WebSearchProvider = "auto" | "exa" | "parallel" | "custom";

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKeyConfigured: boolean;
  parallelApiKeyConfigured: boolean;
  custom?: { apiKeyConfigured: boolean };
}

/** Display metadata for historical search results. */
export interface WebSearchToolMetadata {
  provider: Exclude<WebSearchProvider, "auto">;
  providerName: string;
  fallbackFrom?: Exclude<WebSearchProvider, "auto">;
}
