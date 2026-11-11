import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

async function vmCommand(
  runtimeRoot: string,
  args: string[],
  timeout: number,
): Promise<string> {
  const binary = path.join(runtimeRoot, "tools/lima/bin/limactl");
  const child = spawn(binary, args, {
    cwd: runtimeRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: path.join(runtimeRoot, "home"),
      LIMA_HOME: path.join(runtimeRoot, "lima"),
      XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
      XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
      TMPDIR: path.join(runtimeRoot, "tmp"),
      PATH: `${path.dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SSH: "/usr/bin/ssh -F /dev/null",
    },
  });
  let output = "";
  let failed = false;
  const stop = () => {
    failed = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, timeout);
  try {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 64 * 1024) stop();
    });
    // Lima diagnostics can include host paths. Do not send them to a model or renderer.
    child.stderr!.resume();
    await new Promise<void>((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("The local VM control command could not start")),
      );
      child.once("close", (code) =>
        code === 0 && !failed
          ? resolve()
          : reject(
              new Error("The local VM control command failed or timed out"),
            ),
      );
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export async function readIsolatedVmStatus(
  runtimeRoot: string,
): Promise<"Running" | "Stopped"> {
  const value: unknown = JSON.parse(
    await vmCommand(runtimeRoot, ["list", "--json", "omg"], 15_000),
  );
  const item = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (
    !item ||
    typeof item !== "object" ||
    item.name !== "omg" ||
    !["Running", "Stopped"].includes(item.status)
  )
    throw new Error(
      "The existing isolated VM is unavailable; creation and downloads are disabled",
    );
  return item.status;
}

/** Only the fixed manual source-edition store may acquire this VM lease. */
export class IsolatedVmLifecycle {
  readonly #lock: string;
  readonly #sessionId = randomUUID();
  #starting?: Promise<void>;
  #readySucceeded = false;
  #closing?: Promise<void>;
  #owned = false;
  #locked = false;
  #closed = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly launchId: string,
  ) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        launchId,
      )
    )
      throw new Error(
        "Manual isolated execution requires a local launch identity",
      );
    this.#lock = path.join(runtimeRoot, "manual-vm.lock");
  }

  ready(): Promise<void> {
    if (this.#closed)
      return Promise.reject(new Error("Isolated execution is closing"));
    if (!this.#starting || this.#readySucceeded) {
      this.#readySucceeded = false;
      this.#starting = this.#start().then(() => {
        this.#readySucceeded = true;
      });
    }
    // A rejected start/status remains latched: its outcome needs confirmed cleanup.
    return this.#starting;
  }

  async #command(args: string[], timeout: number): Promise<string> {
    return vmCommand(this.runtimeRoot, args, timeout);
  }

  async #status(): Promise<"Running" | "Stopped"> {
    return readIsolatedVmStatus(this.runtimeRoot);
  }

  async #assertLease(receiptRequired: boolean, state?: "owned"): Promise<void> {
    try {
      const directory = await lstat(this.#lock);
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
          await realpath(this.#lock) !== this.#lock || process.platform !== "win32" &&
          (directory.uid !== process.getuid?.() || (directory.mode & 0o7777) !== 0o700))
        throw new Error();
      const file = path.join(this.#lock, "owner.json");
      let receipt;
      try {
        receipt = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (cause) {
        if (receiptRequired || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      if (receipt) {
        try {
          const before = await receipt.stat();
          if (!before.isFile() || before.nlink !== 1 || before.size > 4096 || process.platform !== "win32" &&
              (before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o600))
            throw new Error();
          const value = JSON.parse(await receipt.readFile("utf8"));
          if (!value || value.version !== 1 || value.instance !== "omg" || value.sessionId !== this.#sessionId ||
              value.ownerLaunchId !== this.launchId || value.ownerPid !== process.pid || value.ownerParentPid !== process.ppid ||
              !["starting", "owned"].includes(value.state) || state && value.state !== state)
            throw new Error();
          const after = await receipt.stat(), current = await lstat(file);
          for (const key of ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
            if (before[key] !== after[key] || before[key] !== current[key]) throw new Error();
        } finally { await receipt.close(); }
      }
      const current = await lstat(this.#lock);
      if (current.dev !== directory.dev || current.ino !== directory.ino || current.mode !== directory.mode ||
          current.uid !== directory.uid) throw new Error();
    } catch {
      throw new Error("The isolated VM lifecycle lease changed or requires review");
    }
  }

  async #receipt(state: "starting" | "owned"): Promise<void> {
    await this.#assertLease(this.#owned);
    const temporary = path.join(this.#lock, `owner-${this.#sessionId}.tmp`);
    const receipt = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const value = Buffer.from(
        JSON.stringify({
          version: 1,
          instance: "omg",
          ownerPid: process.pid,
          ownerParentPid: process.ppid,
          ownerLaunchId: this.launchId,
          sessionId: this.#sessionId,
          state,
        }),
      );
      await receipt.write(value, 0, value.length, 0);
      await receipt.truncate(value.length);
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    // A crash while updating the state leaves the previous valid ownership receipt.
    await rename(temporary, path.join(this.#lock, "owner.json"));
  }

  async #release(): Promise<void> {
    if (!this.#locked) return;
    await this.#assertLease(this.#owned);
    await rm(path.join(this.#lock, `owner-${this.#sessionId}.tmp`), {
      force: true,
    });
    await rm(path.join(this.#lock, "owner.json"), { force: true });
    await rmdir(this.#lock);
    this.#locked = false;
  }

  async #start(): Promise<void> {
    if (this.#locked) {
      await this.#assertLease(true, "owned");
    } else {
      try {
        await mkdir(this.#lock, { mode: 0o700 });
      } catch {
        throw new Error(
          "The isolated VM has an existing lifecycle lease; finish or clean up that session first",
        );
      }
      this.#locked = true;
    }
    try {
      const status = await this.#status();
      await this.#assertLease(this.#owned, this.#owned ? "owned" : undefined);
      if (status === "Running") {
        if (!this.#owned) await this.#release();
        return;
      }
      if (this.#closed) throw new Error("Isolated execution is closing");
      // Persist the ownership intent before start: a crash has an explicit cleanup receipt.
      await this.#receipt("starting");
      this.#owned = true;
      await this.#command(["start", "--tty=false", "omg"], 120_000);
      if ((await this.#status()) !== "Running")
        throw new Error("The isolated VM did not become ready");
      await this.#receipt("owned");
    } catch (error) {
      if (!this.#owned) await this.#release();
      // A failed start can have started the VM. Keep its receipt until close confirms stop.
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      await this.#starting?.catch(() => {});
      if (this.#owned) {
        await this.#assertLease(true);
        await this.#command(["stop", "omg"], 90_000);
        if ((await this.#status()) !== "Stopped")
          throw new Error(
            "The isolated VM stop could not be confirmed; its ownership receipt was retained",
          );
      }
      await this.#release();
      this.#owned = false;
    })());
  }
}
