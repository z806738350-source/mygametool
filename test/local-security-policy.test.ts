import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AgentManager } from "../src/daemon/agent.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { PreviewManager } from "../src/daemon/preview.js";
import { ToolRunner } from "../src/daemon/tools.js";
import type { IsolatedProjectExecution } from "../src/daemon/isolated-project-execution.js";
import { localAgentPath } from "../src/daemon/agent-local-files.js";
import { isPrivateCredentialName, isPrivateProjectPath } from "../src/shared/private-project-paths.js";

const apps: ReturnType<typeof createApp>[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function localApp() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-secure-policy-"));
  directories.push(dataDirectory);
  const app = createApp({ dataDirectory, cloudApiUrl: "https://author.invalid", publishApiUrl: "https://author.invalid", localDebug: true });
  apps.push(app);
  return app;
}

describe("local secure edition integration boundaries", () => {
  it("allows ordinary project help for a saved external engine binding without running its plugin", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-bound-chat-"));
    directories.push(dataDirectory);
    const projects = new ProjectManager(dataDirectory);
    const project = await projects.create("Bound game", "general");
    await projects.setIntegration(project.id, { pluginId: "ohmygame:taptap-maker", preview: "external" });
    let finish = () => {};
    const prompt = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
    const followUp = vi.fn(async () => {});
    const app = createApp({ dataDirectory, createSession: async () => ({ messages: [], prompt, followUp, abort: async () => { finish(); }, dispose: () => {}, subscribe: () => () => {} }) });
    apps.push(app);
    const base = `/projects/${project.id}/conversations`;
    const conversation = (await app.inject({ method: "POST", url: base, payload: {} })).json();
    const retired = await app.inject({ method: "POST", url: `${base}/${conversation.id}/turns`, payload: { prompt: " /PUBLISH " } });
    expect(retired.statusCode).toBe(410);
    expect((await app.inject({ method: "POST", url: `${base}/${conversation.id}/revise-last`, payload: { prompt: "/publish" } })).statusCode).toBe(410);
    expect(prompt).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: `${base}/${conversation.id}/turns`, payload: { prompt: "$game-studio Review the project files" } });
    expect(response.statusCode, response.body).toBe(202);
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("$game-studio Review the project files"));
      const queued = await app.inject({ method: "POST", url: `${base}/${conversation.id}/turns`, payload: { prompt: "/publish" } });
      expect(queued.statusCode).toBe(410);
      expect(followUp).not.toHaveBeenCalled();
      expect((await app.inject({ url: `${base}/${conversation.id}` })).json().pendingPrompts).toEqual([]);
      expect((await app.inject({ url: `/projects/${project.id}` })).json().integration).toEqual(project.integration);
    } finally { finish(); }
  });

  it("ends live project and authentication SSE before quiescing work and closing the VM boundary", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-sse-close-"));
    directories.push(dataDirectory);
    let releaseVm!: () => void, finishPrompt: (() => void) | undefined;
    const vmGate = new Promise<void>((resolve) => { releaseVm = resolve; });
    const closeVm = vi.fn(async () => vmGate);
    const abort = vi.fn(async () => { finishPrompt?.(); });
    const prompt = vi.fn(async () => new Promise<void>((resolve) => { finishPrompt = resolve; }));
    const app = createApp({ dataDirectory, accessToken: "local-shutdown-fixture", projectExecution: { setAdmission: vi.fn(), close: closeVm } as unknown as IsolatedProjectExecution,
      createSession: async () => ({ messages: [], prompt, abort, dispose: () => {}, subscribe: () => () => {} }) });
    const newWork = vi.fn();
    app.post("/fixture-new-work", async () => { newWork(); return { accepted: true }; });
    const address = await app.listen({ host: "127.0.0.1", port: 0 }), headers = { authorization: "Bearer local-shutdown-fixture" };
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {}, headers })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: {}, headers })).json();
    await app.inject({ method: "POST", url: `/projects/${project.id}/conversations/${conversation.id}/turns`, payload: { prompt: "Wait until shutdown" }, headers });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    const operation = (await app.inject({ method: "POST", url: "/settings/models/providers/kunpo/login", payload: { method: "api_key" }, headers })).json();
    const controller = new AbortController(), readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    let closing: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (const url of [`/projects/${project.id}/events`, `/settings/model-auth/${operation.operationId}/events`]) {
        const response = await fetch(`${address}${url}`, { headers, signal: controller.signal });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader(); readers.push(reader);
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      }
      closing = app.close();
      const eof = Promise.all(readers.map(async (reader) => { while (!(await reader.read()).done) { /* Drain already queued events until the server ends the response. */ } }));
      await vi.waitFor(() => expect(closeVm).toHaveBeenCalledOnce());
      expect(abort).toHaveBeenCalledOnce();
      const rejected = await app.inject({ method: "POST", url: "/fixture-new-work", headers }).catch((cause: unknown) => cause);
      if (rejected instanceof Error) expect(rejected.message).toMatch(/clos(?:ed|ing)/i);
      else expect((rejected as { statusCode: number }).statusCode).toBe(503);
      expect(newWork).not.toHaveBeenCalled();
      releaseVm();
      await Promise.race([Promise.all([closing, eof]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSE shutdown did not finish within two seconds")), 2_000); })]);
    } finally {
      clearTimeout(timer); releaseVm(); controller.abort(); finishPrompt?.();
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
      await (closing ?? app.close());
    }
  });

  it("permits ordinary key/auth-themed game assets while retaining private filename and directory boundaries", async () => {
    const app = await localApp();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Game resources" } })).json();
    const assets = ["gold-key.png", "auth-icon.svg", "silver-token.glb", "secret-door.wav"];
    for (const name of assets) {
      expect(isPrivateCredentialName(name), name).toBe(false);
      expect(isPrivateProjectPath(`art/${name}`), name).toBe(false);
      await writeFile(path.join(project.workspacePath, name), "fixture asset bytes");
      expect(await localAgentPath(project.workspacePath, name)).toBe(await realpath(path.join(project.workspacePath, name)));
    }
    for (const relative of [".env", ".env.local", "certificate.pem", "certificate.pem.png", "server.key.svg", "credential.json.png", "credentials.json.png", "settings/local-api-keys.json", "openai-images.json", "provider-image-sources/receipt.json", "video-tasks/status.json", "model3d-tasks/job.json", "pi-agent/auth.json", "manual-vm.lock/owner.json"]) {
      expect(isPrivateProjectPath(relative), relative).toBe(true);
      await expect(localAgentPath(project.workspacePath, relative, true), relative).rejects.toThrow();
    }
    const entries = (await app.inject({ method: "GET", url: `/projects/${project.id}/files` })).json() as { path: string }[];
    expect(entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(assets));
  });

  it("continues tools, agents and preview cleanup after VM close fails and reports an AggregateError", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-close-failure-"));
    directories.push(dataDirectory);
    const failure = new Error("Fixture VM stop could not be confirmed");
    const closed: string[] = [];
    const execution = { setAdmission: vi.fn(), close: vi.fn(async () => { closed.push("vm"); throw failure; }) } as unknown as IsolatedProjectExecution;
    const app = createApp({ dataDirectory, projectExecution: execution });
    const toolsClose = ToolRunner.prototype.close;
    const agentsClose = AgentManager.prototype.close;
    const previewsClose = PreviewManager.prototype.stopAll;
    vi.spyOn(ToolRunner.prototype, "close").mockImplementation(async function (this: ToolRunner) { closed.push("tools"); return toolsClose.call(this); });
    vi.spyOn(AgentManager.prototype, "close").mockImplementation(async function (this: AgentManager) { closed.push("agents"); return agentsClose.call(this); });
    vi.spyOn(PreviewManager.prototype, "stopAll").mockImplementation(async function (this: PreviewManager) { closed.push("previews"); return previewsClose.call(this); });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Cleanup" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "<p>cleanup fixture</p>");
    const preview = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(preview.statusCode, preview.body).toBe(200);
    const url = preview.json().url;
    expect((await fetch(url)).status).toBe(200);
    await expect(app.close()).rejects.toMatchObject({ name: "AggregateError", errors: [failure] });
    expect(execution.close).toHaveBeenCalledOnce();
    expect(closed).toEqual(["tools", "agents", "previews", "vm"]);
    await expect(fetch(url, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
  });

  it("cannot revive retired author services through old environment values or options", async () => {
    for (const name of ["CLOUD_API_URL", "PUBLISH_API_URL", "DESKTOP_UPDATE_URL", "VITE_SUPABASE_URL", "VITE_POSTHOG_HOST", "SENTRY_DSN"]) vi.stubEnv(name, "https://author.invalid");
    vi.stubEnv("VITE_POSTHOG_KEY", "CANARY_TELEMETRY_KEY");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "CANARY_LOGIN_KEY");
    const request = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", request);
    const app = await localApp();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Static" } })).json();
    await writeFile(path.join(project.workspacePath, "index.html"), "<p>local</p>");
    for (const url of ["/cloud/quotas", "/cloud/jobs", "/community/games"]) expect((await app.inject({ url })).statusCode).toBe(410);
    expect((await app.inject({ method: "PUT", url: "/cloud/session", payload: { accessToken: "CANARY_RETIRED_TOKEN", userId: "old" } })).statusCode).toBe(410);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/publish`, payload: { accessToken: "CANARY_RETIRED_TOKEN" } })).statusCode).toBe(410);
    const disabledRuntimes = await app.inject({ url: "/agent-runtimes" });
    expect(disabledRuntimes.statusCode).toBe(200);
    expect(disabledRuntimes.json().filter((runtime: { id: string }) => !["codex-cli", "qoder-cli"].includes(runtime.id)).every((runtime: { enabled: boolean; installed: boolean }) => !runtime.enabled && !runtime.installed)).toBe(true);
    expect(disabledRuntimes.json().find((runtime: { id: string }) => runtime.id === "qoder-cli")).toMatchObject({ enabled: false, auth: { status: "unknown" } });
    expect((await app.inject({ method: "POST", url: "/agent-runtimes/claude-code-cli/login" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/login", payload: { method: "oauth" } })).statusCode).toBe(403);
    await app.inject({ url: "/settings/providers" });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not return a saved literal key and rejects known credentials in project input", async () => {
    const app = await localApp();
    const key = "CANARY_LOCAL_PROVIDER_93fa";
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: {
      name: "Reviewed", api: "openai-responses", baseUrl: "https://llm.ziy.cc/v1", authentication: "api_key", apiKey: key, models: [],
    } });
    expect(saved.statusCode).toBe(201);
    expect(saved.body).not.toContain(key);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { name: key } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(key);
    expect((await app.inject({ url: "/settings/providers" })).body).not.toContain(key);
  });
});
