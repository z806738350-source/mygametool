import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlayableDraftServer } from "../src/daemon/playable-draft-server.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { LoopbackFileServer } from "../src/daemon/loopback-file-server.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";

const project = { id: "project-1" } as ProjectState;
let server: PlayableDraftServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function draftDirectory(root: string, index: number): Promise<string> {
  const directory = path.join(root, `draft-${index}`);
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), `<p>Draft ${index}</p>`);
  await writeFile(path.join(directory, "assets", "player.js"), "export {};");
  return directory;
}

describe("Playable draft server", () => {
  it("does not serve known credentials embedded in token-mounted scripts or binary resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-loopback-content-"));
    const files = new LoopbackFileServer();
    try {
      const secret = "loopback-file-fake-key-canary-20261028";
      registerSensitiveValue(secret);
      const bytes = Buffer.concat([Buffer.from([0, 0xff]), Buffer.from(secret), Buffer.from([1, 2])]);
      for (const name of ["game.js", "auth-icon.svg"]) await writeFile(path.join(root, name), bytes);
      const mounted = await files.mount(root);
      for (const name of ["game.js", "auth-icon.svg"]) {
        const response = await fetch(`${mounted.url}${name}`);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(secret);
      }
      const safe = Buffer.from([0, 0xff, 1, 2, 3]);
      await writeFile(path.join(root, "safe.png"), safe);
      const response = await fetch(`${mounted.url}safe.png`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(safe);
    } finally { await files.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("serves a draft under its token path only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-draft-"));
    server = new PlayableDraftServer(() => draftDirectory(root, 1));
    const url = await server.open(project);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/index\.html$/);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<p>Draft 1</p>");
    expect((await fetch(url.replace("index.html", "assets/player.js"))).headers.get("content-type")).toContain("text/javascript");

    const origin = new URL(url).origin;
    expect((await fetch(`${origin}/wrong-token/index.html`)).status).toBe(404);
    expect((await fetch(url.replace("index.html", "missing.html"))).status).toBe(404);
    expect((await fetch(url.replace("index.html", "..%2F..%2Fetc%2Fpasswd"))).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("removes the oldest drafts and every draft on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-draft-"));
    let index = 0;
    server = new PlayableDraftServer(() => draftDirectory(root, ++index));
    const urls = [];
    for (let count = 0; count < 5; count += 1) urls.push(await server.open(project));

    expect((await fetch(urls[0]!)).status).toBe(404);
    expect((await fetch(urls[4]!)).status).toBe(200);
    expect((await readdir(root)).sort()).toEqual(["draft-2", "draft-3", "draft-4", "draft-5"]);

    await server.close();
    server = undefined;
    expect(await readdir(root)).toEqual([]);
  });
});
