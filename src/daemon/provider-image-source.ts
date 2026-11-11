import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { containsKnownSensitiveValue } from "../shared/sensitive-values.js";
import { providerArtifactUrl } from "./provider-network.js";

interface ImageSource {
  version: 1;
  url: string;
  sha256: string;
  size: number;
}

// Capabilities deliberately survive neither JSON nor object spread. Public asset metadata is not proof of origin.
const sources = new WeakMap<object, Readonly<ImageSource>>();
const validId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function sourceUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 16_384 ||
    /[\x00-\x20\x7f\\]/.test(value) ||
    containsKnownSensitiveValue(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://kunpoapiimg.ziy.cc" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

export function isKunpoImageSourceUrl(
  value: unknown,
  controlBase: string,
  secrets: readonly string[] = [],
): value is string {
  try {
    return (
      new URL(controlBase).origin === "https://llm.ziy.cc" &&
      sourceUrl(value) &&
      !secrets.some(
        (secret) =>
          value.includes(secret) || value.includes(encodeURIComponent(secret)),
      )
    );
  } catch {
    return false;
  }
}

function validSource(value: unknown): value is ImageSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as ImageSource;
  return (
    Object.keys(source).sort().join(",") === "sha256,size,url,version" &&
    source.version === 1 &&
    sourceUrl(source.url) &&
    /^[a-f0-9]{64}$/.test(source.sha256) &&
    Number.isSafeInteger(source.size) &&
    source.size > 0 &&
    source.size <= 64 * 1024 * 1024
  );
}

/** Only called after the reviewed Kunpo image response has actually been downloaded and validated. */
export function rememberKunpoImageSource(
  image: { bytes: Uint8Array },
  url: string,
  controlBase: string,
): void {
  try {
    if (new URL(controlBase).origin !== "https://llm.ziy.cc" || !sourceUrl(url))
      return;
    const source: ImageSource = {
      version: 1,
      url,
      sha256: digest(image.bytes),
      size: image.bytes.byteLength,
    };
    if (validSource(source)) sources.set(image, Object.freeze(source));
  } catch {
    /* Missing provenance must not discard an already paid image. */
  }
}

export function copyProviderImageSource<T extends object>(
  from: object,
  to: T,
): T {
  const source = sources.get(from);
  if (source) sources.set(to, source);
  return to;
}

/** Compare the exact bytes used for this request, including same-size edits. Never trust names or origin labels. */
export function matchingKunpoImageUrl(
  reference: object,
  bytes: Uint8Array,
  controlBase: string,
  secrets: readonly string[],
): string | undefined {
  const source = sources.get(reference);
  if (
    !source ||
    new URL(controlBase).origin !== "https://llm.ziy.cc" ||
    !validSource(source) ||
    source.size !== bytes.byteLength ||
    digest(bytes) !== source.sha256 ||
    secrets.some(
      (secret) =>
        source.url.includes(secret) ||
        source.url.includes(encodeURIComponent(secret)),
    )
  )
    return undefined;
  return source.url;
}

/** Per-reference decisions for APIs that explicitly accept URLs. No HTTP/upload and no URL retained by callers' public inputs. */
export async function kunpoReferenceImageUrls(
  images: readonly { data: string; mediaType?: string; mimeType?: string }[],
  controlBase: string,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
): Promise<Array<string | undefined>> {
  const urls = images.map((image) =>
    sources.has(image) &&
    typeof image.data === "string" &&
    image.data.length <= 90 * 1024 * 1024
      ? matchingKunpoImageUrl(
          image,
          Buffer.from(image.data, "base64"),
          controlBase,
          secrets,
        )
      : undefined,
  );
  if (urls.some(Boolean)) {
    try {
      await providerArtifactUrl(
        "https://kunpoapiimg.ziy.cc/",
        controlBase,
        undefined,
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      return images.map(() => undefined);
    }
  }
  signal?.throwIfAborted();
  return urls;
}

/** Private per-asset receipts. URLs never enter Library JSON, renderer, workspace exports, or task fingerprints. */
export class ProviderImageSourceStore {
  constructor(private readonly directory: string) {}

  async bind(id: string, image: { bytes: Uint8Array }): Promise<boolean> {
    const source = sources.get(image);
    if (
      !validId(id) ||
      !source ||
      !validSource(source) ||
      source.size !== image.bytes.byteLength ||
      source.sha256 !== digest(image.bytes)
    )
      return false;
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        (process.getuid && directory.uid !== process.getuid())
      )
        return false;
      await chmod(this.directory, 0o700);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(source));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(this.directory, `${id}.json`));
      return true;
    } catch {
      return false;
    } finally {
      // The local image remains usable if optional provenance cannot be stored.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async attach(id: string, target: object): Promise<boolean> {
    sources.delete(target);
    if (!validId(id)) return false;
    try {
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        (process.getuid && directory.uid !== process.getuid())
      )
        return false;
      const handle = await open(
        path.join(this.directory, `${id}.json`),
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 32 * 1024 ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())
        )
          return false;
        const bytes = Buffer.alloc(32 * 1024 + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const final = await handle.stat();
        if (
          bytesRead !== info.size ||
          final.size !== info.size ||
          final.mtimeMs !== info.mtimeMs ||
          final.ctimeMs !== info.ctimeMs ||
          final.nlink !== 1
        )
          return false;
        const source: unknown = JSON.parse(
          bytes.subarray(0, bytesRead).toString("utf8"),
        );
        if (!validSource(source)) return false;
        sources.set(target, Object.freeze(source));
        return true;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    if (!validId(id)) return;
    try {
      if ((await lstat(this.directory)).isDirectory())
        await rm(path.join(this.directory, `${id}.json`), { force: true });
    } catch {
      /* An unavailable private receipt cannot grant a URL capability. */
    }
  }
}
