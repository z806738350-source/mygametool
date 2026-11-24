import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentRuntime from "../src/daemon/agent.js";
import { createApp } from "../src/daemon/app.js";
import { LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import type { ConversationCapabilities, ConversationDetail, ProjectState, ProjectType } from "../src/shared/contracts.js";
import { INK_STUDIO_PLUGIN_ID } from "../src/shared/plugins.js";

const applications = new Set<ReturnType<typeof createApp>>();
const directories: string[] = [];
const globalSettings = `/plugins/${encodeURIComponent(INK_STUDIO_PLUGIN_ID)}/settings`;
const activation = (project: ProjectState) => `/projects/${project.id}/settings/ink-studio`;
const mention = { name: "ink-studio", displayName: "Ink Studio", marketplaceId: "ohmygame" };
const model = { provider: "kunpo", id: "gpt-6.2-astra" };

afterEach(async () => {
  await Promise.all([...applications].map(app => app.close()));
  applications.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-ink-app-"));
  directories.push(directory);
  return directory;
}

async function start(directory: string) {
  const app = createApp({
    dataDirectory: directory,
    piAgentDirectory: directory,
    generateProjectName: async () => undefined,
  });
  applications.add(app);
  await app.ready();
  const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload });
  const global = (enabled: boolean) => inject("PUT", globalSettings, { enabled, components: {} });
  return { app, inject, global };
}

type Inject = Awaited<ReturnType<typeof start>>["inject"];

async function createConversation(inject: Inject, project: ProjectState) {
  const base = `/projects/${project.id}/conversations`;
  const response = await inject("POST", base, { model });
  expect(response.statusCode, response.body).toBe(201);
  return `${base}/${response.json().id}`;
}

async function capabilities(inject: Inject, conversation: string) {
  const response = await inject("GET", `${conversation}/capabilities`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ConversationCapabilities>().plugins.map(plugin => plugin.id);
}

async function createProject(inject: Inject, name: string, type: ProjectType) {
  const response = await inject("POST", "/projects", { type, name });
  expect(response.statusCode, response.body).toBe(201);
  const project = response.json<ProjectState>();
  return { project, conversation: await createConversation(inject, project) };
}

describe("Ink Studio activation", () => {
  it("keeps activation per Web Game, persists it across reopen, and masks it when the application switch is off", async () => {
    const directory = await temporary();
    const { app, inject, global } = await start(directory);
    const first = await createProject(inject, "First game", "web-game");
    const second = await createProject(inject, "Second game", "web-game");
    const other = await createProject(inject, "General game", "general");

    expect(await capabilities(inject, first.conversation)).not.toContain(INK_STUDIO_PLUGIN_ID);
    const blocked = await inject("PUT", activation(first.project), { enabled: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("Enable Ink Studio");

    expect((await global(true)).statusCode).toBe(200);
    // Discovery also works in compatible projects that have yet to opt in.
    expect(await capabilities(inject, first.conversation)).toContain(INK_STUDIO_PLUGIN_ID);
    expect(await capabilities(inject, second.conversation)).toContain(INK_STUDIO_PLUGIN_ID);
    expect(await capabilities(inject, other.conversation)).not.toContain(INK_STUDIO_PLUGIN_ID);
    const incompatible = await inject("PUT", activation(other.project), { enabled: true });
    expect(incompatible.statusCode).toBe(400);
    expect(incompatible.json().error).toContain("Web Game");
    const enabled = await inject("PUT", activation(first.project), { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json<ProjectState>().inkStudioEnabled).toBe(true);

    expect((await global(false)).statusCode).toBe(200);
    expect(await capabilities(inject, first.conversation)).not.toContain(INK_STUDIO_PLUGIN_ID);
    await app.close();
    applications.delete(app);

    const reopened = await start(directory);
    const stored = (await reopened.inject("GET", "/projects")).json<ProjectState[]>();
    expect(stored.find(project => project.id === first.project.id)?.inkStudioEnabled).toBe(true);
    expect(stored.find(project => project.id === second.project.id)?.inkStudioEnabled).not.toBe(true);
    expect(stored.find(project => project.id === other.project.id)?.inkStudioEnabled).not.toBe(true);
    expect((await reopened.inject("PUT", activation(second.project), { enabled: true })).statusCode).toBe(409);
    expect((await reopened.global(true)).statusCode).toBe(200);
    expect(await capabilities(reopened.inject, await createConversation(reopened.inject, first.project)))
      .toContain(INK_STUDIO_PLUGIN_ID);
  }, 8000);

  it("activates a structured mention, registers the bundled tools, and refuses stale tools after opt-out", async () => {
    const directory = await temporary();
    const network = vi.fn(async () => { throw new Error("Unexpected network request in the Ink Studio test"); });
    vi.stubGlobal("fetch", network);
    await new LocalApiKeyStore(path.join(directory, "local-api-keys.json"))
      .replace({ kunpo: { type: "api_key", key: "sk-synthetic-ink-integration-canary" } });
    const prompt = vi.fn<agentRuntime.CodingSession["prompt"]>(async () => {});
    const session = vi.spyOn(agentRuntime, "createPiSession").mockImplementation(async (_project, _history, tools = []) => ({
      messages: [], prompt, abort: async () => {}, dispose: () => {}, subscribe: () => () => {}, getAllTools: () => tools,
    }));
    const { inject, global } = await start(directory);
    const { project, conversation } = await createProject(inject, "Mention test", "web-game");
    const turn = (payload: object) => inject("POST", `${conversation}/turns`, payload);
    const readProject = () => inject("GET", `/projects/${project.id}`).then(response => response.json<ProjectState>());
    const settled = async (count: number) => {
      await vi.waitFor(async () => {
        expect(prompt).toHaveBeenCalledTimes(count);
        const detail = (await inject("GET", conversation)).json<ConversationDetail>();
        expect(detail.agent.status).toBe("idle");
      });
    };

    expect((await turn({ prompt: "Use @Ink Studio", mentions: [mention] })).statusCode).toBe(400);
    expect((await global(true)).statusCode).toBe(200);
    expect((await turn({ prompt: "Use an Ink Studio guide", mentions: [mention] })).statusCode).toBe(400);
    expect((await turn({ prompt: "Mention @Ink Studio in plain text" })).statusCode).toBe(202);
    await settled(1);
    expect((await readProject()).inkStudioEnabled).not.toBe(true);
    expect(prompt).toHaveBeenNthCalledWith(1, "Mention @Ink Studio in plain text");
    const before = session.mock.calls[0]![2]!;
    expect(before.map(tool => tool.name)).not.toContain("ensure_ink_runtime");
    expect(JSON.stringify(before.find(tool => tool.name === "read_workflow_guide")?.parameters)).not.toContain('"ink-studio"');

    expect((await turn({ prompt: "Use @Ink Studio", mentions: [mention] })).statusCode).toBe(202);
    await settled(2);
    expect((await readProject()).inkStudioEnabled).toBe(true);
    expect(prompt).toHaveBeenNthCalledWith(2, "Use [@Ink Studio](plugin://ink-studio@ohmygame)");
    const active = session.mock.calls[1]![2]!;
    const guide = active.find(tool => tool.name === "read_workflow_guide")!;
    const runtime = active.find(tool => tool.name === "ensure_ink_runtime")!;
    expect(JSON.stringify(guide.parameters)).toContain('"ink-studio"');
    await expect(guide.execute("read-ink", { guide: "ink-studio" }, undefined, undefined, {} as never))
      .resolves.toMatchObject({ details: { guide: "ink-studio", source: "skills/ink-studio/SKILL.md" } });
    const published = await runtime.execute("install-ink", {}, undefined, undefined, {} as never);
    expect(published.details).toMatchObject({ inkRuntime: { status: "created" } });

    expect((await inject("PUT", activation(project), { enabled: false })).statusCode).toBe(200);
    await expect(guide.execute("stale-guide", { guide: "ink-studio" }, undefined, undefined, {} as never))
      .rejects.toThrow("unavailable for the project");
    await expect(runtime.execute("stale-install", {}, undefined, undefined, {} as never))
      .rejects.toThrow("disabled for this project");
    const { toolkitPath } = (published.details as { inkRuntime: { toolkitPath: string } }).inkRuntime;
    expect((await lstat(path.join(project.workspacePath, toolkitPath))).isFile()).toBe(true);

    expect((await turn({ prompt: "Check this project after opt-out" })).statusCode).toBe(202);
    await settled(3);
    const after = session.mock.calls[2]![2]!;
    expect(after.map(tool => tool.name)).not.toContain("ensure_ink_runtime");
    expect(JSON.stringify(after.find(tool => tool.name === "read_workflow_guide")?.parameters)).not.toContain('"ink-studio"');
    expect(network).not.toHaveBeenCalled();
  }, 8000);
});
