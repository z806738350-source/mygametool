import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicLevel } from "classic-level";
import { ProjectLifecycle } from "../src/daemon/project-lifecycle.js";
import { compactProjectBrowserStorage } from "../src/desktop/project-browser-storage.js";
import { PROJECT_BROWSER_CLEANUP_DIRECTORY } from "../src/shared/project-browser-storage.js";
// @ts-ignore The import-safe MJS launcher intentionally has no declaration file.
import { assertBrowserStorageRestored, launchEnvironment, launchPaths, protectEnvMetadata } from "../scripts/local-launch.mjs";

const directories: string[] = [];
const script = new URL("../scripts/local-launch.mjs", import.meta.url);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-launcher-unit-"));
  directories.push(directory);
  return directory;
}

it("rewrites retired browser keys after the app closes and preserves binary data for live projects and other origins", async () => {
  const root = await temporary();
  const deleted = "11111111-1111-4111-8111-111111111111";
  const retained = "22222222-2222-4222-8222-222222222222";
  const projects = path.join(root, "projects");
  const queue = path.join(root, PROJECT_BROWSER_CLEANUP_DIRECTORY);
  const live = path.join(root, "desktop", "browser", "Local Storage", "leveldb");
  await mkdir(path.join(projects, retained), { recursive: true });
  await mkdir(path.dirname(live), { recursive: true });
  const openDatabase = () => new ClassicLevel<Buffer, Buffer>(live, { keyEncoding: "buffer", valueEncoding: "buffer" });
  const key = (value: string) => Buffer.from(`_file://\0\x01${value}`);
  const old = key(`canvas-active:${deleted}`);
  const late = Buffer.concat([Buffer.from("_file://\0\x00"), Buffer.from(`canvas-board:${deleted}:草稿`, "utf16le")]);
  const keep = [key("ohmygame:appearance"), key(`canvas-active:${retained}`), Buffer.from(`_https://example.invalid\0\x01canvas-active:${deleted}`)];
  const opaqueValue = Buffer.from([0, 165, 255]);
  const database = openDatabase();
  try {
    await database.put(old, Buffer.from("old local board"));
    await database.del(old);
    await database.put(late, Buffer.from("draft from an interrupted delete"));
    for (const k of keep) await database.put(k, opaqueValue);
  } finally { await database.close(); }
  const allBytes = async () => Buffer.concat(await Promise.all((await readdir(live)).map((name) => readFile(path.join(live, name)))));
  expect((await allBytes()).includes(old)).toBe(true);
  const lifecycle = new ProjectLifecycle(root);
  await lifecycle.scheduleBrowserCleanup(deleted);
  await lifecycle.scheduleBrowserCleanup(retained);
  // Recover a quit interrupted between the two renames, then finish the pending rewrite.
  await rename(live, live + ".project-cleanup-previous");
  const paths = { profile: path.join(root, "desktop") };
  await expect(assertBrowserStorageRestored(paths)).rejects.toThrow("浏览器设置库还未恢复");
  await compactProjectBrowserStorage(root);
  await expect(assertBrowserStorageRestored(paths)).resolves.toBeUndefined();
  const rewritten = await allBytes();
  expect(rewritten.includes(old)).toBe(false);
  expect(rewritten.includes(late)).toBe(false);
  expect(await readdir(queue)).toEqual([retained]);
  const reopened = openDatabase();
  try {
    for (const k of keep) expect(await reopened.get(k)).toEqual(opaqueValue);
    expect(await reopened.get(late)).toBeUndefined();
  } finally { await reopened.close(); }
});

describe("local source launcher boundaries", () => {
  it("keeps paths with spaces inside the dedicated project runtime", () => {
    const root = "/tmp/OhMyGame project with spaces";
    const paths = launchPaths(root);
    expect(paths).toMatchObject({ root, envFile: path.join(root, ".env"), tools: path.join(root, ".runtime/toolchain"), socket: path.join(root, ".runtime/local-launch/control.sock") });
    for (const value of Object.values(paths)) expect(path.relative(root, value as string)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(paths.profile).toBe(path.join(root, ".runtime/local-execution/manual-data/desktop"));
  });

  it("builds a fresh environment without host keys, proxies, startup hooks or HOME", () => {
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "KUNPO_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "SSH_AUTH_SOCK", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_USERCONFIG"])
      vi.stubEnv(name, `fake-inherited-${name}`);
    vi.stubEnv("HOME", "/tmp/fake host home");
    vi.stubEnv("PATH", "/tmp/fake host bin");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    const paths = launchPaths("/tmp/OhMyGame with spaces");
    const environment = launchEnvironment(paths);
    expect(environment).toEqual({ HOME: paths.home, TMPDIR: paths.tmp, XDG_CONFIG_HOME: path.join(paths.home, "config"), XDG_CACHE_HOME: path.join(paths.home, "cache"), LANG: "zh_CN.UTF-8", PATH: `${path.join(paths.tools, "node/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, OHMYGAME_DATA_DIR: paths.data, PI_CODING_AGENT_DIR: path.join(paths.data, "pi-agent"), PI_OFFLINE: "1" });
    expect(Object.values(environment).join("\n")).not.toContain("fake-inherited-");
    expect(environment.HOME).not.toBe(process.env.HOME);
    expect(environment.NODE_OPTIONS).toBeUndefined();
  });

  it("tightens an owned credential fixture to 0600 without changing its contents", async () => {
    const file = path.join(await temporary(), ".env");
    await writeFile(file, "KUNPO_API_KEY=fake-launcher-fixture-only\n");
    await chmod(file, 0o644);
    await protectEnvMetadata(file);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("KUNPO_API_KEY=fake-launcher-fixture-only\n");
  });

  it("rejects a credential symlink without changing its target permissions", async () => {
    const directory = await temporary(), target = path.join(directory, "target"), file = path.join(directory, ".env");
    await writeFile(target, "fake-only"); await chmod(target, 0o644); await symlink(target, file);
    await expect(protectEnvMetadata(file)).rejects.toBeDefined();
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
  });

  it("rejects a multiply linked credential file without chmodding either name", async () => {
    const directory = await temporary(), target = path.join(directory, "target"), file = path.join(directory, ".env");
    await writeFile(target, "fake-only"); await chmod(target, 0o644); await link(target, file);
    await expect(protectEnvMetadata(file)).rejects.toThrow("普通单链接文件");
    expect((await lstat(file)).nlink).toBe(2);
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
    expect((await lstat(file)).mode & 0o777).toBe(0o644);
  });

  it("rejects a directory used as the credential file", async () => {
    const directory = path.join(await temporary(), ".env");
    await mkdir(directory, { mode: 0o700 });
    await expect(protectEnvMetadata(directory)).rejects.toThrow("普通单链接文件");
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  });

  it("rejects a FIFO before waiting for a writer, in a bounded helper process", async () => {
    const directory = await temporary(), file = path.join(directory, ".env-fifo");
    const environment = { HOME: directory, TMPDIR: directory, PATH: "/usr/bin:/bin" };
    await promisify(execFile)("/usr/bin/mkfifo", [file], { env: environment, timeout: 2_000 });
    expect((await lstat(file)).isFIFO()).toBe(true);
    const code = `const { protectEnvMetadata } = await import(process.argv[1]); try { await protectEnvMetadata(process.argv[2]); process.exitCode = 2; } catch (error) { if (!error.message.includes("普通单链接文件")) throw error; }`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, script.href, file], { env: environment, timeout: 2_000 });
  });

  it.each(["启动 OhMyGame.command", "停止 OhMyGame.command"])("keeps %s independent of shell profiles, host PATH and downloads", async (file) => {
    const content = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    expect(content.split("\n")[0]).toBe("#!/bin/zsh -f");
    expect(content).toContain("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
    expect(content.indexOf("PATH=/usr/bin:/bin")).toBeLessThan(content.indexOf("/usr/bin/dirname"));
    expect(content).toContain('$(/usr/bin/dirname -- "$0")');
    expect(content).not.toMatch(/\$\(dirname\b/);
    expect(content).toContain("exec /usr/bin/env -i HOME=");
    expect(content).toContain('"$NODE" "$PROJECT_DIR/scripts/local-launch.mjs"');
    expect(content).toMatch(/shasum -a 256 "\$NODE"/);
    expect(content).not.toMatch(/^\s*(?:source|eval)\b/m);
    expect(content).not.toMatch(/\b(?:curl|wget|brew|npx|npm|bun|pnpm)\b/);
    expect(content).not.toContain(".env\"");
  });
});
