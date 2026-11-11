import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  chmod,
  mkdir,
  rename,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { model3DJournal } from "../src/daemon/model3d-journal.js";
import { Model3DGenerationError } from "../src/daemon/model3d.js";

const interception = vi.hoisted(() => ({
  beforeWrite: undefined as
    | undefined
    | ((
        file: string,
        bytes: Uint8Array,
        partial: (bytes: Uint8Array) => Promise<void>,
      ) => Promise<void>),
  beforeSync: undefined as undefined | ((file: string) => Promise<void>),
  afterRename: undefined as
    undefined | ((source: string, target: string) => Promise<void>),
  events: [] as string[],
  uuid: undefined as string | undefined,
}));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => interception.uuid ?? actual.randomUUID(),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        file = String(args[0]);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile")
            return async (bytes: Uint8Array) => {
              await interception.beforeWrite?.(file, bytes, (part) =>
                target.writeFile(part),
              );
              await target.writeFile(bytes);
              interception.events.push(`write:${file}`);
            };
          if (key === "sync")
            return async () => {
              await interception.beforeSync?.(file);
              await target.sync();
              interception.events.push(`sync:${file}`);
            };
          if (key === "close")
            return async () => {
              await target.close();
              interception.events.push(`close:${file}`);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      interception.events.push(`rename:${String(args[1])}`);
      await interception.afterRename?.(String(args[0]), String(args[1]));
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      interception.events.push(`link:${String(args[1])}`);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  interception.beforeWrite = undefined;
  interception.beforeSync = undefined;
  interception.afterRename = undefined;
  interception.uuid = undefined;
  interception.events.length = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function journals() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-journal-"));
  directories.push(directory);
  return {
    directory,
    first: await model3DJournal(directory, "shared"),
    second: await model3DJournal(directory, "shared"),
  };
}

async function journalProcesses() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-3d-processes-"),
  );
  directories.push(directory);
  const source = pathToFileURL(
      path.resolve("src/daemon/model3d-journal.ts"),
    ).href,
    script = path.join(directory, "worker.mjs");
  await writeFile(
    script,
    `
    import { model3DJournal } from ${JSON.stringify(source)};
    const [directory, mode, body] = process.argv.slice(2);
    const journal = await model3DJournal(directory, "shared");
    let networkCalls = 0;
    globalThis.fetch = () => { networkCalls++; throw new Error("Network is forbidden in this synthetic fixture"); };
    const go = new Promise(resolve => process.once("message", resolve));
    process.send({type:"ready"}); await go;
    const release = () => new Promise(resolve => process.once("message", resolve));
    let result;
    try {
      if (mode === "submit") {
        const value = await journal.submitted("first", "synthetic-scope", {source:"same"}, async () => {
          const gate = release(); process.send({type:"create"}); await gate; return {taskId:"synthetic-paid"};
        });
        result = {ok:true, taskId:value.taskId};
      } else {
        const value = await journal.result("generate", "synthetic-task", async () => {
          const gate = release(); process.send({type:"downloaded"}); await gate; return Buffer.from(body);
        });
        result = {ok:true, body:value.toString()};
      }
    } catch (cause) { result = {ok:false, statusCode:cause.statusCode}; }
    await new Promise(resolve => process.send({type:"result", ...result, networkCalls}, resolve));
    process.disconnect();
  `,
    { mode: 0o600 },
  );
  const children: ChildProcess[] = [];
  const start = (mode: "submit" | "result", body = "") => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        script,
        directory,
        mode,
        body,
      ],
      {
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: directory,
          TMPDIR: directory,
          TSX_DISABLE_CACHE: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        detached: process.platform !== "win32",
      },
    );
    children.push(child);
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    let stderr = "";
    child.on("message", (value) =>
      messages.push(value as (typeof messages)[number]),
    );
    child.stderr!.on("data", (value) => {
      stderr += value;
    });
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.platform === "win32"
            ? child.kill("SIGKILL")
            : process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The owned fixture already exited. */
        }
      }
    }, 15_000);
    const finished = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Synthetic journal worker exited ${code}: ${stderr.slice(-1500)}`,
              ),
            );
      });
    });
    void finished.catch(() => {});
    return {
      child,
      messages,
      finished,
      wait: async (type: string) => {
        let message: (typeof messages)[number] | undefined;
        await vi.waitFor(
          () => {
            message = messages.find((value) => value.type === type);
            expect(message, stderr).toBeDefined();
          },
          { timeout: 10_000, interval: 20 },
        );
        return message!;
      },
    };
  };
  return {
    directory,
    start,
    close: async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            process.platform === "win32"
              ? child.kill("SIGKILL")
              : process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already closed. */
          }
        }
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                child.once("close", () => resolve()),
              ),
        ),
      );
    },
  };
}

describe("shared 3D recovery journals", () => {
  it("retains downloaded bytes across reopening, retries GET failures, and rejects corrupt or public caches", async () => {
    const { directory, first } = await journals();
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary download failure"))
      .mockResolvedValue(Buffer.from("retained original"));
    await expect(first.result!("generate", "task-1", download)).rejects.toThrow(
      "download failure",
    );
    expect(await first.result!("generate", "task-1", download)).toEqual(
      Buffer.from("retained original"),
    );
    const reopened = await model3DJournal(directory, "shared", true);
    expect(await reopened.result!("generate", "task-1")).toEqual(
      Buffer.from("retained original"),
    );
    await expect(
      reopened.result!("generate", "different-task", download),
    ).rejects.toMatchObject({ statusCode: 409 });
    const file = path.join(directory, "shared.json.generate.result"),
      content = await readFile(file);
    content[content.length - 1] ^= 1;
    await writeFile(file, content);
    await expect(
      reopened.result!("generate", "task-1", download),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(download).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await chmod(file, 0o644);
      await expect(
        reopened.result!("generate", "task-1", download),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
  });
  it("reuses stages saved by another instance after both journals were opened", async () => {
    const { directory, first, second } = await journals();
    const create = vi.fn().mockResolvedValue({ taskId: "paid-preview" });
    const preview = await first.submitted(
      "preview",
      "connection",
      { prompt: "Tower" },
      create,
    );
    expect(
      await second.submitted(
        "preview",
        "connection",
        { prompt: "Tower" },
        create,
      ),
    ).toEqual(preview);
    const refine = vi.fn().mockResolvedValue({ taskId: "paid-refine" });
    await expect(
      second.submitted("refine", "connection", preview, refine),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(refine).not.toHaveBeenCalled();
    expect(
      await first.submitted("refine", "connection", preview, refine),
    ).toEqual({ taskId: "paid-refine" });
    expect(
      await second.submitted("refine", "connection", preview, refine),
    ).toEqual({ taskId: "paid-refine" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(
      Object.keys(
        JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8")),
      ),
    ).toEqual(["preview", "refine"]);
    if (process.platform !== "win32")
      expect(
        (await stat(path.join(directory, "shared.json"))).mode & 0o777,
      ).toBe(0o600);
    expect(await readdir(directory)).toEqual(["shared.json"]);
  });

  it("waits for an in-flight paid submission and reuses its confirmed credentials", async () => {
    const { directory, first, second } = await journals();
    let release!: (value: { taskId: string }) => void;
    const response = new Promise<{ taskId: string }>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(() => response);
    const original = first.submitted("preview", "connection", {}, create);
    try {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const copy = second.submitted("preview", "connection", {}, create);
      // A separate recovery ID must remain free to submit while this one waits.
      const independent = await model3DJournal(directory, "independent");
      await expect(
        independent.submitted("preview", "connection", {}, async () => ({
          taskId: "other",
        })),
      ).resolves.toEqual({ taskId: "other" });
      release({ taskId: "paid-preview" });
      expect(await Promise.all([original, copy])).toEqual([
        { taskId: "paid-preview" },
        { taskId: "paid-preview" },
      ]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      release?.({ taskId: "paid-preview" });
      await original;
    }
  });

  it("preserves concurrent stages from the original owner but stops a copied journal from spending on missing stages", async () => {
    const { directory, first, second } = await journals();
    const spend = vi.fn(async () => ({ taskId: "unintended-paid-2" }));
    const result = await Promise.allSettled([
      first.submitted("first", "connection", {}, async () => ({
        taskId: "paid-1",
      })),
      second.submitted("second", "connection", {}, spend),
    ]);
    expect(result[0]).toMatchObject({ status: "fulfilled" });
    expect(result[1]).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409 },
    });
    expect(spend).not.toHaveBeenCalled();
    await Promise.all([
      first.submitted("second", "connection", {}, async () => ({
        taskId: "paid-2",
      })),
      first.submitted("third", "connection", {}, async () => ({
        taskId: "paid-3",
      })),
    ]);
    const entries = JSON.parse(
      await readFile(path.join(directory, "shared.json"), "utf8"),
    );
    expect(entries).toMatchObject({
      first: { credentials: { taskId: "paid-1" } },
      second: { credentials: { taskId: "paid-2" } },
      third: { credentials: { taskId: "paid-3" } },
    });
  });

  it("does not leave an ambiguous paid marker for cancellation proved to precede any upload", async () => {
    const { directory, first, second } = await journals();
    await expect(
      first.submitted("image-upload", "connection", {}, async () => {
        throw new Model3DGenerationError(
          "Cancelled before transport",
          499,
          true,
        );
      }),
    ).rejects.toMatchObject({ statusCode: 499 });
    expect(
      JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8")),
    ).toEqual({});
    await expect(
      second.submitted("image-upload", "connection", {}, async () => ({
        token: "new-reference",
      })),
    ).resolves.toEqual({ token: "new-reference" });
  });

  it("rejects a changed fingerprint even in an instance opened before submission", async () => {
    const { first, second } = await journals();
    await first.submitted("preview", "original", {}, async () => ({
      taskId: "paid",
    }));
    const create = vi.fn();
    await expect(
      second.submitted("preview", "changed", {}, create),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks a queued retry after an ambiguous submission", async () => {
    const { first, second } = await journals();
    const create = vi.fn().mockRejectedValue(new Error("lost POST response"));
    const results = await Promise.allSettled([
      first.submitted("preview", "connection", {}, create),
      second.submitted("preview", "connection", {}, create),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { message: "lost POST response" },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { statusCode: 409 },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows a queued retry after a definite rejection created no paid task", async () => {
    const { first, second } = await journals();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Model3DGenerationError("rate limited", 429))
      .mockResolvedValueOnce({ taskId: "paid" });
    const results = await Promise.allSettled([
      first.submitted("preview", "connection", {}, create),
      second.submitted("preview", "connection", {}, create),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { statusCode: 429 },
    });
    expect(results[1]).toEqual({
      status: "fulfilled",
      value: { taskId: "paid" },
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("syncs the pending receipt before create and the confirmed receipt before returning or starting another stage", async () => {
    const { directory, first } = await journals(),
      file = path.join(directory, "shared.json");
    const create = vi.fn(async () => {
      const events = interception.events,
        renamed = events.lastIndexOf(`rename:${file}`);
      expect(renamed).toBeGreaterThan(0);
      expect(events.slice(renamed + 1)).toContain(`sync:${directory}`);
      const temporary = events
        .slice(0, renamed)
        .findLast(
          (event) => event.startsWith("write:") && event.endsWith(".tmp"),
        )!
        .slice(6);
      expect(events.indexOf(`sync:${temporary}`)).toBeLessThan(
        events.indexOf(`close:${temporary}`),
      );
      expect(events.indexOf(`close:${temporary}`)).toBeLessThan(renamed);
      expect(
        JSON.parse(await readFile(file, "utf8")).first.credentials,
      ).toBeUndefined();
      interception.events.push("create:first");
      return { taskId: "synthetic-first" };
    });
    await first.submitted("first", "scope", {}, create);
    const confirmedRename = interception.events.lastIndexOf(`rename:${file}`);
    expect(confirmedRename).toBeGreaterThan(
      interception.events.indexOf("create:first"),
    );
    expect(interception.events.slice(confirmedRename + 1)).toContain(
      `sync:${directory}`,
    );
    await first.submitted("second", "scope", {}, async () => {
      expect(
        JSON.parse(await readFile(file, "utf8")).first.credentials.taskId,
      ).toBe("synthetic-first");
      return { taskId: "synthetic-second" };
    });
    expect(await readdir(directory)).toEqual(["shared.json"]);
  });

  it.each(["pending", "confirmed"] as const)(
    "preserves receipts and stops %s save failures without replaying a possible POST",
    async (phase) => {
      for (const failure of [
        "partial-write",
        "disk-write",
        "file-sync",
        "directory-sync",
      ] as const) {
        const { directory, first } = await journals(),
          file = path.join(directory, "shared.json");
        let posted = false,
          tripped = false,
          renamed = false;
        const selected = () => !tripped && posted === (phase === "confirmed");
        interception.beforeWrite = async (temporary, bytes, partial) => {
          if (
            !temporary.startsWith(`${file}.`) ||
            !selected() ||
            !["partial-write", "disk-write"].includes(failure)
          )
            return;
          tripped = true;
          if (failure === "partial-write")
            await partial(
              bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
            );
          throw Object.assign(new Error("synthetic storage full"), {
            code: "ENOSPC",
          });
        };
        interception.beforeSync = async (target) => {
          if (!selected()) return;
          if (
            (failure === "file-sync" &&
              target.startsWith(`${file}.`) &&
              target.endsWith(".tmp")) ||
            (failure === "directory-sync" && target === directory && renamed)
          ) {
            tripped = true;
            throw Object.assign(new Error("synthetic sync failure"), {
              code: "EIO",
            });
          }
        };
        interception.afterRename = async (_source, target) => {
          if (target === file && selected()) renamed = true;
        };
        const create = vi.fn(async () => {
          posted = true;
          return { taskId: "synthetic-paid" };
        });
        await expect(
          first.submitted("first", "scope", {}, create),
        ).rejects.toMatchObject({ statusCode: 503, notSubmitted: false });
        expect(tripped).toBe(true);
        expect(create).toHaveBeenCalledTimes(phase === "pending" ? 0 : 1);
        interception.beforeWrite = undefined;
        interception.beforeSync = undefined;
        interception.afterRename = undefined;
        expect(
          (await readdir(directory)).some((name) => name.endsWith(".tmp")),
        ).toBe(false);
        if (phase === "confirmed" || failure === "directory-sync") {
          const stored = JSON.parse(await readFile(file, "utf8")),
            retry = vi.fn();
          expect(stored.first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
          const reopened = await model3DJournal(directory, "shared", true);
          if (phase === "confirmed" && failure === "directory-sync")
            await expect(
              reopened.submitted("first", "scope", {}, retry),
            ).resolves.toEqual({ taskId: "synthetic-paid" });
          else
            await expect(
              reopened.submitted("first", "scope", {}, retry),
            ).rejects.toMatchObject({ statusCode: 409 });
          expect(retry).not.toHaveBeenCalled();
        } else
          await expect(readFile(file)).rejects.toMatchObject({
            code: "ENOENT",
          });
      }
    },
  );

  it("never removes a foreign staging file when exclusive creation reports EEXIST", async () => {
    const { directory, first } = await journals(),
      foreign = path.join(directory, "shared.json.foreign.tmp");
    await writeFile(foreign, "foreign evidence", { mode: 0o600 });
    const before = await lstat(foreign);
    interception.uuid = "foreign";
    const create = vi.fn();
    await expect(
      first.submitted("first", "scope", {}, create),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(foreign, "utf8")).toBe("foreign evidence");
    expect((await lstat(foreign)).ino).toBe(before.ino);
  });

  it("retains an unconfirmed lock if its creation directory sync fails before any pending receipt", async () => {
    const { directory, first } = await journals();
    let failed = false;
    interception.beforeSync = async (file) => {
      if (file === directory && !failed) {
        failed = true;
        throw new Error("synthetic lock directory sync failure");
      }
    };
    const create = vi.fn();
    await expect(
      first.submitted("first", "scope", {}, create),
    ).rejects.toMatchObject({ statusCode: 503 });
    interception.beforeSync = undefined;
    const lock = path.join(directory, "shared.json.submission-lock"),
      before = await lstat(lock);
    await expect(
      (await model3DJournal(directory, "shared")).submitted(
        "first",
        "scope",
        {},
        create,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
    expect((await lstat(lock)).ino).toBe(before.ino);
    expect(await readdir(lock)).toEqual([]);
  });

  it("reads confirmed fingerprints through stale locks but never creates a missing stage or clears the stale lock", async () => {
    const { directory, first } = await journals();
    await first.submitted("first", "scope", {}, async () => ({
      taskId: "confirmed",
    }));
    const lock = path.join(directory, "shared.json.submission-lock");
    await mkdir(lock, { mode: 0o700 });
    const before = await lstat(lock);
    const reopened = await model3DJournal(directory, "shared", true),
      create = vi.fn();
    await expect(
      reopened.submitted("first", "scope", {}, create),
    ).resolves.toEqual({ taskId: "confirmed" });
    await expect(
      reopened.submitted("first", "different", {}, create),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      reopened.submitted("missing", "scope", {}, create),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
    expect((await lstat(lock)).ino).toBe(before.ino);
    await expect(
      (await model3DJournal(directory, "another-generation")).submitted(
        "first",
        "scope",
        {},
        async () => ({ taskId: "new-generation" }),
      ),
    ).resolves.toEqual({ taskId: "new-generation" });
  });

  it.each(["replaced", "nonempty"] as const)(
    "does not remove a %s lock or let its former owner spend on a later stage",
    async (fault) => {
      const { directory, first } = await journals(),
        lock = path.join(directory, "shared.json.submission-lock");
      await expect(
        first.submitted("first", "scope", {}, async () => {
          if (fault === "replaced") {
            await rename(lock, `${lock}.retained`);
            await mkdir(lock, { mode: 0o700 });
          } else
            await writeFile(path.join(lock, "foreign"), "retain this evidence");
          return { taskId: "confirmed" };
        }),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect((await lstat(lock)).isDirectory()).toBe(true);
      const create = vi.fn();
      await expect(
        first.submitted("missing", "scope", {}, create),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(create).not.toHaveBeenCalled();
      await expect(
        (await model3DJournal(directory, "shared", true)).submitted(
          "first",
          "scope",
          {},
          create,
        ),
      ).resolves.toEqual({ taskId: "confirmed" });
    },
  );

  it("reads old unpadded result envelopes and aligns new retained bodies without a model-sized concatenation", async () => {
    const { directory, first } = await journals(),
      bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    let taskId = "legacy",
      text = Buffer.from(
        JSON.stringify({
          taskId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    while (text.length % 4 === 0) {
      taskId += "x";
      text = Buffer.from(
        JSON.stringify({
          taskId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(text.length);
    await writeFile(
      path.join(directory, "shared.json.legacy.result"),
      Buffer.concat([header, text, bytes]),
      { mode: 0o600 },
    );
    const old = await first.result!("legacy", taskId);
    expect(old).toEqual(bytes);
    expect(old!.byteOffset % 4).toBe(0);
    const large = Buffer.alloc(2 * 1024 * 1024, 7),
      chunks: number[] = [];
    interception.beforeWrite = async (file, value) => {
      if (file.includes(".new.result.")) chunks.push(value.length);
    };
    await first.result!("new", "new-task", async () => large);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(4);
    expect(chunks[1]! % 4).toBe(0);
    expect(chunks[2]).toBe(large.length);
    const saved = await first.result!("new", "new-task");
    expect(saved).toEqual(large);
    expect(saved!.byteOffset % 4).toBe(0);
  });

  it.each(["partial-body", "file-sync", "directory-sync"] as const)(
    "preserves existing receipts when retained result %s fails",
    async (failure) => {
      const { directory, first } = await journals();
      await first.submitted("first", "scope", {}, async () => ({
        taskId: "known-task",
      }));
      const journal = await readFile(path.join(directory, "shared.json")),
        bytes = Buffer.from("synthetic complete result body");
      let tripped = false;
      interception.beforeWrite = async (file, value, partial) => {
        if (
          !tripped &&
          failure === "partial-body" &&
          file.includes(".generate.result.") &&
          value.length === bytes.length
        ) {
          tripped = true;
          await partial(value.subarray(0, 5));
          throw Object.assign(new Error("synthetic full disk"), {
            code: "ENOSPC",
          });
        }
      };
      interception.beforeSync = async (file) => {
        if (tripped) return;
        if (
          (failure === "file-sync" && file.includes(".generate.result.")) ||
          (failure === "directory-sync" &&
            file === directory &&
            interception.events.includes(
              `link:${path.join(directory, "shared.json.generate.result")}`,
            ))
        ) {
          tripped = true;
          throw new Error("synthetic result sync failure");
        }
      };
      await expect(
        first.result!("generate", "known-task", async () => bytes),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(tripped).toBe(true);
      interception.beforeWrite = undefined;
      interception.beforeSync = undefined;
      expect(await readFile(path.join(directory, "shared.json"))).toEqual(
        journal,
      );
      expect(
        (await readdir(directory)).some((name) => name.endsWith(".tmp")),
      ).toBe(false);
      if (failure === "directory-sync")
        expect(await first.result!("generate", "known-task")).toEqual(bytes);
      else
        expect(await first.result!("generate", "known-task")).toBeUndefined();
    },
  );

  it("admits only one paid create across two independent Node processes that opened the same fresh journal", async () => {
    const fixture = await journalProcesses();
    try {
      const workers = [fixture.start("submit"), fixture.start("submit")];
      await Promise.all(workers.map((worker) => worker.wait("ready")));
      for (const worker of workers) worker.child.send("go");
      await vi.waitFor(
        () =>
          expect(
            workers
              .flatMap((worker) => worker.messages)
              .filter((value) => value.type === "create"),
          ).toHaveLength(1),
        { timeout: 10_000 },
      );
      const winner = workers.find((worker) =>
          worker.messages.some((value) => value.type === "create"),
        )!,
        loser = workers.find((worker) => worker !== winner)!;
      expect(await loser.wait("result")).toMatchObject({
        ok: false,
        statusCode: 409,
        networkCalls: 0,
      });
      expect(
        JSON.parse(
          await readFile(path.join(fixture.directory, "shared.json"), "utf8"),
        ).first.credentials,
      ).toBeUndefined();
      winner.child.send("release");
      expect(await winner.wait("result")).toMatchObject({
        ok: true,
        taskId: "synthetic-paid",
        networkCalls: 0,
      });
      await Promise.all(workers.map((worker) => worker.finished));
      expect(
        workers
          .flatMap((worker) => worker.messages)
          .filter((value) => value.type === "create"),
      ).toHaveLength(1);
      expect(
        (await readdir(fixture.directory)).some((name) =>
          name.endsWith(".submission-lock"),
        ),
      ).toBe(false);
      const create = vi.fn();
      await expect(
        (await model3DJournal(fixture.directory, "shared", true)).submitted(
          "first",
          "synthetic-scope",
          { source: "same" },
          create,
        ),
      ).resolves.toEqual({ taskId: "synthetic-paid" });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  }, 25_000);

  it.each(["identical", "different"] as const)(
    "does not overwrite the first body when separate result publishers downloaded %s content",
    async (content) => {
      const fixture = await journalProcesses();
      try {
        const first = fixture.start("result", "first immutable result"),
          second = fixture.start(
            "result",
            content === "identical"
              ? "first immutable result"
              : "different immutable result",
          );
        await Promise.all([first.wait("ready"), second.wait("ready")]);
        first.child.send("go");
        second.child.send("go");
        await Promise.all([
          first.wait("downloaded"),
          second.wait("downloaded"),
        ]);
        first.child.send("release");
        expect(await first.wait("result")).toMatchObject({
          ok: true,
          body: "first immutable result",
          networkCalls: 0,
        });
        await first.finished;
        const cache = path.join(
            fixture.directory,
            "shared.json.generate.result",
          ),
          before = await readFile(cache);
        second.child.send("release");
        expect(await second.wait("result")).toMatchObject(
          content === "identical"
            ? { ok: true, body: "first immutable result", networkCalls: 0 }
            : { ok: false, statusCode: 409, networkCalls: 0 },
        );
        await second.finished;
        expect(await readFile(cache)).toEqual(before);
        expect((await stat(cache)).nlink).toBe(1);
        expect(
          (await readdir(fixture.directory)).some((name) =>
            name.endsWith(".tmp"),
          ),
        ).toBe(false);
      } finally {
        await fixture.close();
      }
    },
    25_000,
  );
});
