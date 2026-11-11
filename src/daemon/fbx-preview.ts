import { inflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

export const FBX_MEDIA_TYPE = "application/vnd.autodesk.fbx";
const MAX_FBX_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
export function isBinaryFbx(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 23)).equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0"));
}

/** Preserve ASCII originals too, although the bounded preview converter supports binary FBX only. */
export function isFbxArtifact(bytes: Uint8Array): boolean {
  return isBinaryFbx(bytes) || /^; FBX \d\.\d\.\d project file[\r\n]/.test(Buffer.from(bytes.subarray(0, 100)).toString("ascii"));
}

/** Inspect lengths before Three's parser allocates/decompresses provider-controlled arrays. No external files are read. */
export function inspectFbx(bytes: Buffer): { centimeters: number; polygons: number; quads: number } {
  if (bytes.length < 40 || bytes.length > MAX_FBX_BYTES || !isBinaryFbx(bytes)) throw new Error("Unsupported FBX header or size");
  const version = bytes.readUInt32LE(23), wide = version >= 7500, header = wide ? 25 : 13;
  if (version < 7400 || version > 7700) throw new Error("Unsupported FBX version");
  let nodes = 0, decoded = 0, polygons = 0, quads = 0, centimeters = 1;
  const size = (offset: number) => {
    const value = wide ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset);
    if (!Number.isSafeInteger(value)) throw new Error("Invalid FBX length");
    return value;
  };
  const visit = (start: number, parentEnd: number, depth: number, global = false): number => {
    if (++nodes > 100_000 || depth > 64 || start + header > parentEnd) throw new Error("FBX structure exceeds preview limits");
    const end = size(start), count = size(start + (wide ? 8 : 4)), propertyBytes = size(start + (wide ? 16 : 8));
    if (!end) return start + header;
    const nameLength = bytes[start + header - 1]!;
    let offset = start + header + nameLength;
    const propertyEnd = offset + propertyBytes;
    if (end <= start || end > parentEnd || propertyEnd > end || count > 1_000_000) throw new Error("Invalid FBX node");
    const name = bytes.toString("utf8", start + header, offset), values: Array<string | number> = [];
    for (let i = 0; i < count; i++) {
      if (offset >= propertyEnd) throw new Error("Invalid FBX property");
      const type = String.fromCharCode(bytes[offset++]!), scalar = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 }[type as "Y"];
      if (scalar) {
        if (offset + scalar > propertyEnd) throw new Error("Invalid FBX scalar");
        if (global && name === "P" && type === "D") values.push(bytes.readDoubleLE(offset));
        offset += scalar;
      } else if (type === "S" || type === "R") {
        if (offset + 4 > propertyEnd) throw new Error("Invalid FBX string");
        const length = bytes.readUInt32LE(offset); offset += 4;
        if (offset + length > propertyEnd || type === "S" && length > 16_384) throw new Error("Invalid FBX content");
        if (global && name === "P" && type === "S") values.push(bytes.toString("utf8", offset, offset + length));
        offset += length;
      } else if ("fdlibc".includes(type)) {
        if (offset + 12 > propertyEnd) throw new Error("Invalid FBX array");
        const length = bytes.readUInt32LE(offset), encoding = bytes.readUInt32LE(offset + 4), compressed = bytes.readUInt32LE(offset + 8);
        const stride = type === "d" || type === "l" ? 8 : type === "f" || type === "i" ? 4 : 1;
        const expected = length * stride; decoded += expected; offset += 12;
        if (encoding > 1 || decoded > MAX_DECODED_BYTES || offset + compressed > propertyEnd || name === "PolygonVertexIndex" && length > 1_200_000) throw new Error("FBX arrays exceed preview limits");
        const payload = bytes.subarray(offset, offset + compressed);
        const array = encoding ? inflateSync(payload, { maxOutputLength: Math.max(1, expected) }) : payload;
        if (array.length !== expected) throw new Error("Invalid FBX decoded length");
        if (name === "PolygonVertexIndex") {
          if (type !== "i") throw new Error("Invalid FBX polygon indices");
          let corners = 0;
          for (let index = 0; index < length; index++) {
            if (++corners > 64) throw new Error("FBX polygon exceeds preview limits");
            if (array.readInt32LE(index * 4) < 0) { polygons++; if (corners === 4) quads++; corners = 0; }
          }
          if (corners || polygons > 300_000) throw new Error("Invalid FBX polygons");
        }
        offset += compressed;
      } else throw new Error("Unsupported FBX property");
    }
    if (offset !== propertyEnd) throw new Error("Invalid FBX property length");
    if (global && name === "P" && values[0] === "UnitScaleFactor") {
      const value = values.at(-1);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000) throw new Error("Invalid FBX units");
      centimeters = value;
    }
    while (offset < end - header) offset = visit(offset, end, depth + 1, global || name === "GlobalSettings");
    if (offset !== end && (offset + header !== end || bytes.subarray(offset, end).some(value => value !== 0))) throw new Error("Invalid FBX node ending");
    return end;
  };
  let offset = 27;
  while (offset + header <= bytes.length) {
    const next = visit(offset, bytes.length, 0);
    if (next === offset + header) break;
    offset = next;
  }
  if (!polygons) throw new Error("FBX contains no mesh polygons");
  return { centimeters, polygons, quads };
}

let converting = Promise.resolve();
/** One bounded worker at a time; workers receive only model bytes, never credentials or environment values. */
export async function createFbxPreview(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  let release!: () => void;
  const previous = converting;
  converting = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous; signal?.throwIfAborted();
    return await new Promise<Buffer>((resolve, reject) => {
      const source = import.meta.url.endsWith(".ts");
      const worker = new Worker(new URL(source ? "./fbx-preview-worker.ts" : "./fbx-preview-worker.js", import.meta.url), {
        workerData: new Uint8Array(bytes), env: {},
        stdout: true, stderr: true,
        execArgv: source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      worker.stdout?.resume(); worker.stderr?.resume();
      let finished = false;
      const finish = (error?: Error, result?: Buffer) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        void worker.terminate().finally(() => { if (error) reject(error); else resolve(result!); });
      };
      const abort = () => finish(new Error("Local FBX preview cancelled"));
      const timer = setTimeout(() => finish(new Error("Local FBX preview timed out")), 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (value: { bytes?: Uint8Array }) => value?.bytes ? finish(undefined, Buffer.from(value.bytes)) : finish(new Error("This FBX cannot be previewed locally")));
      worker.once("error", () => finish(new Error("Local FBX preview worker failed")));
      worker.once("exit", () => finish(new Error("Local FBX preview worker stopped")));
    });
  } finally { release(); }
}
