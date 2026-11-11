import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginSeedTransaction,
  commitSeedTransaction,
  createCapacityManifest,
  inspectSeedTransaction,
  parseCapacityManifest,
  writeSeedWindow,
  type SeedScope,
} from "../src/daemon/isolated-capacity-seed.js";
import type { SourceManifestEntryV1 } from "../src/daemon/isolated-source-manifest.js";

const MiB = 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const zero = Buffer.alloc(MiB);
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function pngHash(size: number): string {
  const result = createHash("sha256").update(signature);
  let rest = size - signature.length;
  while (rest > 0) {
    const size = Math.min(rest, zero.length);
    result.update(zero.subarray(0, size));
    rest -= size;
  }
  return result.digest("hex");
}
async function* pngStream(sizes: readonly number[]) {
  for (const size of sizes) {
    yield signature;
    let rest = size - signature.length;
    while (rest > 0) {
      const count = Math.min(rest, zero.length);
      yield zero.subarray(0, count);
      rest -= count;
    }
  }
}
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  sizes = [16],
  profile:
    "capacity-64-v1" | "capacity-128-v1" | "capacity-256-v1" = "capacity-64-v1",
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "capacity-seed-test-")),
  );
  roots.push(root);
  const sources = [
    { path: "main.js", data: Buffer.from("hello").toString("base64") },
  ];
  const files: SourceManifestEntryV1[] = [
    {
      path: "main.js",
      kind: "source",
      size: 5,
      sha256: hash(Buffer.from("hello")),
      executable: false,
    },
    ...sizes.map((size, index) => ({
      path: `public/${index}.png`,
      kind: "media" as const,
      size,
      sha256: pngHash(size),
      executable: false,
    })),
  ];
  const manifest = createCapacityManifest(profile, files);
  const scope: SeedScope = {
    transactionId: randomBytes(16).toString("hex"),
    namespace: "test",
    projectId: "fixture",
    operationId: randomBytes(16).toString("hex"),
    generation: 1,
    profile,
    manifestId: manifest.manifestId,
    baselineManifestId: createCapacityManifest(profile, []).manifestId,
  };
  return {
    root,
    sources,
    files,
    manifest,
    scope,
    request: { scope, manifest, sources },
  };
}

describe("capacity seed manifest", () => {
  it("binds the complete profile and limits and preserves per-path accounting", () => {
    const entry = (name: string, size: number): SourceManifestEntryV1 => ({
      path: `public/${name}.png`,
      kind: "media",
      size,
      sha256: "a".repeat(64),
      executable: false,
    });
    const files = Array.from({ length: 4 }, (_, index) =>
      entry(String(index), 32 * MiB),
    );
    const full256 = Array.from({ length: 8 }, (_, index) =>
      entry(`full-${index}`, 32 * MiB),
    );
    expect(
      createCapacityManifest("capacity-256-v1", full256).files,
    ).toHaveLength(8);
    expect(() =>
      createCapacityManifest("capacity-256-v1", [
        ...full256,
        entry("beyond", 1),
      ]),
    ).toThrow();
    expect(
      createCapacityManifest("capacity-64-v1", files.slice(0, 2)).files,
    ).toHaveLength(2);
    expect(() =>
      createCapacityManifest("capacity-64-v1", [
        ...files.slice(0, 2),
        entry("beyond", 1),
      ]),
    ).toThrow();
    expect(() => createCapacityManifest("capacity-64-v1", files)).toThrow();
    const a = createCapacityManifest("capacity-128-v1", files);
    const b = createCapacityManifest("capacity-256-v1", files);
    expect(a.manifestId).not.toBe(b.manifestId);
    expect(parseCapacityManifest(a)).toEqual(a);
    expect(() =>
      parseCapacityManifest({
        ...a,
        limits: { ...a.limits, mediaBytes: 256 * MiB },
      }),
    ).toThrow();
    expect(() =>
      createCapacityManifest("capacity-128-v1", [...files, entry("extra", 1)]),
    ).toThrow();
    expect(() =>
      createCapacityManifest("capacity-256-v1", [entry("large", 32 * MiB + 1)]),
    ).toThrow();
    expect(() =>
      createCapacityManifest("capacity-128-v1", [files[0]!, files[0]!]),
    ).toThrow();
    expect(() =>
      createCapacityManifest("capacity-128-v1", [
        { ...files[0]!, path: "../secret.png" },
      ]),
    ).toThrow();
  });
});

describe("first seed staging", () => {
  it("receives a full 65 MiB first seed in two exact windows and reports a lost ACK without replay", async () => {
    const sizes = [32 * MiB, 32 * MiB, MiB];
    const f = await fixture(sizes, "capacity-128-v1");
    const { windows } = await beginSeedTransaction(f.root, f.request);
    expect(windows).toEqual([
      ["public/0.png", "public/1.png"],
      ["public/2.png"],
    ]);
    await writeSeedWindow(
      f.root,
      f.scope,
      0,
      windows[0]!,
      pngStream(sizes.slice(0, 2)),
    );
    await expect(
      writeSeedWindow(
        f.root,
        f.scope,
        0,
        windows[0]!,
        pngStream(sizes.slice(0, 2)),
      ),
    ).rejects.toThrow();
    await writeSeedWindow(
      f.root,
      f.scope,
      1,
      windows[1]!,
      pngStream(sizes.slice(2)),
    );
    await commitSeedTransaction(f.root, f.scope); // caller loses this reply
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "committed",
      activeOrInterrupted: false,
      nextWindow: 2,
      windowCount: 2,
      manifestId: f.manifest.manifestId,
    });
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "committed",
      activeOrInterrupted: false,
    });
  });
  it("permits only one window writer for a transaction", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* paused() {
      yield signature;
      started();
      await gate;
      yield Buffer.alloc(8);
    }
    const first = writeSeedWindow(f.root, f.scope, 0, windows[0]!, paused());
    await ready;
    await expect(
      writeSeedWindow(f.root, f.scope, 0, windows[0]!, pngStream([16])),
    ).rejects.toThrow();
    release();
    await first;
    await expect(commitSeedTransaction(f.root, f.scope)).resolves.toMatchObject(
      { committed: true },
    );
  });
  it("commits an empty manifest without a media window", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "capacity-seed-empty-")),
    );
    roots.push(root);
    const manifest = createCapacityManifest("capacity-64-v1", []);
    const scope: SeedScope = {
      transactionId: randomBytes(16).toString("hex"),
      namespace: "test",
      projectId: "empty",
      operationId: randomBytes(16).toString("hex"),
      generation: 1,
      profile: "capacity-64-v1",
      manifestId: manifest.manifestId,
      baselineManifestId: manifest.manifestId,
    };
    expect(
      (await beginSeedTransaction(root, { scope, manifest, sources: [] }))
        .windows,
    ).toEqual([]);
    expect(await commitSeedTransaction(root, scope)).toMatchObject({
      committed: true,
    });
  });
  it("rejects noncanonical inline source data before creating a transaction", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "capacity-seed-base64-")),
    );
    roots.push(root);
    const bytes = Buffer.from([0]);
    const manifest = createCapacityManifest("capacity-64-v1", [
      {
        path: "main.js",
        kind: "source",
        size: 1,
        sha256: hash(bytes),
        executable: false,
      },
    ]);
    const scope: SeedScope = {
      transactionId: randomBytes(16).toString("hex"),
      namespace: "test",
      projectId: "base64",
      operationId: randomBytes(16).toString("hex"),
      generation: 1,
      profile: "capacity-64-v1",
      manifestId: manifest.manifestId,
      baselineManifestId: createCapacityManifest("capacity-64-v1", [])
        .manifestId,
    };
    await expect(
      beginSeedTransaction(root, {
        scope,
        manifest,
        sources: [{ path: "main.js", data: "AB==" }],
      }),
    ).rejects.toThrow();
    await expect(inspectSeedTransaction(root, scope)).rejects.toThrow();
  });
  it("does not commit when unknown staging data appears", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    await writeSeedWindow(f.root, f.scope, 0, windows[0]!, pngStream([16]));
    await writeFile(
      path.join(f.root, f.scope.transactionId, "unknown"),
      "untrusted",
    );
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: true,
    });
  });
  it("rejects omitted sources, scope drift and an incomplete commit without changing the transaction", async () => {
    const f = await fixture();
    await expect(
      beginSeedTransaction(f.root, { ...f.request, sources: [] }),
    ).rejects.toThrow();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    await expect(
      writeSeedWindow(
        f.root,
        { ...f.scope, operationId: "a".repeat(32) },
        0,
        windows[0]!,
        pngStream([16]),
      ),
    ).rejects.toThrow();
    await expect(
      writeSeedWindow(f.root, f.scope, 0, [], pngStream([16])),
    ).rejects.toThrow();
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: false,
      nextWindow: 0,
    });
  });
  it.each(["truncated", "wrong-hash", "trailing"] as const)(
    "retains failed %s window as interrupted, without a receipt",
    async (kind) => {
      const f = await fixture();
      const { windows } = await beginSeedTransaction(f.root, f.request);
      async function* bad() {
        const payload = Buffer.concat([
          signature,
          Buffer.alloc(kind === "truncated" ? 7 : 8),
        ]);
        if (kind === "wrong-hash") payload[payload.length - 1] = 1;
        yield payload;
        if (kind === "trailing") yield Buffer.from([1]);
      }
      await expect(
        writeSeedWindow(f.root, f.scope, 0, windows[0]!, bad()),
      ).rejects.toThrow();
      expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
        phase: "receiving",
        activeOrInterrupted: true,
        nextWindow: 0,
      });
      await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
    },
  );
  it("cancels even when the input stream is stalled and retains the single transaction", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    const abort = new AbortController();
    async function* stalled() {
      yield signature;
      await new Promise(() => {});
    }
    const writing = writeSeedWindow(
      f.root,
      f.scope,
      0,
      windows[0]!,
      stalled(),
      abort.signal,
    );
    setTimeout(() => abort.abort(new Error("cancelled")), 25);
    await expect(writing).rejects.toThrow("cancelled");
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: true,
      nextWindow: 0,
    });
  });
  it("reports an interrupted begin with no durable state as unknown", async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, f.scope.transactionId), { mode: 0o700 });
    expect(await inspectSeedTransaction(f.root, f.scope)).toEqual({
      phase: "unknown",
      activeOrInterrupted: true,
      nextWindow: null,
      windowCount: null,
      manifestId: null,
    });
    await expect(beginSeedTransaction(f.root, f.request)).rejects.toThrow();
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
  });
  it("rejects tampered staged bytes at commit", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    await writeSeedWindow(f.root, f.scope, 0, windows[0]!, pngStream([16]));
    await writeFile(
      path.join(f.root, f.scope.transactionId, "item-0001"),
      Buffer.alloc(16),
    );
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: true,
    });
  });
  it.runIf(process.platform !== "win32")(
    "rejects a staged FIFO without blocking on open",
    async () => {
      const f = await fixture();
      const { windows } = await beginSeedTransaction(f.root, f.request);
      await writeSeedWindow(f.root, f.scope, 0, windows[0]!, pngStream([16]));
      const target = path.join(f.root, f.scope.transactionId, "item-0001");
      await unlink(target);
      const created = spawnSync("mkfifo", [target], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);
      const script = path.join(f.root, "fifo-worker.mjs"),
        moduleUrl = pathToFileURL(
          path.resolve("src/daemon/isolated-capacity-seed.ts"),
        ).href;
      await writeFile(
        script,
        `import { commitSeedTransaction } from ${JSON.stringify(moduleUrl)};\ntry { await commitSeedTransaction(${JSON.stringify(f.root)}, ${JSON.stringify(f.scope)}); process.exit(1); } catch { process.exit(0); }\n`,
      );
      const child = spawnSync(process.execPath, ["--import", "tsx", script], {
        cwd: process.cwd(),
        timeout: 4000,
        encoding: "utf8",
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
        phase: "receiving",
        activeOrInterrupted: true,
      });
    },
  );
  it("rejects pathname replacement while verifying the staged open file", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    await writeSeedWindow(f.root, f.scope, 0, windows[0]!, pngStream([16]));
    const target = path.join(f.root, f.scope.transactionId, "item-0001"),
      saved = path.join(f.root, "old-item");
    const probe = await open(target, "r"),
      prototype = Object.getPrototypeOf(probe) as {
        createReadStream: (...args: unknown[]) => Readable;
      };
    await probe.close();
    const original = prototype.createReadStream;
    let streamCount = 0,
      replaced = false;
    prototype.createReadStream = function (...args: unknown[]) {
      const stream = original.apply(this, args);
      if (++streamCount !== 2) return stream;
      return Readable.from(
        (async function* () {
          for await (const chunk of stream) yield chunk;
          await rename(target, saved);
          await writeFile(target, Buffer.concat([signature, Buffer.alloc(8)]), {
            mode: 0o600,
          });
          replaced = true;
        })(),
      );
    };
    try {
      await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow(
        "staged file changed before commit",
      );
      expect(replaced).toBe(true);
    } finally {
      prototype.createReadStream = original;
    }
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: true,
    });
  });
  it("retains the original transaction if a process exits during a window", async () => {
    const f = await fixture();
    const { windows } = await beginSeedTransaction(f.root, f.request);
    const script = path.join(f.root, "worker.mjs"),
      moduleUrl = pathToFileURL(
        path.resolve("src/daemon/isolated-capacity-seed.ts"),
      ).href;
    await writeFile(
      script,
      `import { writeSeedWindow } from ${JSON.stringify(moduleUrl)};\nasync function* stream(){ yield Uint8Array.from(${JSON.stringify([...signature])}); process.exit(17); }\nawait writeSeedWindow(${JSON.stringify(f.root)}, ${JSON.stringify(f.scope)}, 0, ${JSON.stringify(windows[0])}, stream());\n`,
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      timeout: 15000,
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(17);
    expect(await inspectSeedTransaction(f.root, f.scope)).toMatchObject({
      phase: "receiving",
      activeOrInterrupted: true,
      nextWindow: 0,
    });
    await expect(commitSeedTransaction(f.root, f.scope)).rejects.toThrow();
  });
});
