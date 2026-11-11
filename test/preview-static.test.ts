import { mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startStaticPreview } from "../src/daemon/preview-static.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";
import { MAX_SAFE_PROJECT_FILE_BYTES } from "../src/daemon/safe-project-file.js";
import { mediaPreviewReadLimit, mediaSnapshotResponse } from "../src/daemon/media-snapshot-response.js";
import { CheckedMediaSnapshotStore, type CheckedMediaSnapshot } from "../src/daemon/checked-media-snapshot.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "ohmygame-static-preview-"));
  cleanups.push(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function preview(root: string): Promise<string> {
  const server = await startStaticPreview(root, 0);
  cleanups.push(() => server.close());
  return server.url;
}

describe("static preview directory URLs", () => {
  it("rejects known secrets before GET, HEAD or ranges can expose any script or binary bytes", async () => {
    const root = await directory();
    const secret = "static-preview-fake-key-cross-chunk-canary-20261028";
    registerSensitiveValue(secret);
    const bytes = Buffer.concat([Buffer.alloc(64 * 1024 - 8, 0), Buffer.from(secret), Buffer.from([0xff, 1, 2])]);
    for (const name of ["game.js", "gold-key.png"]) await writeFile(path.join(root, name), bytes);
    const url = await preview(root);
    for (const name of ["game.js", "gold-key.png"]) {
      for (const init of [{}, { headers: { range: "bytes=0-3" } }, { method: "HEAD" }]) {
        const response = await fetch(`${url}/${name}`, init);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(secret);
      }
    }
  });

  it("keeps ordinary files within 64 MiB before returning even a small range", async () => {
    const root = await directory();
    const file = path.join(root, "large.bin");
    await writeFile(file, "");
    await truncate(file, MAX_SAFE_PROJECT_FILE_BYTES + 1);
    const response = await fetch(`${await preview(root)}/large.bin`, { headers: { range: "bytes=0-3" } });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("secure inspection limit");
  });

  it("rejects visible aliases of hidden files and dependency directories inside the workspace", async () => {
    const root = await directory();
    await writeFile(path.join(root, ".env"), "private-test-value");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "index.html"), "private dependency");
    if (process.platform !== "win32") await symlink(path.join(root, ".env"), path.join(root, "public.txt"));
    await symlink(path.join(root, "node_modules"), path.join(root, "dependencies"), process.platform === "win32" ? "junction" : "dir");
    const url = await preview(root);
    for (const entry of [...(process.platform === "win32" ? [] : ["public.txt"]), "dependencies/index.html"]) expect((await fetch(`${url}/${entry}`)).status).toBe(403);
  });

  it("rejects rebinding hosts and sends a local-only resource policy", async () => {
    const root = await directory();
    await writeFile(path.join(root, "index.html"), "<script>start()</script>");
    const url = await preview(root);
    // Node's fetch may replace Host. Send the actual hostile wire header.
    const hostile = await new Promise<number | undefined>((resolve, reject) => {
      const incoming = request(url, { headers: { host: "rebind.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      incoming.once("error", reject);
      incoming.end();
    });
    expect(hostile).toBe(403);
    expect((await fetch(url, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
    const response = await fetch(url);
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
    expect(response.headers.get("content-security-policy")).toContain(`connect-src 'self' blob: ${new URL(url).origin.replace("http:", "ws:")};`);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
  });
  it.each(["GET", "HEAD"])(
    "redirects %s to a trailing slash while preserving escaped paths and queries",
    async (method) => {
      const root = await directory();
      const nested = path.join(root, "level one");
      await mkdir(nested);
      const html = '<script type="module" src="./game.js"></script>';
      await writeFile(path.join(nested, "index.html"), html);
      await writeFile(
        path.join(nested, "game.js"),
        "export const ready = true;",
      );
      const url = `${await preview(root)}/level%20one?level=2&label=a%2Fb`;

      const redirect = await fetch(url, { method, redirect: "manual" });
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get("location")).toBe(
        "/level%20one/?level=2&label=a%2Fb",
      );
      expect(redirect.headers.get("cache-control")).toBe("no-store");
      expect(await redirect.text()).toBe("");

      const response = await fetch(url, { method });
      expect(response.status).toBe(200);
      const resolvedUrl = new URL(response.url);
      expect(resolvedUrl.pathname).toBe("/level%20one/");
      expect(resolvedUrl.search).toBe("?level=2&label=a%2Fb");
      expect(await response.text()).toBe(method === "HEAD" ? "" : html);
      const script = await fetch(new URL("./game.js", resolvedUrl));
      expect(script.status).toBe(200);
      expect(await script.text()).toBe("export const ready = true;");
    },
  );

  it.each(["GET", "HEAD"])(
    "checks %s paths and resolved indexes before redirecting",
    async (method) => {
      const root = await directory();
      const outside = await directory();
      await writeFile(path.join(outside, "index.html"), "outside");
      await symlink(
        outside,
        path.join(root, "external"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const indexed = path.join(root, "index-escape");
      await mkdir(indexed);
      // Windows junctions exercise index containment without symlink privileges.
      await symlink(
        process.platform === "win32"
          ? outside
          : path.join(outside, "index.html"),
        path.join(indexed, "index.html"),
        process.platform === "win32" ? "junction" : "file",
      );
      for (const name of [".private", "node_modules"]) {
        await mkdir(path.join(root, name));
        await writeFile(path.join(root, name, "index.html"), "blocked");
      }
      const url = await preview(root);

      for (const name of [
        ".private",
        "node_modules",
        "external",
        "index-escape",
      ]) {
        const response = await fetch(`${url}/${name}`, {
          method,
          redirect: "manual",
        });
        expect(response.status).toBe(403);
        expect(response.headers.has("location")).toBe(false);
        await response.text();
      }
    },
  );

  it.each(["GET", "HEAD"])(
    "returns 404 for %s directories without an index before redirecting",
    async (method) => {
      const root = await directory();
      await writeFile(path.join(root, "index.html"), "home");
      await mkdir(path.join(root, "empty"));
      const url = await preview(root);

      const response = await fetch(`${url}/empty?level=2`, {
        method,
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      expect(response.headers.has("location")).toBe(false);
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : "Preview file not found.",
      );
    },
  );

  it.each(["GET", "HEAD"])(
    "serves %s files, canonical directories and application routes without redirects",
    async (method) => {
      const root = await directory();
      await writeFile(path.join(root, "index.html"), "home");
      await mkdir(path.join(root, "levels"));
      await writeFile(path.join(root, "levels", "index.html"), "home");
      const url = await preview(root);

      for (const pathname of [
        "/",
        "/index.html",
        "/levels/",
        "/levels/index.html",
        "/play?level=2",
      ]) {
        const response = await fetch(`${url}${pathname}`, {
          method,
          headers: { accept: "text/html" },
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        expect(response.headers.has("location")).toBe(false);
        expect(await response.text()).toBe(method === "HEAD" ? "" : "home");
      }
    },
  );
});

describe("static preview byte ranges", () => {
  it.each([
    ["0123456789", "bytes=2-5"],
    ["0123456789", "bytes=10-"],
    ["", "bytes=0-"],
  ])("ignores Range on HEAD for %j with %s", async (contents, range) => {
    const root = await directory();
    await writeFile(path.join(root, "clip.mp4"), contents);
    const url = `${await preview(root)}/clip.mp4`;

    const response = await fetch(url, { method: "HEAD", headers: { range } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(contents)),
    );
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.has("content-range")).toBe(false);
    expect(await response.text()).toBe("");
  });

  it("answers byte ranges, so media can seek", async () => {
    const root = await directory();
    await writeFile(path.join(root, "clip.mp4"), "0123456789");
    const url = `${await preview(root)}/clip.mp4`;

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-length")).toBe("10");
    expect(await whole.text()).toBe("0123456789");

    const middle = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(middle.headers.get("content-type")).toBe("video/mp4");
    expect(await middle.text()).toBe("2345");

    const open = await fetch(url, { headers: { range: "bytes=7-" } });
    expect(await open.text()).toBe("789");
    const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
    const clamped = await fetch(url, { headers: { range: "bytes=8-99" } });
    expect(await clamped.text()).toBe("89");

    const outside = await fetch(url, { headers: { range: "bytes=10-" } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */10");
    // Several ranges at once are not needed by media; the whole file answers them.
    const several = await fetch(url, { headers: { range: "bytes=0-1,4-5" } });
    expect(several.status).toBe(200);
    expect(await several.text()).toBe("0123456789");
  });
});

function checkedFixture(contents = "0123456789") {
  const bytes = Buffer.from(contents);
  const snapshot = {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    scannerRevision: 0,
    assertCurrentPolicy: vi.fn(),
    stream: vi.fn((range?: { start: number; end: number }) => Readable.from(range ? bytes.subarray(range.start, range.end + 1) : bytes)),
    release: vi.fn(async () => {}),
  };
  return snapshot;
}

const responseOptions = { method: "GET", contentType: "video/mp4", cacheControl: "no-store" };
async function responseText(body?: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  if (body) for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("checked media response contract", () => {
  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-99", "0123456789", "bytes 0-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
  ])("serves inclusive checked %s", async (range, expected, contentRange) => {
    const snapshot = checkedFixture();
    const response = mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, range });
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe(contentRange);
    expect(response.headers["content-length"]).toBe(String(expected.length));
    expect(response.headers.etag).toBe(`"${snapshot.sha256}"`);
    expect(await responseText(response.body)).toBe(expected);
    expect(snapshot.assertCurrentPolicy).toHaveBeenCalledOnce();
  });

  it.each(["bytes=0-1,4-5", "bytes=-", "items=0-2", "bytes=1.5-3", "bytes=9007199254740992-", "bytes=0-9007199254740992", "bytes=-9007199254740992"])(
    "preserves full 200 for invalid or unsupported %s", async range => {
      const snapshot = checkedFixture();
      const response = mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, range });
      expect(response.status).toBe(200);
      expect(response.headers["content-range"]).toBeUndefined();
      expect(await responseText(response.body)).toBe("0123456789");
    },
  );

  it.each(["bytes=10-", "bytes=8-7", "bytes=-0"])("leaves unsatisfiable %s bodyless for caller release", range => {
    const snapshot = checkedFixture();
    const response = mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, range });
    expect(response).toMatchObject({ status: 416, headers: { "content-range": "bytes */10", "content-length": "0" } });
    expect(response.body).toBeUndefined();
    expect(snapshot.stream).not.toHaveBeenCalled();
  });

  it("handles empty files and HEAD without opening a body", async () => {
    const empty = checkedFixture("");
    expect(mediaSnapshotResponse(empty as unknown as CheckedMediaSnapshot, { ...responseOptions, range: "bytes=0-" })).toMatchObject({ status: 416, headers: { "content-range": "bytes */0" } });
    const snapshot = checkedFixture();
    const response = mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, method: "HEAD", range: "bytes=999-" });
    expect(response).toMatchObject({ status: 200, headers: { "content-length": "10", "cache-control": "no-store" } });
    expect(response.body).toBeUndefined(); expect(snapshot.stream).not.toHaveBeenCalled();
    expect(snapshot.assertCurrentPolicy).toHaveBeenCalledOnce();
    expect(await responseText(mediaSnapshotResponse(empty as unknown as CheckedMediaSnapshot, responseOptions).body)).toBe("");
  });

  it("honors only a matching strong If-Range validator", async () => {
    const snapshot = checkedFixture();
    for (const ifRange of [`"${snapshot.sha256}"`, `W/"${snapshot.sha256}"`, '"another-snapshot"', "Wed, 01 Jan 2020 00:00:00 GMT", ""]) {
      const response = mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, range: "bytes=2-5", ifRange });
      const matches = ifRange === `"${snapshot.sha256}"`;
      expect(response.status).toBe(matches ? 206 : 200);
      expect(await responseText(response.body)).toBe(matches ? "2345" : "0123456789");
    }
  });

  it("checks the current scanner policy before creating any headers or stream", () => {
    const snapshot = checkedFixture();
    snapshot.assertCurrentPolicy.mockImplementation(() => { throw new Error("scanner policy changed"); });
    for (const method of ["GET", "HEAD"]) expect(() => mediaSnapshotResponse(snapshot as unknown as CheckedMediaSnapshot, { ...responseOptions, method })).toThrow("scanner policy changed");
    expect(snapshot.stream).not.toHaveBeenCalled();
  });

  it("keeps display budgets typed and separate from isolated runtime limits", () => {
    for (const type of ["video/mp4", "video/webm"]) expect(mediaPreviewReadLimit(type)).toBe(256 * 1024 * 1024);
    for (const type of ["audio/wav", "audio/mpeg", "audio/ogg"]) expect(mediaPreviewReadLimit(type)).toBe(200 * 1024 * 1024);
    expect(mediaPreviewReadLimit("model/gltf-binary")).toBe(100 * 1024 * 1024);
    for (const type of ["video/quicktime", "audio/mp4", "application/octet-stream", "text/javascript"]) expect(mediaPreviewReadLimit(type)).toBe(MAX_SAFE_PROJECT_FILE_BYTES);
  });
});

describe("static checked snapshot lifecycle", () => {
  it("serves a display-only MP4 above 64 MiB through a checked small range", async () => {
    const root = await directory(), file = path.join(root, "opening.mp4");
    const header = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    await writeFile(file, header); await truncate(file, 65 * 1024 * 1024);
    const response = await fetch(`${await preview(root)}/opening.mp4`, { headers: { range: "bytes=0-11" } });
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(`bytes 0-11/${65 * 1024 * 1024}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(header);
    // This is an I/O contract fixture, not a playable codec or GPU acceptance sample.
  });

  it.each([["video.webm", 256], ["music.wav", 200], ["model.glb", 100]])("refuses %s beyond its display budget before a small range", async (name, mib) => {
    const root = await directory(), file = path.join(root, String(name));
    await writeFile(file, ""); await truncate(file, Number(mib) * 1024 * 1024 + 1);
    const response = await fetch(`${await preview(root)}/${name}`, { headers: { range: "bytes=0-3" } });
    expect(response.status).toBe(413); expect(await response.text()).not.toContain("\u0000");
  });

  it("serves the sealed bytes when the original pathname changes after acquisition", async () => {
    const root = await directory(), cache = await directory(), file = path.join(root, "clip.mp4");
    await writeFile(file, "checked-original");
    const store = new CheckedMediaSnapshotStore(cache); cleanups.push(() => store.close());
    const acquire = store.acquire.bind(store); let replaced = false;
    vi.spyOn(store, "acquire").mockImplementation(async (...args) => {
      const snapshot = await acquire(...args);
      if (!replaced) { replaced = true; await rename(file, `${file}.retained`); await writeFile(file, "replacement-bytes"); }
      return snapshot;
    });
    const server = await startStaticPreview(root, 0, { mediaSnapshots: store }); cleanups.push(() => server.close());
    expect(await (await fetch(`${server.url}/clip.mp4`, { headers: { range: "bytes=0-6" } })).text()).toBe("checked");
    expect(await (await fetch(`${server.url}/clip.mp4`)).text()).toBe("replacement-bytes");
  });

  it("evicts only its own scope and never closes an injected shared store", async () => {
    const root = await directory(), cache = await directory(); await writeFile(path.join(root, "index.html"), "shared");
    const store = new CheckedMediaSnapshotStore(cache); cleanups.push(() => store.close());
    const closed = vi.spyOn(store, "close"), evicted = vi.spyOn(store, "evictScope");
    const first = await startStaticPreview(root, 0, { mediaSnapshots: store }), second = await startStaticPreview(root, 0, { mediaSnapshots: store });
    cleanups.push(() => first.close(), () => second.close());
    expect(await (await fetch(first.url)).text()).toBe("shared"); expect(await (await fetch(second.url)).text()).toBe("shared");
    await first.close(); expect(closed).not.toHaveBeenCalled(); expect(evicted).toHaveBeenCalledOnce();
    expect(await (await fetch(second.url)).text()).toBe("shared");
    await second.close(); expect(closed).not.toHaveBeenCalled(); expect(evicted).toHaveBeenCalledTimes(2);
    expect(evicted.mock.calls[0]![0]).not.toBe(evicted.mock.calls[1]![0]);
  });

  it("releases HEAD and 416 leases without creating body streams", async () => {
    const root = await directory(); await writeFile(path.join(root, "clip.mp4"), "0123456789");
    const leases: ReturnType<typeof checkedFixture>[] = [];
    const store = { acquire: vi.fn(async () => { const lease = checkedFixture(); leases.push(lease); return lease; }), evictScope: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const server = await startStaticPreview(root, 0, { mediaSnapshots: store as unknown as CheckedMediaSnapshotStore }); cleanups.push(() => server.close());
    expect((await fetch(`${server.url}/clip.mp4`, { method: "HEAD", headers: { range: "bytes=2-5" } })).status).toBe(200);
    expect((await fetch(`${server.url}/clip.mp4`, { headers: { range: "bytes=99-" } })).status).toBe(416);
    expect(leases).toHaveLength(2);
    for (const lease of leases) { expect(lease.release).toHaveBeenCalledOnce(); expect(lease.stream).not.toHaveBeenCalled(); }
  });

  it("destroys a GET body and releases its lease when a client cancels", async () => {
    const root = await directory(); await writeFile(path.join(root, "clip.mp4"), "stream-source");
    let released!: () => void; const releaseDone = new Promise<void>(resolve => { released = resolve; });
    const body = new PassThrough(), release = vi.fn(async () => { released(); }); body.once("close", () => { void release(); });
    const lease = { ...checkedFixture(), size: 1_000_000, stream: vi.fn(() => { queueMicrotask(() => body.write("first")); return body; }), release };
    const store = { acquire: vi.fn(async () => lease), evictScope: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const server = await startStaticPreview(root, 0, { mediaSnapshots: store as unknown as CheckedMediaSnapshotStore }); cleanups.push(() => server.close());
    const response = await fetch(`${server.url}/clip.mp4`); await response.body!.cancel(); await releaseDone;
    expect(body.destroyed).toBe(true); expect(release).toHaveBeenCalledOnce();
    await server.close(); expect(store.close).not.toHaveBeenCalled();
  });
});
