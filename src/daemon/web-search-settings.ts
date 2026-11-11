import { registerSensitiveValue } from "../shared/sensitive-values.js";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WebSearchProvider,
  WebSearchSettings,
} from "../shared/web-search.js";

export interface StoredWebSearchSettings {
  version: 1;
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKey?: string;
  parallelApiKey?: string;
  custom?: {
    name: string;
    endpoint: string;
    toolName: string;
    apiKey?: string;
  };
}

const DEFAULT_SETTINGS: StoredWebSearchSettings = {
  version: 1,
  enabled: false,
  provider: "auto",
  fallback: false,
};

export class WebSearchSettingsStore {
  readonly #filePath: string;
  #settings: StoredWebSearchSettings = { ...DEFAULT_SETTINGS };

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "web-search-settings.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as unknown;
      if (!isStoredSettings(value))
        throw new Error(`Invalid web search settings: ${this.#filePath}`);
      this.#settings = value;
      registerSensitiveValue(this.#settings.exaApiKey);
      registerSensitiveValue(this.#settings.parallelApiKey);
      registerSensitiveValue(this.#settings.custom?.apiKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): WebSearchSettings {
    const value = this.#settings;
    return {
      enabled: false,
      provider: value.provider,
      fallback: false,
      exaApiKeyConfigured: Boolean(value.exaApiKey),
      parallelApiKeyConfigured: Boolean(value.parallelApiKey),
      ...(value.custom
        ? {
            custom: {
              apiKeyConfigured: Boolean(value.custom.apiKey),
            },
          }
        : {}),
    };
  }

  async clearCredentials(): Promise<WebSearchSettings> {
    const current = this.#settings;
    if (!current.exaApiKey && !current.parallelApiKey && !current.custom?.apiKey) return this.get();
    const { exaApiKey: _exa, parallelApiKey: _parallel, ...next } = current;
    if (next.custom) {
      const { apiKey: _customKey, ...custom } = next.custom;
      next.custom = custom;
    }
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#settings = next;
    return this.get();
  }
}

function isStoredSettings(value: unknown): value is StoredWebSearchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredWebSearchSettings>;
  if (
    candidate.version !== 1 ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.fallback !== "boolean"
  )
    return false;
  if (
    !candidate.provider ||
    !["auto", "exa", "parallel", "custom"].includes(candidate.provider)
  )
    return false;
  if (
    candidate.exaApiKey !== undefined &&
    typeof candidate.exaApiKey !== "string"
  )
    return false;
  if (
    candidate.parallelApiKey !== undefined &&
    typeof candidate.parallelApiKey !== "string"
  )
    return false;
  if (candidate.custom === undefined) return candidate.provider !== "custom";
  return (
    typeof candidate.custom.name === "string" &&
    Boolean(candidate.custom.name.trim()) &&
    typeof candidate.custom.endpoint === "string" &&
    Boolean(candidate.custom.endpoint) &&
    typeof candidate.custom.toolName === "string" &&
    Boolean(candidate.custom.toolName.trim()) &&
    (candidate.custom.apiKey === undefined ||
      typeof candidate.custom.apiKey === "string")
  );
}
