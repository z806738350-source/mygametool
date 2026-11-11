import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { loadDaemonLocalEnv, localEnvFileArgument, reuseLocalEnvArgument } from "../src/daemon/local-env.js";
import { createLocalModelRuntime, LocalApiKeyStore } from "../src/daemon/local-model-runtime.js";
import { kunpoRuntimeProvider } from "../src/daemon/provider-model-settings.js";
import { loadEnvironmentFiles } from "../src/daemon/environment.js";
import * as agentModule from "../src/daemon/agent.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function fixture(contents = "KUNPO_API_KEY=\n") {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-env-"));
  directories.push(directory);
  const file = path.join(directory, "fake.env"), credentials = path.join(directory, "private", "local-env-api-keys.json");
  await writeFile(file, contents, { mode: 0o600 });
  return { directory, file, credentials };
}

describe("explicit daemon-only local environment credentials", () => {
  it("retires implicit environment-file loading in every mode", async () => {
    const { directory } = await fixture();
    const reader = vi.spyOn(process, "loadEnvFile").mockImplementation(() => { throw new Error("Implicit file reads are forbidden"); });
    vi.stubEnv("KUNPO_API_KEY", undefined);
    loadEnvironmentFiles(directory, "development");
    loadEnvironmentFiles(directory, "production");
    expect(reader).not.toHaveBeenCalled();
    expect(process.env.KUNPO_API_KEY).toBeUndefined();
  });
  it("accepts one absolute argument and never discovers a default file", () => {
    expect(localEnvFileArgument(["--dev"])).toBeUndefined();
    expect(localEnvFileArgument(["--local-env", "/tmp/fake.env"])).toBe("/tmp/fake.env");
    expect(localEnvFileArgument(["--local-env=/tmp/fake.env"])).toBe("/tmp/fake.env");
    for (const args of [["--local-env"], ["--local-env", "relative.env"], ["--local-env", "/tmp/one.env", "--local-env=/tmp/two.env"], ["--local-env=/tmp/invalid\n.env"]]) {
      expect(() => localEnvFileArgument(args)).toThrow("once with an absolute file path");
    }
  });

  it("allows snapshot reuse only for a desktop-owned recovery and never combines it with a file import", () => {
    expect(reuseLocalEnvArgument([], false)).toBe(false);
    expect(reuseLocalEnvArgument(["--reuse-local-env"], true)).toBe(true);
    expect(() => reuseLocalEnvArgument(["--reuse-local-env"], false)).toThrow("desktop-owned recovery");
    for (const args of [["--reuse-local-env", "--reuse-local-env"], ["--reuse-local-env=true"], ["--reuse-local-env", "--local-env", "/tmp/fake.env"]]) {
      expect(() => reuseLocalEnvArgument(args, true)).toThrow("without --local-env");
    }
  });

  it("keeps the imported launch snapshot unchanged when its source file is subsequently edited", async () => {
    const original = "sk-INITIAL_SNAPSHOT_FAKE", edited = "sk-EDITED_SOURCE_FAKE";
    const { file, credentials } = await fixture(`KUNPO_API_KEY=${original}\n`);
    await loadDaemonLocalEnv(file, credentials);
    await writeFile(file, `KUNPO_API_KEY=${edited}\n`);
    expect(reuseLocalEnvArgument(["--reuse-local-env"], true)).toBe(true);
    expect(await new LocalApiKeyStore(credentials).read("kunpo")).toEqual({ type: "api_key", key: original });
    await loadDaemonLocalEnv(file, credentials);
    expect(await new LocalApiKeyStore(credentials).read("kunpo")).toEqual({ type: "api_key", key: edited });
  });

  it("writes only the literal Kunpo key to a private dedicated store without changing process.env", async () => {
    const key = "sk-LOCAL_ENV_CANARY_20261028";
    const { file, credentials } = await fixture(`# Local test only\r\nKUNPO_API_KEY=${key}\r\n`);
    vi.stubEnv("KUNPO_API_KEY", "AMBIENT_TEST_VALUE_MUST_NOT_WIN");
    await expect(loadDaemonLocalEnv(file, credentials)).resolves.toEqual({ configured: true });
    expect(await new LocalApiKeyStore(credentials).read("kunpo")).toEqual({ type: "api_key", key });
    expect(Object.keys(JSON.parse(await readFile(credentials, "utf8")))).toEqual(["kunpo"]);
    if (process.platform !== "win32") expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(process.env.KUNPO_API_KEY).toBe("AMBIENT_TEST_VALUE_MUST_NOT_WIN");
    expect(Object.values(process.env)).not.toContain(key);
  });

  it("replaces a stale unreadable profile with an empty one and does not fall back to old account credentials", async () => {
    const { directory, file, credentials } = await fixture();
    await mkdir(path.dirname(credentials), { recursive: true });
    await writeFile(credentials, "not JSON: PRIVATE_STALE_TEST_PROFILE", { mode: 0o600 });
    const pi = path.join(directory, "pi");
    await mkdir(pi);
    await writeFile(path.join(pi, "local-api-keys.json"), "not JSON: PRIVATE_OLD_TEST_ACCOUNT", { mode: 0o600 });
    await expect(loadDaemonLocalEnv(file, credentials)).resolves.toEqual({ configured: false });
    expect(JSON.parse(await readFile(credentials, "utf8"))).toEqual({});
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    const app = createApp({ dataDirectory: directory, piAgentDirectory: pi, localApiKeyFile: credentials });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/settings/providers" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().find((provider: { id: string }) => provider.id === "kunpo")).toMatchObject({ configured: false });
    expect(response.body).not.toContain("PRIVATE_OLD_TEST_ACCOUNT");
    expect(request).not.toHaveBeenCalled();
  });

  it("makes the explicit profile available to the daemon without returning the key or making a startup model request", async () => {
    const key = "sk-DAEMON_PROFILE_CANARY_20261028";
    const { directory, file, credentials } = await fixture(`KUNPO_API_KEY=${key}\n`);
    await loadDaemonLocalEnv(file, credentials);
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    const app = createApp({ dataDirectory: directory, piAgentDirectory: path.join(directory, "pi"), localApiKeyFile: credentials });
    apps.push(app);
    for (const url of ["/settings/providers", "/models"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(key);
      if (url === "/settings/providers") expect(response.json().find((provider: { id: string }) => provider.id === "kunpo")).toMatchObject({ configured: true });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("opens local projects and default-model conversations with an empty key without starting an Agent or submitting model requests", async () => {
    const { directory, file, credentials } = await fixture();
    await loadDaemonLocalEnv(file, credentials);
    const request = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", request);
    const initializeRuntime = vi.fn(async () => createLocalModelRuntime(credentials, async () => [kunpoRuntimeProvider()]));
    const startSession = vi.spyOn(agentModule, "createPiSession");
    const app = createApp({ dataDirectory: directory, piAgentDirectory: path.join(directory, "pi"), localApiKeyFile: credentials, createModelRuntime: initializeRuntime });
    apps.push(app);
    await app.ready();
    // Startup loads the reviewed local catalog/key cache; this is not an Agent session or a model request.
    expect(initializeRuntime).toHaveBeenCalledOnce();
    const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Local without a key", type: "web-game" } });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json(), selected = project.modelSelections.agent;
    for (const payload of [{ model: selected }, {}]) {
      const response = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload });
      expect(response.statusCode, response.body).toBe(201);
      const detail = await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${response.json().id}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().settings).toEqual({ model: selected, reasoningLevel: "off" });
    }
    await writeFile(path.join(project.workspacePath, "notes.txt"), "Local changes without model credentials");
    const content = await app.inject({ method: "GET", url: `/projects/${project.id}/files/content?path=notes.txt` });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.json().content).toBe("Local changes without model credentials");
    const reopened = await app.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(reopened.statusCode).toBe(200); expect(reopened.json().preview.status).toBe("waiting");
    expect(initializeRuntime).toHaveBeenCalledOnce(); expect(startSession).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    const conversations = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations` })).json();
    const url = `/projects/${project.id}/conversations/${conversations[0].id}`;
    const turn = await app.inject({ method: "POST", url: `${url}/turns`, payload: { prompt: "Do not submit without a key" } });
    expect(turn.statusCode, turn.body).toBe(202);
    await vi.waitFor(async () => {
      const detail = (await app.inject({ method: "GET", url })).json();
      expect(detail.agent).toMatchObject({ status: "error", error: expect.stringContaining("Configure the KunpoAPI key") });
    });
    expect(initializeRuntime).toHaveBeenCalledOnce(); expect(startSession).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", "KUNPO_API_KEY=one\nKUNPO_API_KEY=two\n"],
    ["unknown credential", "KUNPO_API_KEY=\nOPENAI_API_KEY=PRIVATE_CANARY\n"],
    ["unknown setting", "KUNPO_API_KEY=\nDAEMON_HOST=0.0.0.0\n"],
    ["leading whitespace", " KUNPO_API_KEY=literal\n"],
    ["trailing whitespace", "KUNPO_API_KEY=literal \n"],
    ["quoted value", 'KUNPO_API_KEY="literal"\n'],
    ["interpolation", "KUNPO_API_KEY=${PRIVATE_CANARY}\n"],
    ["shell command", "KUNPO_API_KEY=$(echo PRIVATE_CANARY)\n"],
    ["export", "export KUNPO_API_KEY=literal\n"],
    ["missing assignment", "# Only a comment\n"],
    ["inline comment", "KUNPO_API_KEY=literal # comment\n"],
    ["non-ASCII key", "KUNPO_API_KEY=不允许\n"],
  ])("rejects %s without echoing file contents", async (_label, contents) => {
    const { file, credentials } = await fixture(contents);
    const failure = await loadDaemonLocalEnv(file, credentials).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("PRIVATE_CANARY");
    expect((failure as Error).message).not.toContain(contents);
    await expect(readFile(credentials)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects linked, non-private and oversized files", async () => {
    const { directory, file, credentials } = await fixture("KUNPO_API_KEY=literal\n");
    const alias = path.join(directory, "alias.env");
    await symlink(file, alias);
    await expect(loadDaemonLocalEnv(alias, credentials)).rejects.toThrow("not private");
    const hard = path.join(directory, "hard.env");
    await link(file, hard);
    await expect(loadDaemonLocalEnv(file, credentials)).rejects.toThrow("not private");
    await rm(hard);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(loadDaemonLocalEnv(file, credentials)).rejects.toThrow("not private");
      await chmod(file, 0o600);
    }
    await writeFile(file, `#${"x".repeat(33 * 1024)}\nKUNPO_API_KEY=literal\n`);
    await expect(loadDaemonLocalEnv(file, credentials)).rejects.toThrow("not private");
    await expect(loadDaemonLocalEnv("relative.env", credentials)).rejects.toThrow("not private");
  });

  it.skipIf(!process.getuid || process.platform === "win32")("rejects a file not owned by the daemon user", async () => {
    const { file, credentials } = await fixture("KUNPO_API_KEY=literal\n");
    const uid = process.getuid!();
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
    await expect(loadDaemonLocalEnv(file, credentials)).rejects.toThrow("not private");
  });
});
