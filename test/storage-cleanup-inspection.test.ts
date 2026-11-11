import * as fs from "node:fs/promises";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageCleanupService } from "../src/desktop/storage-cleanup.js";

type CommandCallback = (
  error: (Error & { code?: number | string; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;
const execFile = vi.hoisted(() =>
  vi.fn<
    (
      binary: string,
      args: string[],
      options: ExecFileOptions,
      callback: CommandCallback,
    ) => ChildProcess
  >(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile,
}));

interface CommandResponse {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}
const GIT = "/usr/bin/git",
  LSOF = "/usr/sbin/lsof",
  PS = "/bin/ps";
const responses = new Map<string, CommandResponse>();
const directories: string[] = [];

beforeEach(() => {
  responses.clear();
  responses.set(GIT, {});
  responses.set(LSOF, { code: 1 });
  responses.set(`${LSOF}:cwd`, { code: 1 });
  responses.set(PS, {
    stdout: "100 /Applications/OhMyGame.app/Contents/MacOS/Electron\n",
  });
  execFile
    .mockReset()
    .mockImplementation((binary, args, _options, callback) => {
      const response = responses.get(
        binary === LSOF && args.includes("cwd") ? `${LSOF}:cwd` : binary,
      );
      if (!response)
        throw new Error(`No subprocess may run in this fixture: ${binary}`);
      const error =
        response.code || response.killed
          ? Object.assign(new Error("Simulated inspection failure"), {
              code: response.code,
              killed: response.killed,
            })
          : null;
      queueMicrotask(() =>
        callback(error, response.stdout ?? "", response.stderr ?? ""),
      );
      return {} as ChildProcess;
    });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function fixture(cache = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "ohmygame-cleanup-inspection-")),
  );
  directories.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const metadata = path.join(root, ".DS_Store");
  await fs.writeFile(
    metadata,
    Buffer.concat([
      Buffer.from("0000000142756431", "hex"),
      Buffer.from("Finder metadata fixture"),
    ]),
  );
  if (cache) {
    const deps = path.join(root, "node_modules/.vite/deps");
    await fs.mkdir(deps, { recursive: true });
    await fs.writeFile(
      path.join(deps, "generated.js"),
      "export const fixture = true;",
    );
    await fs.writeFile(
      path.join(deps, "_metadata.json"),
      JSON.stringify({
        optimized: { fixture: { file: "generated.js" } },
        chunks: {},
      }),
    );
  }
  const service = new StorageCleanupService({ root, supported: true });
  return { root, metadata, service };
}

describe("storage cleanup default system inspections", () => {
  it("requires successful Git inspection before offering any candidate", async () => {
    const { metadata, service } = await fixture();
    responses.set(GIT, {
      code: 128,
      stderr: "Could not read repository index",
    });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store"),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
    expect(scan.errors).toContainEqual({
      relativePath: ".git",
      reason: "unknown",
    });
    expect(execFile.mock.calls.some(([binary]) => binary === LSOF)).toBe(false);
    expect((await fs.readFile(metadata)).subarray(4, 8).toString()).toBe(
      "Bud1",
    );
  });

  it("does not trust a nominally successful Git command that emitted warnings", async () => {
    const { service } = await fixture();
    responses.set(GIT, {
      stderr: "warning: repository information is incomplete",
    });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store"),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
  });

  it("preserves a tracked Finder file reported by the real Git-check branch", async () => {
    const { service } = await fixture();
    responses.set(GIT, { stdout: ".DS_Store\0" });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store"),
    ).toMatchObject({ state: "blocked", reason: "tracked" });
  });

  it("accepts only lsof's empty exit-1 response as a completed no-open-files check", async () => {
    const { metadata, service } = await fixture();
    const scan = await service.scan();
    const item = scan.items.find(
      (entry) => entry.relativePath === ".DS_Store",
    )!;
    expect(item.state).toBe("eligible");
    const inspectionCount = () =>
      execFile.mock.calls.filter(([binary]) => binary === LSOF).length;
    const afterScan = inspectionCount();
    const plan = await service.plan({
      scanId: scan.scanId,
      itemIds: [item.id],
    });
    expect(inspectionCount()).toBeGreaterThan(afterScan);
    const afterPlan = inspectionCount();
    const result = await service.execute({
      planId: plan.planId,
      confirmationToken: plan.confirmationToken,
      confirmation: "PERMANENT_DELETE",
    });
    expect(inspectionCount()).toBeGreaterThan(afterPlan);
    expect(result.entries[0]?.status).toBe("deleted");
    await expect(fs.stat(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      label: "a traversal warning",
      response: {
        code: 1,
        stderr: "lsof: permission denied while inspecting files",
      },
    },
    { label: "a missing command", response: { code: "ENOENT" } },
    { label: "a timed-out command", response: { code: 1, killed: true } },
    {
      label: "partial output with a failed status",
      response: { code: 1, stdout: "p123\n" },
    },
    { label: "an empty successful response", response: { code: 0 } },
    { label: "an unexpected exit code", response: { code: 2 } },
  ])("keeps files unknown when lsof reports $label", async ({ response }) => {
    const { metadata, service } = await fixture();
    responses.set(LSOF, response);
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store"),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
    expect((await fs.readFile(metadata)).subarray(4, 8).toString()).toBe(
      "Bud1",
    );
  });

  it("keeps files that lsof identifies as open", async () => {
    const { metadata, service } = await fixture();
    responses.set(LSOF, { stdout: `p123\nn${metadata}\n` });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === ".DS_Store"),
    ).toMatchObject({ state: "blocked", reason: "in-use" });
  });

  it.each(["vite", "vitest", "tsc"])(
    "keeps tool caches when ps reports %s even though lsof finds no open files",
    async (tool) => {
      const { root, service } = await fixture(true);
      responses.set(PS, {
        stdout: `321 /usr/local/bin/node ${root}/node_modules/${tool}/bin/${tool}.js\n`,
      });
      const scan = await service.scan();
      expect(
        scan.items.find((item) => item.relativePath === "node_modules/.vite"),
      ).toMatchObject({ state: "blocked", reason: "running" });
      expect(responses.get(LSOF)).toEqual({ code: 1 });
    },
  );

  it.each([
    { label: "no process data", response: {} },
    {
      label: "an inspection warning",
      response: {
        stdout: "Electron\n",
        stderr: "warning: partial process list",
      },
    },
    { label: "a failed command", response: { code: 1 } },
  ])(
    "keeps tool caches unknown when ps returns $label",
    async ({ response }) => {
      const { service } = await fixture(true);
      responses.set(PS, response);
      const scan = await service.scan();
      expect(
        scan.items.find((item) => item.relativePath === "node_modules/.vite"),
      ).toMatchObject({ state: "blocked", reason: "unknown" });
    },
  );

  it("offers recognized inactive cache entries when both process and open-file inspection succeed", async () => {
    const { service } = await fixture(true);
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite"),
    ).toMatchObject({ state: "eligible" });
    expect(execFile.mock.calls.some(([binary]) => binary === PS)).toBe(true);
    expect(execFile.mock.calls.some(([binary]) => binary === LSOF)).toBe(true);
  });

  it.each(["root", "ancestor", "descendant"])(
    "keeps caches when a generic Node script's cwd is the project %s",
    async (kind) => {
      const { root, service } = await fixture(true);
      responses.set(PS, {
        stdout: "321 /usr/local/bin/node custom-dev-server.js\n",
      });
      const cwdPath =
        kind === "root"
          ? root
          : kind === "ancestor"
            ? path.dirname(root)
            : path.join(root, "nested-fixture");
      responses.set(`${LSOF}:cwd`, { stdout: `p321\nn${cwdPath}\n` });
      const scan = await service.scan();
      expect(
        scan.items.find((item) => item.relativePath === "node_modules/.vite"),
      ).toMatchObject({ state: "blocked", reason: "running" });
      const cwd = execFile.mock.calls.find(
        ([binary, args]) => binary === LSOF && args.includes("cwd"),
      );
      expect(cwd?.[1]).toEqual(["-nP", "-a", "-p", "321", "-d", "cwd", "-Fpn"]);
    },
  );

  it("keeps caches when a generic Node command directly names a project script", async () => {
    const { root, service } = await fixture(true);
    responses.set(PS, {
      stdout: `321 /usr/local/bin/node ${root}/custom-dev-server.js\n`,
    });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite"),
    ).toMatchObject({ state: "blocked", reason: "running" });
  });

  it("allows known caches when a generic Node script has a verified unrelated cwd", async () => {
    const { root, service } = await fixture(true);
    responses.set(PS, {
      stdout: "321 /usr/local/bin/node unrelated-helper.js\n",
    });
    responses.set(`${LSOF}:cwd`, {
      stdout: `p321\nn${root}-unrelated-fixture\n`,
    });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite"),
    ).toMatchObject({ state: "eligible" });
  });

  it.each(["missing cwd", "inspection failed", "partial process mapping"])(
    "keeps caches unknown when generic Node inspection has %s",
    async (kind) => {
      const { root, service } = await fixture(true);
      responses.set(PS, {
        stdout:
          "321 /usr/local/bin/node helper.js\n322 /usr/local/bin/bun runner.js\n",
      });
      responses.set(
        `${LSOF}:cwd`,
        kind === "inspection failed"
          ? { code: 1, stderr: "Could not inspect process cwd" }
          : kind === "missing cwd"
            ? { stdout: "p321\np322\n" }
            : { stdout: `p321\nn${root}-unrelated-fixture\n` },
      );
      const scan = await service.scan();
      expect(
        scan.items.find((item) => item.relativePath === "node_modules/.vite"),
      ).toMatchObject({ state: "blocked", reason: "unknown" });
    },
  );

  it("does not trust malformed ps output as an absence of build tools", async () => {
    const { service } = await fixture(true);
    responses.set(PS, {
      stdout: "unexpected ps output without a process ID\n",
    });
    const scan = await service.scan();
    expect(
      scan.items.find((item) => item.relativePath === "node_modules/.vite"),
    ).toMatchObject({ state: "blocked", reason: "unknown" });
  });

  it("uses fixed binaries, no shell, bounded output and a credential-free environment", async () => {
    vi.stubEnv("KUNPO_API_KEY", "synthetic-inspection-canary");
    vi.stubEnv("NODE_OPTIONS", "synthetic-untrusted-option");
    vi.stubEnv("GIT_CONFIG_COUNT", "99");
    const { root, service } = await fixture(true);
    await service.scan();
    const git = execFile.mock.calls.find(([binary]) => binary === GIT)!;
    expect(git[1]).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
    ]);
    for (const [binary, args, options] of execFile.mock.calls) {
      expect([GIT, LSOF, PS]).toContain(binary);
      expect(options.shell).not.toBe(true);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(15_000);
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(options.env).toEqual({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      });
      if (binary === LSOF) {
        expect(args.slice(0, 3)).toEqual(["-nP", "-Fpn", "--"]);
        expect(args.slice(3).every((file) => file.startsWith(`${root}/`))).toBe(
          true,
        );
      }
      if (binary === PS) expect(args).toEqual(["-axo", "pid=,args="]);
    }
  });
});
