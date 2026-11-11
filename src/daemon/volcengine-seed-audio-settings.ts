import { registerSensitiveValue } from "../shared/sensitive-values.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOUBAO_SEED_AUDIO_PROVIDER_NAME } from "../shared/audio.js";

interface StoredVolcengineSeedAudioSettings {
  version: 1;
  apiKey?: string;
}

export class VolcengineSeedAudioSettingsStore {
  readonly #filePath: string;
  #settings: StoredVolcengineSeedAudioSettings = { version: 1 };
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "volcengine-seed-audio.json");
  }

  async load(): Promise<void> {
    try {
      const handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      let parsed: Record<string, unknown>;
      try {
        const entry = await handle.stat();
        if (!entry.isFile() || entry.nlink !== 1 || entry.size > 1024 * 1024 || process.platform !== "win32" &&
          ((entry.mode & 0o077) !== 0 || typeof process.getuid === "function" && entry.uid !== process.getuid())) throw new Error("Audio settings are not private");
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024 * 1024) throw new Error("Audio settings are too large");
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))) as Record<string, unknown>;
      } finally { await handle.close(); }
      if (parsed.version !== 1)
        throw new Error(
          `Invalid ${DOUBAO_SEED_AUDIO_PROVIDER_NAME} settings: ${this.#filePath}`,
        );
      this.#settings = {
        version: 1,
        ...(typeof parsed.apiKey === "string" && parsed.apiKey
          ? { apiKey: parsed.apiKey }
          : {}),
      };
      registerSensitiveValue(this.#settings.apiKey);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  get(): { configured: boolean } {
    return { configured: Boolean(this.#settings.apiKey) };
  }

  key(): string | undefined {
    return this.#settings.apiKey;
  }

  async update(apiKey: string): Promise<{ configured: boolean }> {
    const normalized = apiKey.trim();
    if (!normalized || !/^[\x21-\x7E]+$/.test(normalized))
      throw new Error(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} API key must contain only printable ASCII characters`,
      );
    registerSensitiveValue(normalized);
    await this.#mutate(async () => {
      const next: StoredVolcengineSeedAudioSettings = {
        version: 1,
        apiKey: normalized,
      };
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, this.#filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      this.#settings = next;
    });
    return this.get();
  }

  async clear(): Promise<void> {
    await this.#mutate(async () => {
      await rm(this.#filePath, { force: true });
      this.#settings = { version: 1 };
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.#mutations.then(operation);
    this.#mutations = pending.catch(() => undefined);
    await pending;
  }
}
