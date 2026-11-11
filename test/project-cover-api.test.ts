import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { writePlayableFixtureWorkspace } from "./playable-fixture.js";
import { LOCAL_DEBUG_ACCESS_TOKEN } from "../src/shared/local-debug.js";
import { registerSensitiveValue } from "../src/shared/sensitive-values.js";

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const webp = (label: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(`WEBPVP8 ${label}`)]);

async function fixture(type = "web-game", localDebug = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-cover-api-"));
  directories.push(directory);
  const app = createApp({ dataDirectory: directory, localDebug });
  apps.push(app);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json();
  const url = `/projects/${project.id}/cover`;
  const put = (image: Buffer, source?: string) => app.inject({
    method: "PUT", url: `${url}${source ? `?source=${source}` : ""}`,
    headers: { "content-type": "image/webp" }, payload: image,
  });
  return { app, project, url, put, directory };
}

describe("project cover API", () => {
  it("blocks known credentials in cover and thumbnail writes and in bytes already stored on disk", async () => {
    const { app, project, url, put, directory } = await fixture("interactive-story");
    await writePlayableFixtureWorkspace(project.workspacePath);
    const canary = "CANARY_COVER_THUMBNAIL_BINARY_KEY_ONLY"; registerSensitiveValue(canary);
    const protectedImage = webp(canary);
    const coverWrite = await put(protectedImage);
    expect(coverWrite.statusCode).toBe(403); expect(coverWrite.body).not.toContain(canary);
    expect((await app.inject({ url })).statusCode).toBe(404);
    const thumbnailUrl = `/projects/${project.id}/playable/thumbnails/menu`;
    const thumbnailWrite = await app.inject({ method: "PUT", url: `${thumbnailUrl}?hash=0123abcd`, headers: { "content-type": "image/webp" }, payload: protectedImage });
    expect(thumbnailWrite.statusCode).toBe(403); expect(thumbnailWrite.body).not.toContain(canary);
    expect((await app.inject({ url: thumbnailUrl })).statusCode).toBe(404);
    await expect(readFile(path.join(directory, "projects", project.id, "cover.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.join(project.workspacePath, ".ohmygame", "thumbnails"), { recursive: true });
    await writeFile(path.join(project.workspacePath, ".ohmygame", "thumbnails", "menu.webp"), protectedImage);
    const existingThumbnail = await app.inject({ url: thumbnailUrl });
    expect(existingThumbnail.statusCode).toBe(403); expect(existingThumbnail.body).not.toContain(canary);
    await put(webp("safe cover"));
    const projectDirectory = path.join(directory, "projects", project.id);
    await writeFile(path.join(projectDirectory, "cover.webp"), protectedImage);
    const existingCover = await app.inject({ url });
    expect(existingCover.statusCode).toBe(403); expect(existingCover.body).not.toContain(canary);
  });
  it("toggles automatic replacement without uploading a custom cover", async () => {
    const { app, url, put } = await fixture();
    const mode = (value: string) => app.inject({ method: "PUT", url: `${url}/state`, payload: { mode: value } });
    await put(webp("automatic"), "auto");
    expect((await mode("custom")).statusCode).toBe(204);
    await put(webp("late capture"), "auto");
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("automatic"));
    expect((await app.inject({ method: "GET", url: `${url}/state` })).json()).toEqual({ mode: "custom" });
    expect((await mode("auto")).statusCode).toBe(204);
    await put(webp("new capture"), "auto");
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("new capture"));
    expect((await mode("unknown")).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `${url}/state`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/projects/missing/cover/state", payload: { mode: "custom" } })).statusCode).toBe(404);
  });

  it.each([false, true])("freezes the Interactive Story cover with an existing thumbnail: %s", async (existing) => {
    const { app, project, url } = await fixture("interactive-story");
    await writePlayableFixtureWorkspace(project.workspacePath);
    const thumbnail = (label: string) => app.inject({
      method: "PUT", url: `/projects/${project.id}/playable/thumbnails/menu?hash=0123abcd0123ab`,
      headers: { "content-type": "image/webp" }, payload: webp(label),
    });
    if (existing) await thumbnail("scene");
    expect((await app.inject({ method: "PUT", url: `${url}/state`, payload: { mode: "custom" } })).statusCode).toBe(204);
    await thumbnail("updated scene");
    // Retrying the same preference must not populate a cover that was frozen empty.
    expect((await app.inject({ method: "PUT", url: `${url}/state`, payload: { mode: "custom" } })).statusCode).toBe(204);
    const frozen = await app.inject({ method: "GET", url });
    if (existing) expect(frozen.rawPayload).toEqual(webp("scene"));
    else expect(frozen.statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `${url}/state`, payload: { mode: "auto" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("updated scene"));
  });

  it("saves custom covers independently of publishing and resumes automatic covers on reset", async () => {
    const { app, url, put } = await fixture();
    expect((await app.inject({ method: "GET", url: `${url}/state` })).json()).toEqual({ mode: "auto" });
    expect((await put(webp("automatic"), "auto")).statusCode).toBe(204);
    expect((await put(webp("custom"))).statusCode).toBe(204);
    expect((await put(webp("late capture"), "auto")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    expect((await app.inject({ method: "GET", url: `${url}/state` })).json()).toEqual({ mode: "custom" });
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("automatic"));
    expect((await put(webp("new capture"), "auto")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("new capture"));
    expect((await put(webp("invalid source"), "unknown")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/projects/missing/cover/state" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/projects/missing/cover" })).statusCode).toBe(404);
  });

  it("retains an uploaded cover while automatic mode is enabled and restores it when disabled", async () => {
    const { app, url, put } = await fixture();
    const mode = (value: string) => app.inject({ method: "PUT", url: `${url}/state`, payload: { mode: value } });
    await put(webp("automatic"), "auto");
    await put(webp("uploaded"));
    expect((await mode("auto")).statusCode).toBe(204);
    await put(webp("new capture"), "auto");
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("new capture"));
    expect((await mode("custom")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("uploaded"));
    await put(webp("late capture"), "auto");
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("uploaded"));
  });

  it("restores the Interactive Story thumbnail fallback without stopping node thumbnail updates", async () => {
    const { app, project, url, put } = await fixture("interactive-story");
    await writePlayableFixtureWorkspace(project.workspacePath);
    const thumbnailUrl = `/projects/${project.id}/playable/thumbnails/menu?hash=0123abcd0123ab`;
    const thumbnail = (label: string) => app.inject({ method: "PUT", url: thumbnailUrl, headers: { "content-type": "image/webp" }, payload: webp(label) });
    expect((await thumbnail("scene")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("scene"));
    await put(webp("custom"));
    expect((await thumbnail("updated scene")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    await app.inject({ method: "DELETE", url });
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("updated scene"));
  });

  it("keeps local covers editable while author publishing and Community remain unavailable without requests", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    try {
    const { app, project, url, put } = await fixture("web-game", true);
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    await put(webp("automatic"), "auto");
    const publish = () => app.inject({ method: "POST", url: `/projects/${project.id}/publish`, payload: { accessToken: LOCAL_DEBUG_ACCESS_TOKEN, title: "Game" } });
    expect((await publish()).statusCode).toBe(410);
    const coverUrl = "/community/games/retired-game/deployments/retired-deployment/cover";
    await put(webp("custom"));
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    expect((await app.inject({ method: "GET", url: coverUrl })).statusCode).toBe(410);
    expect((await publish()).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url })).rawPayload).toEqual(webp("custom"));
    expect(outbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); }
  });
});
