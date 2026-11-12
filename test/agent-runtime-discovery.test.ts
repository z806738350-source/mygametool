// Legacy execution is retained for future OS-isolated support; agent-local-files.test.ts covers current refusal.
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { probeModels } from "../src/daemon/agent-runtimes/discovery.js";
import { AgentRuntimeService, type NativeSessionRequest } from "../src/daemon/agent-runtimes/service.js";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import * as discovery from "../src/daemon/agent-runtimes/discovery.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import * as controlledQoder from "../src/daemon/agent-runtimes/controlled-qoder.js";
import { QoderConnection } from "../src/daemon/agent-runtimes/qoder.js";
import * as codexProtocol from "../src/daemon/agent-runtimes/codex-app-server.js";
import * as controlledCodex from "../src/daemon/agent-runtimes/controlled-codex.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { NATIVE_PRIVATE_SESSION_ENTRY } from "../src/daemon/agent-runtimes/project-history.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];

it("preserves Codex model/list image capability instead of dropping it during catalog projection", async () => {
  const request = vi.fn(async (method: string) => method === "model/list" ? { data: [
    { id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { id: "text-only", inputModalities: ["text"] },
    { id: "unknown-capability" },
    { id: "invalid-capability", inputModalities: "image" },
    { id: "hidden-image", hidden: true, inputModalities: ["image"] },
  ] } : {});
  const stop = vi.fn(async () => {});
  vi.spyOn(codexProtocol, "CodexAppServer").mockImplementation(function () {
    return { initialize: async () => {}, request, stop } as never;
  });
  const compatibility = vi.spyOn(codexProtocol, "checkCodexCompatibility").mockResolvedValue(undefined);
  const spawn = vi.fn(() => { throw new Error("No process or provider request in the catalog fixture"); });
  setAgentProcessSpawner(spawn as never);
  const result = await probeModels("/audited/codex", "codex-cli", { HOME: "/tmp/codex-catalog-fixture", CODEX_HOME: "/tmp/codex-catalog-fixture" }, "/tmp/codex-catalog-fixture");
  expect(result.models).toMatchObject([
    { id: "gpt-6.1-sol", supportsImages: true, nativeReasoningLevels: ["low"] },
    { id: "text-only", supportsImages: false },
    { id: "unknown-capability", supportsImages: false },
    { id: "invalid-capability", supportsImages: false },
  ]);
  expect(result.models).toHaveLength(4);
  expect(compatibility).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(spawn).not.toHaveBeenCalled();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAgentProcessSpawner(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
});

function qoderInstallation() {
  return vi.spyOn(controlledQoder, "resolveControlledQoder").mockResolvedValue({
    path: "/audited/qoder",
    signature: "audited-fixture",
    source: "manual",
    sdkEntry: "/audited/sdk/index.js",
    version: controlledQoder.CONTROLLED_QODER_VERSION,
  });
}

function qoderSessionRequest(root: string, model = "auto"): NativeSessionRequest {
  return { runtime: "qoder-cli", model, workspacePath: root, sessionManager: SessionManager.inMemory(root), tools: [], skillDirectories: [], instructions: "Offline session admission fixture", policy: { workspacePath: root, neverTouch: [] }, requestApproval: async () => "deny" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("deletes native Codex history without sign-in, model discovery or turns and retries a confirmed prior deletion", async () => {
  const { root, service } = await fixture();
  const project = { id: "history-project", storagePath: path.join(root, "project"), workspacePath: path.join(root, "project/workspace") } as ProjectState;
  const session = path.join(project.storagePath!, "session", "conversation.jsonl"), id = "11111111-1111-4111-8111-111111111111";
  await mkdir(path.dirname(session), { recursive: true });
  await writeFile(session, JSON.stringify({ type: "custom", customType: "ohmygame-native-session", data: { runtime: "codex-cli", sessionId: id } }) + "\n");
  vi.spyOn(discovery, "resolveBinary").mockResolvedValue({ path: "/audited/codex", signature: "fixture", source: "manual" });
  const verify = vi.spyOn(controlledCodex, "verifyControlledCodexBinary").mockResolvedValue();
  const probe = vi.spyOn(discovery, "probeAuth").mockRejectedValue(new Error("No account check"));
  const models = vi.spyOn(discovery, "probeModels").mockRejectedValue(new Error("No model discovery"));
  const initialize = vi.fn(async () => {}), stop = vi.fn(async () => {});
  const request = vi.fn(async () => { throw new Error("temporary native deletion failure"); });
  vi.spyOn(codexProtocol, "CodexAppServer").mockImplementation(function () { return { initialize, stop, request } as never; });
  await expect(service.removeProjectHistory(project)).rejects.toThrow("temporary native deletion failure");
  expect(await readFile(session, "utf8")).toContain(id);
  request.mockRejectedValue(Object.assign(new Error(`no rollout found for thread id ${id}`), { rpcCode: -32600 }));
  await service.removeProjectHistory(project);
  expect(request.mock.calls).toEqual([["thread/delete", { threadId: id }], ["thread/delete", { threadId: id }]]);
  expect(initialize).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(2); expect(verify).toHaveBeenCalledTimes(2);
  expect(probe).not.toHaveBeenCalled(); expect(models).not.toHaveBeenCalled();
});

it("records project ownership before creating a disposable native session", async () => {
  qoderInstallation();
  vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async method => method === "account/read" ? { userId: "offline" } : [{ value: "auto", source: "system" }]);
  const { root, service } = await fixture();
  await service.status("qoder-cli", true); await service.update("qoder-cli", { enabled: true });
  const request = { ...qoderSessionRequest(root), projectId: "owning-project" };
  const session = await service.createSession(request);
  try {
    const entry = request.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === NATIVE_PRIVATE_SESSION_ENTRY);
    expect(entry).toMatchObject({ data: { version: 1, projectId: request.projectId, runtime: "qoder-cli", privateDirectory: expect.stringContaining(path.join(root, "agent-runtimes/sessions/qoder-cli-")) } });
  } finally { await session.dispose(); }
});

it("keeps disabled passive Qoder discovery and manual sign-in preparation free of CLI, shell and SDK execution", async () => {
  qoderInstallation();
  const resolve = vi.spyOn(discovery, "resolveBinary").mockRejectedValue(new Error("No general CLI discovery"));
  const version = vi.spyOn(discovery, "probeVersion").mockRejectedValue(new Error("No CLI version execution"));
  const auth = vi.spyOn(discovery, "probeAuth").mockRejectedValue(new Error("No CLI auth execution"));
  const shell = vi.spyOn(environment, "loginShellPath").mockRejectedValue(new Error("No login shell"));
  const start = vi.spyOn(QoderConnection.prototype, "start").mockRejectedValue(new Error("No SDK start"));
  const spawn = vi.fn();
  setAgentProcessSpawner(spawn as never);
  vi.stubEnv("QODER_PERSONAL_ACCESS_TOKEN", "AMBIENT_QODER_DISCOVERY_CANARY");
  const { service } = await fixture();

  expect(await service.status("qoder-cli")).toMatchObject({ enabled: false, installed: true, commandSandbox: "none", permissionMode: "standard", auth: { status: "unknown", billing: "unknown" } });
  await service.update("qoder-cli", { enabled: false });
  expect(await service.models()).toEqual({ models: [], loading: [] });
  const login = await service.login("qoder-cli");
  expect(login).not.toHaveProperty("url");
  expect(login.command).toContain("/usr/bin/env -i ");
  expect(login.command).toContain("QODER_CONFIG_DIR=");
  expect(login.command).toContain("/agent-runtimes/qoder/config'");
  expect(login.command).toContain("'/audited/qoder' --cwd '");
  expect(login.command).toContain("/agent-runtimes/qoder/home/login' login");
  expect(login.command).not.toMatch(/AMBIENT_QODER|QODER_PERSONAL_ACCESS_TOKEN/);
  expect(service.settings.defaultModel()).toBeUndefined();
  await expect(service.update("qoder-cli", { permissionMode: "full" })).rejects.toThrow("Full access is unavailable");
  for (const spy of [resolve, version, auth, shell, start, spawn]) expect(spy).not.toHaveBeenCalled();
});

it("discovers only projected system models after an explicit mocked Qoder account check", async () => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method, params) => {
    if (method === "account/read") return { userId: "fixture-user", token: "PRIVATE_ACCOUNT_CANARY", email: "private@example.invalid" };
    expect(method).toBe("models/list");
    expect(params).toEqual({ live: true });
    return [
      { value: "auto", displayName: "Auto", isVl: true, source: "system", efforts: ["high", "max", "high", "arbitrary"], defaultContextWindow: 128000, token: "PRIVATE_MODEL_CANARY" },
      { value: "lite", source: "system" },
      { value: "disabled", source: "system", isEnabled: false },
      { value: "byok/private", source: "custom", baseUrl: "https://private.invalid", apiKey: "PRIVATE_BYOK_CANARY" },
      { value: "auto", source: "system" },
    ];
  });
  const { service } = await fixture();
  expect((await service.status("qoder-cli")).auth.status).toBe("unknown");
  expect(start).not.toHaveBeenCalled();
  expect(await service.status("qoder-cli", true)).toMatchObject({ auth: { status: "signed-in", billing: "unknown" }, diagnostics: [] });
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list"]);
  await service.update("qoder-cli", { enabled: true });
  const catalog = await service.models();
  expect(catalog).toEqual({ models: [{ provider: "qoder-cli", providerName: "Qoder", id: "auto", name: "Auto", supportsImages: true, reasoningLevels: [], nativeReasoningLevels: ["high", "max"], contextWindow: 128000 }], loading: [] });
  expect(JSON.stringify(await service.status("qoder-cli"))).not.toMatch(/PRIVATE_|private@example/);
  expect(JSON.stringify(catalog)).not.toMatch(/PRIVATE_|private\.invalid/);
  expect(start).toHaveBeenCalledOnce();
  expect(service.settings.defaultModel()).toBeUndefined();
  expect(await service.update("qoder-cli", { binaryPath: "/audited/replacement-qoder" })).toMatchObject({ auth: { status: "signed-in" }, diagnostics: [] });
  expect(await service.models()).toEqual(catalog);
  expect(start).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list", "account/read", "models/list"]);
});

it("does not fetch Qoder's live catalog or expose SDK errors when the account check fails", async () => {
  qoderInstallation();
  vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockRejectedValue(new Error("PRIVATE_QODER_ERROR_CANARY"));
  const { service } = await fixture();
  const status = await service.status("qoder-cli", true);
  expect(status).toMatchObject({ installed: true, auth: { status: "unknown", billing: "unknown" }, diagnostics: [{ code: "probe-failed" }] });
  expect(JSON.stringify(status)).not.toContain("PRIVATE_QODER_ERROR_CANARY");
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read"]);
  expect(stop).toHaveBeenCalledOnce();
});

it.each(["status", "models", "model"] as const)("restores an enabled Qoder connection on the first %s read after restart without a saved login assertion", async (firstRead) => {
  qoderInstallation();
  const resolve = vi.spyOn(discovery, "resolveBinary").mockRejectedValue(new Error("No general CLI discovery"));
  const version = vi.spyOn(discovery, "probeVersion").mockRejectedValue(new Error("No CLI version execution"));
  const auth = vi.spyOn(discovery, "probeAuth").mockRejectedValue(new Error("No CLI auth execution"));
  const shell = vi.spyOn(environment, "loginShellPath").mockRejectedValue(new Error("No login shell"));
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    if (method === "account/read") return { userId: "OFFLINE_QODER_ACCOUNT_CANARY" };
    expect(method).toBe("models/list");
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const fetch = vi.fn(async () => { throw new Error("No network in the Qoder restart fixture"); });
  vi.stubGlobal("fetch", fetch);
  const spawn = vi.fn(() => { throw new Error("No processes in the Qoder restart fixture"); });
  setAgentProcessSpawner(spawn as never);
  const { root, service } = await fixture();
  expect(await service.status("qoder-cli", true)).toMatchObject({ auth: { status: "signed-in" }, diagnostics: [] });
  await service.update("qoder-cli", { enabled: true });
  expect((await service.models()).models).toMatchObject([{ provider: "qoder-cli", id: "auto" }]);
  const configuration = path.join(root, "agent-runtimes/qoder/config");
  const home = path.join(root, "agent-runtimes/qoder/home");
  const marker = path.join(configuration, "restart-preservation-sentinel.txt");
  await writeFile(marker, "Non-secret preservation marker", { mode: 0o600, flag: "wx" });
  const metadata = async () => Promise.all([configuration, home, marker].map(async (file) => {
    const info = await lstat(file);
    return { path: file, mode: info.mode, uid: info.uid, gid: info.gid, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }));
  const before = await metadata();
  await service.close();
  const restarted = new AgentRuntimeService(root, () => undefined);
  cleanup.push(() => restarted.close());
  await restarted.load();
  expect(start).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list"]);
  if (firstRead === "status") await restarted.status("qoder-cli");
  else if (firstRead === "models") await restarted.models();
  else await restarted.model("qoder-cli", "auto");
  const status = await restarted.status("qoder-cli");
  expect(status).toMatchObject({ enabled: true, installed: true, auth: { status: "signed-in", billing: "unknown" }, diagnostics: [] });
  expect(status).toHaveProperty("checkedAt");
  expect(status.diagnostics.some(item => item.code === "signed-out")).toBe(false);
  expect((await restarted.models()).models).toMatchObject([{ provider: "qoder-cli", id: "auto" }]);
  expect(await restarted.model("qoder-cli", "auto")).toMatchObject({ provider: "qoder-cli", id: "auto" });
  await restarted.update("qoder-cli", { enabled: false });
  expect(await restarted.models()).toEqual({ models: [], loading: [] });
  expect(await restarted.model("qoder-cli", "auto")).toBeUndefined();
  await restarted.update("qoder-cli", { enabled: true });
  expect(await metadata()).toEqual(before);
  // Inspect only this fresh fixture's settings, never the preservation marker's contents.
  expect(await readFile(path.join(root, "agent-runtimes.json"), "utf8")).not.toMatch(/OFFLINE_QODER_ACCOUNT|signed-in|checkedAt|"auth"/);
  expect(await readdir(configuration)).toEqual(expect.arrayContaining(["settings.json", "restart-preservation-sentinel.txt"]));
  expect(start).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list", "account/read", "models/list"]);
  for (const spy of [resolve, version, auth, shell, fetch, spawn]) expect(spy).not.toHaveBeenCalled();
});

it("shares one Qoder account and catalog check across concurrent status, model reads and explicit recheck", async () => {
  qoderInstallation();
  const account = deferred<{ userId: string }>();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method, params) => {
    if (method === "account/read") return account.promise;
    expect(method).toBe("models/list");
    expect(params).toEqual({ live: true });
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const fetch = vi.fn(async () => { throw new Error("No network in the Qoder concurrent fixture"); });
  vi.stubGlobal("fetch", fetch);
  const shell = vi.spyOn(environment, "loginShellPath").mockRejectedValue(new Error("No login shell"));
  const { service } = await fixture();
  cleanup.push(() => account.resolve({ userId: "offline-fixture" }));
  await service.settings.update("qoder-cli", { enabled: true });
  const status = service.status("qoder-cli"), models = service.models(), model = service.model("qoder-cli", "auto"), explicit = service.status("qoder-cli", true);
  await vi.waitFor(() => expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read"]));
  expect(start).toHaveBeenCalledOnce();
  account.resolve({ userId: "offline-fixture" });
  const results = await Promise.all([status, models, model, explicit]);
  expect(results[0]).toMatchObject({ auth: { status: "signed-in" } });
  expect(results[1]).toMatchObject({ models: [{ provider: "qoder-cli", id: "auto" }], loading: [] });
  expect(results[2]).toMatchObject({ provider: "qoder-cli", id: "auto" });
  expect(results[3]).toMatchObject({ auth: { status: "signed-in" } });
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list"]);
  expect(fetch).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
});

it.each(["account", "models"] as const)("caches an automatic Qoder %s failure until an explicit recheck recovers", async (phase) => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  let failing = true;
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    if (failing && method === (phase === "account" ? "account/read" : "models/list")) throw new Error("PRIVATE_AUTOMATIC_PROBE_CANARY");
    if (method === "account/read") return { userId: "offline-fixture" };
    expect(method).toBe("models/list");
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const fetch = vi.fn(async () => { throw new Error("No network in the Qoder failure fixture"); });
  vi.stubGlobal("fetch", fetch);
  const { service } = await fixture();
  await service.settings.update("qoder-cli", { enabled: true });
  const failed = await service.status("qoder-cli");
  expect(failed).toMatchObject({ auth: { status: phase === "account" ? "unknown" : "signed-in" }, diagnostics: [{ code: phase === "account" ? "probe-failed" : "models-unavailable" }] });
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_AUTOMATIC_PROBE_CANARY");
  const firstMethods = phase === "account" ? ["account/read"] : ["account/read", "models/list"];
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60_000);
  expect(await service.status("qoder-cli")).toEqual(failed);
  expect(await service.models()).toEqual({ models: [], loading: [] });
  expect(await service.model("qoder-cli", "auto")).toBeUndefined();
  expect(start).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(firstMethods);
  failing = false;
  expect(await service.status("qoder-cli", true)).toMatchObject({ auth: { status: "signed-in" }, diagnostics: [] });
  expect(await service.model("qoder-cli", "auto")).toMatchObject({ id: "auto" });
  expect(start).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([method]) => method)).toEqual([...firstMethods, "account/read", "models/list"]);
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels a pending automatic Qoder check on disable before it can query or publish models", async () => {
  qoderInstallation();
  const account = deferred<{ userId: string }>();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    expect(method).toBe("account/read");
    return account.promise;
  });
  const { service } = await fixture();
  cleanup.push(() => account.resolve({ userId: "offline-stale-account" }));
  await service.settings.update("qoder-cli", { enabled: true });
  const status = service.status("qoder-cli");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const disabled = await service.update("qoder-cli", { enabled: false });
  expect(disabled).toMatchObject({ enabled: false, auth: { status: "unknown" } });
  expect(stop).toHaveBeenCalled();
  account.resolve({ userId: "offline-stale-account" });
  expect(await status).toMatchObject({ enabled: false, auth: { status: "unknown" } });
  expect(await service.models()).toEqual({ models: [], loading: [] });
  expect(await service.model("qoder-cli", "auto")).toBeUndefined();
  expect(start).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read"]);
});

it("does not start a Qoder SDK after disable while private environment preparation is pending", async () => {
  qoderInstallation();
  const ready = deferred<void>();
  const prepare = controlledQoder.controlledQoderEnvironment;
  const environment = vi.spyOn(controlledQoder, "controlledQoderEnvironment").mockImplementation(async root => { await ready.promise; return prepare(root); });
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockRejectedValue(new Error("No account request after disable"));
  const { service } = await fixture();
  cleanup.push(() => ready.resolve());
  await service.settings.update("qoder-cli", { enabled: true });
  const status = service.status("qoder-cli");
  await vi.waitFor(() => expect(environment).toHaveBeenCalledOnce());
  expect(await service.update("qoder-cli", { enabled: false })).toMatchObject({ enabled: false });
  ready.resolve();
  expect(await status).toMatchObject({ enabled: false, auth: { status: "unknown" } });
  expect(start).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it.each(["disable", "close"] as const)("does not start a Qoder SDK when %s finishes before static resolution", async (action) => {
  const resolve = qoderInstallation();
  const binary = (await controlledQoder.resolveControlledQoder())!;
  const ready = deferred<typeof binary>();
  resolve.mockClear().mockImplementationOnce(() => ready.promise);
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockRejectedValue(new Error("No account request after stopping"));
  const { service } = await fixture();
  cleanup.push(() => ready.resolve(binary));
  await service.settings.update("qoder-cli", { enabled: true });
  const status = service.status("qoder-cli");
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  if (action === "disable") expect(await service.update("qoder-cli", { enabled: false })).toMatchObject({ enabled: false });
  else await service.close();
  ready.resolve(binary);
  expect(await status).toMatchObject({ auth: { status: "unknown" }, ...(action === "disable" ? { enabled: false } : {}) });
  expect(start).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("validates a fresh enabled Qoder connection before rejecting an unverified session model", async () => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    if (method === "account/read") return { userId: "offline-fixture" };
    expect(method).toBe("models/list");
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const { root, service } = await fixture();
  await service.settings.update("qoder-cli", { enabled: true });
  await expect(service.createSession(qoderSessionRequest(root, "unverified-model"))).rejects.toThrow("current model catalog has not verified the selected model");
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list"]);
});

it("caches a Qoder cleanup failure without exposing SDK details or repeating passive checks", async () => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockRejectedValue(new Error("PRIVATE_QODER_STOP_CANARY"));
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    if (method === "account/read") return { userId: "offline-fixture" };
    expect(method).toBe("models/list");
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const { service } = await fixture();
  await service.settings.update("qoder-cli", { enabled: true });
  const status = await service.status("qoder-cli");
  expect(status).toMatchObject({ auth: { status: "signed-in" }, diagnostics: [{ code: "models-unavailable" }] });
  expect(JSON.stringify(status)).not.toContain("PRIVATE_QODER_STOP_CANARY");
  expect(await service.status("qoder-cli")).toEqual(status);
  expect(await service.models()).toEqual({ models: [], loading: [] });
  expect(await service.model("qoder-cli", "auto")).toBeUndefined();
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list"]);
});

it("waits for an obsolete Qoder check before validating a replacement executable and publishes only its catalog", async () => {
  const resolve = qoderInstallation();
  const binary = (await controlledQoder.resolveControlledQoder())!;
  resolve.mockImplementation(async override => ({ ...binary, path: override ?? binary.path, signature: override ? "replacement-signature" : "original-signature" }));
  const original = deferred<{ userId: string }>();
  const connections: QoderConnection[] = [];
  const start = vi.spyOn(QoderConnection.prototype, "start").mockImplementation(async function (this: QoderConnection) { connections.push(this); });
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const modelConnections: number[] = [];
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async function (this: QoderConnection, method) {
    const index = connections.indexOf(this);
    if (method === "account/read") return index === 0 ? original.promise : { userId: "offline-replacement" };
    expect(method).toBe("models/list");
    modelConnections.push(index);
    return [{ value: index === 0 ? "obsolete-model" : "replacement-model", displayName: "Fixture", source: "system" }];
  });
  const { service } = await fixture();
  cleanup.push(() => original.resolve({ userId: "offline-obsolete" }));
  await service.settings.update("qoder-cli", { enabled: true });
  const first = service.status("qoder-cli");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const replacement = service.update("qoder-cli", { binaryPath: "/audited/replacement-qoder" });
  await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  expect(start).toHaveBeenCalledOnce();
  original.resolve({ userId: "offline-obsolete" });
  const statuses = await Promise.all([first, replacement]);
  expect(statuses).toEqual([expect.objectContaining({ enabled: true, binaryPath: "/audited/replacement-qoder", auth: { status: "signed-in", billing: "unknown" } }), expect.objectContaining({ enabled: true, binaryPath: "/audited/replacement-qoder", auth: { status: "signed-in", billing: "unknown" } })]);
  expect((await service.models()).models.map(model => model.id)).toEqual(["replacement-model"]);
  expect(await service.model("qoder-cli", "obsolete-model")).toBeUndefined();
  expect(start).toHaveBeenCalledTimes(2);
  expect(modelConnections).toEqual([1]);
});

it("discards an in-flight Qoder result when the installation becomes incompatible", async () => {
  const resolve = qoderInstallation();
  const account = deferred<{ userId: string }>();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    expect(method).toBe("account/read");
    return account.promise;
  });
  const { service } = await fixture();
  cleanup.push(() => account.resolve({ userId: "offline-obsolete" }));
  await service.settings.update("qoder-cli", { enabled: true });
  const status = service.status("qoder-cli");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  resolve.mockRejectedValue(new Error("PRIVATE_UNREVIEWED_VERSION_CANARY"));
  expect(await service.status("qoder-cli")).toMatchObject({ installed: false, auth: { status: "unknown" }, diagnostics: [{ code: "runtime-incompatible" }] });
  expect(stop).toHaveBeenCalled();
  account.resolve({ userId: "offline-obsolete" });
  expect(await status).toMatchObject({ installed: false, auth: { status: "unknown" }, diagnostics: [{ code: "runtime-incompatible" }] });
  expect(await service.models()).toEqual({ models: [], loading: [] });
  expect(start).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read"]);
});

it.each([
  ["empty account", {}],
  ["null account", null],
  ["array account", []],
  ["string account", "OFFLINE_INVALID_ACCOUNT_CANARY"],
  ["non-string user id", { userId: 42 }],
  ["blank user id", { userId: " \t " }],
] as const)("keeps an explicit Qoder %s inconclusive without querying models", async (_name, account) => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  const request = vi.spyOn(QoderConnection.prototype, "request").mockResolvedValue(account);
  const fetch = vi.fn(async () => { throw new Error("No network in the Qoder account fixture"); });
  vi.stubGlobal("fetch", fetch);
  const { service } = await fixture();
  const status = await service.status("qoder-cli", true);
  expect(status).toMatchObject({ installed: true, auth: { status: "unknown", billing: "unknown" }, diagnostics: [{ code: "probe-failed" }] });
  expect(JSON.stringify(status)).not.toContain("OFFLINE_INVALID_ACCOUNT_CANARY");
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read"]);
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps a verified Qoder account distinct from a failed catalog and clears earlier models", async () => {
  qoderInstallation();
  const start = vi.spyOn(QoderConnection.prototype, "start").mockResolvedValue();
  const stop = vi.spyOn(QoderConnection.prototype, "stop").mockResolvedValue();
  let failModels = false;
  const request = vi.spyOn(QoderConnection.prototype, "request").mockImplementation(async (method) => {
    if (method === "account/read") return { userId: "offline-fixture" };
    expect(method).toBe("models/list");
    if (failModels) throw new Error("PRIVATE_QODER_CATALOG_ERROR_CANARY");
    return [{ value: "auto", displayName: "Auto", source: "system" }];
  });
  const fetch = vi.fn(async () => { throw new Error("No network in the Qoder catalog fixture"); });
  vi.stubGlobal("fetch", fetch);
  const { root, service } = await fixture();
  await service.status("qoder-cli", true);
  await service.update("qoder-cli", { enabled: true });
  expect((await service.models()).models).toHaveLength(1);
  await expect(service.createSession(qoderSessionRequest(root, "unverified-model"))).rejects.toThrow("current model catalog has not verified the selected model");
  expect(start).toHaveBeenCalledOnce();
  failModels = true;
  const status = await service.status("qoder-cli", true);
  expect(status).toMatchObject({ installed: true, auth: { status: "signed-in", billing: "unknown" }, diagnostics: [{ code: "models-unavailable" }] });
  expect(JSON.stringify(status)).not.toContain("PRIVATE_QODER_CATALOG_ERROR_CANARY");
  expect(await service.status("qoder-cli")).toEqual(status);
  expect(await service.models()).toEqual({ models: [], loading: [] });
  expect(await service.model("qoder-cli", "auto")).toBeUndefined();
  await expect(service.createSession(qoderSessionRequest(root))).rejects.toThrow("current model catalog has not verified the selected model");
  expect(start).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["account/read", "models/list", "account/read", "models/list"]);
  expect(fetch).not.toHaveBeenCalled();
});

it("fails closed for an unsupported Qoder installation before starting its SDK", async () => {
  vi.spyOn(controlledQoder, "resolveControlledQoder").mockRejectedValue(new Error("Unreviewed package version"));
  const start = vi.spyOn(QoderConnection.prototype, "start").mockRejectedValue(new Error("No SDK start"));
  const { service } = await fixture();
  expect(await service.status("qoder-cli", true)).toMatchObject({ installed: false, auth: { status: "unknown", billing: "unknown" }, diagnostics: [{ code: "runtime-incompatible" }] });
  expect(await service.model("qoder-cli", "auto")).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
});
// Windows starts only .exe programs, so it cannot run these script stand-ins, and
// discovery ignores them there (see docs/agent-runtimes.md).
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-model-cache-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = new AgentRuntimeService(root, () => undefined);
  await service.load();
  cleanup.push(() => service.close());
  const install = async (name: string) => {
    const binary = path.join(root, name);
    const catalog = binary + ".json",
      started = binary + ".started",
      gate = binary + ".gate";
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("2.1.300"); process.exit(); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({loggedIn:true})); process.exit(); }
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.type !== "control_request") return;
  fs.writeFileSync(${JSON.stringify(started)}, "started");
  const reply = () => {
    if (fs.existsSync(${JSON.stringify(gate)})) return setTimeout(reply, 10);
    const models = JSON.parse(fs.readFileSync(${JSON.stringify(catalog)}, "utf8"));
    console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:m.request_id,response:{models}}}));
  };
  reply();
});
`,
      { mode: 0o700 },
    );
    const setModel = (value: string) =>
      writeFile(catalog, JSON.stringify([{ value, displayName: value }]));
    await setModel(name);
    return { binary, gate, started, setModel };
  };
  return { root, service, install };
}
it.skipIf(true || process.platform === "win32")("refreshes direct model lookup after the catalog TTL expires", async () => {
  const { service, install } = await fixture();
  const cli = await install("claude-a");
  await service.update("claude-code-cli", {
    binaryPath: cli.binary,
    enabled: true,
  });
  expect(await service.model("claude-code-cli", "claude-a")).toBeDefined();
  await cli.setModel("changed");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  expect(await service.model("claude-code-cli", "changed")).toBeDefined();
  expect(await service.model("claude-code-cli", "claude-a")).toBeUndefined();
});
it.skipIf(true || process.platform === "win32")("does not let an old in-flight catalog overwrite a newly selected executable", async () => {
  const { service, install } = await fixture();
  const old = await install("claude-old"),
    next = await install("claude-new");
  await service.update("claude-code-cli", {
    binaryPath: old.binary,
    enabled: true,
  });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  await rm(old.started);
  await writeFile(old.gate, "hold");
  const stale = service.model("claude-code-cli", "claude-old");
  await expect
    .poll(() => readFile(old.started, "utf8").catch(() => ""))
    .toBe("started");
  await service.update("claude-code-cli", { binaryPath: next.binary });
  expect(await service.model("claude-code-cli", "claude-new")).toBeDefined();
  await rm(old.gate);
  expect(await stale).toBeUndefined();
  expect(await service.model("claude-code-cli", "claude-new")).toBeDefined();
  expect(await service.model("claude-code-cli", "claude-old")).toBeUndefined();
});

it("refuses a native Codex catalog probe before starting its paginated CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-model-pages-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "codex");
  await writeFile(
    binary,
    `#!${process.execPath}
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "thread/start" ? {thread:{id:"probe"},activePermissionProfile:{id:m.params.permissions}} : m.method === "model/list" ? (m.params.cursor ? {data:[{id:"second",supportedReasoningEfforts:[{reasoningEffort:"high"}]}]} : {data:[{id:"first"}],nextCursor:"page-2"}) : {};
  console.log(JSON.stringify({id:m.id,result}));
});
`,
    { mode: 0o700 },
  );
  const spawn = vi.fn();
  setAgentProcessSpawner(spawn as never);
  try {
    await expect(probeModels(binary, "codex-cli", { PATH: process.env.PATH ?? "" }, root)).rejects.toThrow("requires a private configuration directory");
    expect(spawn).not.toHaveBeenCalled();
  } finally { setAgentProcessSpawner(undefined); }
});

it.skip("keeps the last reported usage limits across a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-limits-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "agent-runtimes"), { recursive: true });
  const fiveHour = {
    id: "claude/five_hour",
    usedPercent: 13,
    windowMinutes: 300,
    resetsAt: 1792326600,
  };
  await writeFile(
    path.join(root, "agent-runtimes", "limits.json"),
    JSON.stringify({
      "claude-code-cli": [fiveHour, { id: 3 }],
      "unknown-cli": [fiveHour],
    }),
  );
  const service = new AgentRuntimeService(root, () => undefined);
  await service.load();
  cleanup.push(() => service.close());
  expect((await service.status("claude-code-cli")).limits).toEqual([fiveHour]);
  expect((await service.status("codex-cli")).limits).toBeUndefined();
});
