import { registerSensitiveValue } from "../shared/sensitive-values.js";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { DOUBAO_SPEECH_PROVIDER_NAME } from "../shared/audio.js";

/** Preserves legacy local data; active Kunpo speech never consumes its key or Speaker ID. */
export class VolcengineTtsSettingsStore {
  readonly #filePath: string;
  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "volcengine-tts.json");
  }

  async load(): Promise<void> {
    try {
      const handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      let parsed: Record<string, unknown>;
      try {
        const entry = await handle.stat();
        if (!entry.isFile() || entry.nlink !== 1 || entry.size > 1024 * 1024 || process.platform !== "win32" &&
          ((entry.mode & 0o077) !== 0 || typeof process.getuid === "function" && entry.uid !== process.getuid())) throw new Error("Speech settings are not private");
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024 * 1024) throw new Error("Speech settings are too large");
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))) as Record<string, unknown>;
      } finally { await handle.close(); }
      if (parsed.version !== 1)
        throw new Error(`Invalid ${DOUBAO_SPEECH_PROVIDER_NAME} settings: ${this.#filePath}`);
      if (typeof parsed.apiKey === "string") registerSensitiveValue(parsed.apiKey);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  async clear(): Promise<void> {
    await rm(this.#filePath, { force: true });
  }
}
