import { existsSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlenderRunError,
  BlenderRunner,
} from "../src/daemon/blender-runner.js";

const monitor = vi.hoisted(() => ({ rss: undefined as string | undefined, transientStats: 0, transientDirectories: 0, missingCompletedOutput: false }));
const bootstrapTest = vi.hoisted(() => ({
  phases: undefined as string[] | undefined,
  onStart: undefined as ((phase: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const missing = () => Object.assign(new Error("ENOENT: snapshot was atomically replaced"), { code: "ENOENT" });
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]).endsWith("/tmp/atomic.json") && monitor.transientStats > 0) {
        monitor.transientStats--;
        throw missing();
      }
      if (String(args[0]).endsWith("/output/report.json") && monitor.missingCompletedOutput) throw missing();
      return actual.lstat(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]).endsWith("/tmp/atomic-directory") && monitor.transientDirectories > 0) {
        monitor.transientDirectories--;
        throw missing();
      }
      return actual.readdir(...args);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: SpawnOptions) => {
      if (file === "/usr/bin/sandbox-exec") expect(args).toContain("--background");
      if (file === "/usr/bin/sandbox-exec" && bootstrapTest.phases) {
        const phase = options.env?.OHMYGAME_BLENDER_EXPORT_PHASE ?? "single";
        bootstrapTest.phases.push(phase);
        bootstrapTest.onStart?.(phase);
        const bootstrap = args[args.indexOf("--python") + 1]!;
        // Exercise the actual staged bootstrap with tiny stand-in Python, without starting Blender.
        return actual.spawn("/usr/bin/python3", [bootstrap], options);
      }
      return actual.spawn(file, args, options);
    },
    execFile: (...args: unknown[]) => {
      if (args[0] === "/bin/ps" && monitor.rss !== undefined) {
        (args[3] as (error: Error | null, stdout: string) => void)(
          null,
          monitor.rss,
        );
        return;
      }
      return (actual.execFile as (...input: unknown[]) => unknown)(...args);
    },
  };
});

const supported =
  process.platform === "darwin" &&
  existsSync("/Applications/Blender.app/Contents/MacOS/Blender");
let directory: string, workspace: string, runner: BlenderRunner;
it("recovers the bundled stage diagnosis when the log has no traceback", async () => {
  const id = randomUUID();
  const job = path.join(directory, "jobs", id);
  await mkdir(path.join(job, "output"), { recursive: true });
  await writeFile(path.join(job, "failed.json"), JSON.stringify({ id, message: "Blender exited with code 1" }));
  await writeFile(path.join(job, "output", "report.json"), JSON.stringify({ error: "Input contains no meshes" }));
  expect(await runner.inspectJob(id)).toMatchObject({ status: "failed", stageError: "Input contains no meshes" });
  await expect(runner.readJob(id)).rejects.toThrow("Blender exited");
});
beforeEach(async () => {
  bootstrapTest.phases = undefined;
  bootstrapTest.onStart = undefined;
  monitor.rss = undefined;
  monitor.transientStats = 0;
  monitor.transientDirectories = 0;
  monitor.missingCompletedOutput = false;
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-blender-runner-")),
  );
  workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  runner = new BlenderRunner(path.join(directory, "jobs"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ["scene.blend", /previous Blender scene was edited/],
  ["parts.json", /saved Blender configuration changed/],
] as const)("rejects a same-length edit to %s before launching Blender", async (file, message) => {
  vi.spyOn(runner, "status").mockResolvedValue({ available: true, executable: "unused" });
  await writeFile(path.join(workspace, "export.py"), "# unused");
  await writeFile(path.join(workspace, file), "edited-input");
  const originalDigest = createHash("sha256").update("parent-input").digest("hex");
  await expect(runner.run({
    workspace, scriptPath: "export.py", inputs: [file], expectedInputSha256: { [file]: originalDigest },
  })).rejects.toThrow(message);
  expect(await readFile(path.join(workspace, file), "utf8")).toBe("edited-input");
  expect(existsSync(path.join(directory, "jobs"))).toBe(false);
});

describe.skipIf(!existsSync("/usr/bin/python3"))("bundled Blender export workers", () => {
  it.each(["prepare", "verify", "none"])("retains one job with a %s failure point", async (failAt) => {
    vi.spyOn(runner, "status").mockResolvedValue({ available: true, executable: "unused" });
    bootstrapTest.phases = [];
    const entry = `import json, os, resource, sys
from pathlib import Path
def arg(flag):
    return sys.argv[sys.argv.index(flag) + 1]
phase = arg("--export-phase")
state = Path(arg("--export-state"))
output = Path(arg("--output-dir"))
assert state == output.parent / "tmp" / "export-state.json"
cpu = resource.getrlimit(resource.RLIMIT_CPU)[1]
if phase == "prepare":
    state.write_text(json.dumps([os.getpid(), cpu]))
    (output / "asset.glb").write_bytes(b"prepared")
else:
    pid, first_cpu = json.loads(state.read_text())
    assert pid != os.getpid() and 0 < cpu < first_cpu
    assert (output / "asset.glb").read_bytes() == b"prepared"
print("worker-" + phase, flush=True)
if phase == ${JSON.stringify(failAt)}:
    raise RuntimeError("planned failure")
`;
    const job = runner.run({
      workspace, inputs: [], bundledExport: true, args: ["--stage", "export"],
      bundledScripts: { entry: "pipeline.py", files: { "pipeline.py": entry } },
    });
    if (failAt === "none") {
      const result = await job;
      expect(result.files.map(file => file.path)).toEqual(["asset.glb"]);
      expect(result.log).toMatch(/worker-prepare[\s\S]*worker-verify/);
      expect((await runner.inspectJob(result.id)).status).toBe("completed");
    } else {
      const failure = await job.catch(error => error) as BlenderRunError;
      expect(failure).toBeInstanceOf(BlenderRunError);
      expect(failure.message).toContain(`during export ${failAt}`);
      expect((await runner.inspectJob(failure.jobId!)).status).toBe("failed");
      await expect(runner.readJob(failure.jobId!)).rejects.toThrow();
    }
    expect(bootstrapTest.phases).toEqual(failAt === "prepare" ? ["prepare"] : ["prepare", "verify"]);
  });

  it.each(["deadline", "memory"] as const)("stops verification at its job %s limit", async reason => {
    vi.spyOn(runner, "status").mockResolvedValue({ available: true, executable: "unused" });
    bootstrapTest.phases = [];
    monitor.rss = "1024\n";
    const clock = performance.now.bind(performance);
    let elapsed = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock() + elapsed);
    bootstrapTest.onStart = phase => {
      if (phase === "prepare" && reason === "deadline") elapsed = 28_500;
      if (phase === "verify" && reason === "memory") monitor.rss = "2097153\n";
    };
    try {
      const entry = `import sys, time
from pathlib import Path
if sys.argv[sys.argv.index("--export-phase") + 1] == "verify":
    time.sleep(3)
(Path(sys.argv[sys.argv.index("--output-dir") + 1]) / "asset.glb").write_bytes(b"asset")
`;
      const job = runner.run({
        workspace, inputs: [], bundledExport: true, args: ["--stage", "export"], timeoutMs: 30_000,
        bundledScripts: { entry: "pipeline.py", files: { "pipeline.py": entry } },
      });
      const failure = await job.catch(error => error) as BlenderRunError;
      expect(failure).toBeInstanceOf(BlenderRunError);
      expect(failure.message).toMatch(reason === "deadline" ? /timed out/ : /export verify \(sampled RSS 2097153 KiB, limit 2097152 KiB\)/);
      expect(bootstrapTest.phases).toEqual(["prepare", "verify"]);
      expect((await runner.inspectJob(failure.jobId!)).status).toBe("failed");
    } finally {
      now.mockRestore();
    }
  });
});

describe.skipIf(!supported)("controlled local Blender", () => {
  it("tolerates disappearing temporary snapshot entries but keeps completed-output inspection strict", async () => {
    await writeFile(path.join(workspace, "model.py"), `import sys, time
from pathlib import Path
root = Path(__file__).parent.parent
(root / "tmp" / "atomic.json").write_text("{}")
(root / "tmp" / "atomic-directory").mkdir()
time.sleep(1)
output = Path(sys.argv[sys.argv.index("--output-dir") + 1])
(output / "report.json").write_text("{}")
`);
    monitor.transientStats = 1;
    monitor.transientDirectories = 1;
    const result = await runner.run({ workspace, scriptPath: "model.py", inputs: [], timeoutMs: 30_000 });
    expect(monitor.transientStats).toBe(0);
    expect(monitor.transientDirectories).toBe(0);
    expect(result.files).toEqual([{ path: "report.json", size: 2 }]);
    monitor.missingCompletedOutput = true;
    await expect(runner.run({ workspace, scriptPath: "model.py", inputs: [], timeoutMs: 30_000 })).rejects.toThrow("ENOENT");
  }, 40_000);

  it("rejects traversal, credentials, links and invalid limits before starting a job", async () => {
    await writeFile(
      path.join(workspace, "script.py"),
      "raise Exception('must not execute')",
    );
    await writeFile(path.join(workspace, "source.json"), "{}");
    await link(
      path.join(workspace, "source.json"),
      path.join(workspace, "linked.json"),
    );
    await symlink(
      path.join(workspace, "source.json"),
      path.join(workspace, "symbolic.json"),
    );
    const run = (inputs: string[]) =>
      runner.run({ workspace, scriptPath: "script.py", inputs });
    await expect(run(["../outside.json"])).rejects.toThrow("project-relative");
    await expect(run([".env"])).rejects.toThrow("non-private");
    await expect(run(["linked.json"])).rejects.toThrow("non-linked");
    await expect(run(["symbolic.json"])).rejects.toThrow("Linked");
    await expect(run(["a.json", "a.json"])).rejects.toThrow("distinct");
    await expect(run(["common.py"])).rejects.toThrow(/data files only.*common\.py.*single custom script.*scriptPath/);
    await expect(run(["mesh.obj"])).rejects.toThrow(/mesh\.obj.*Supported data files/);
    await expect(
      runner.run({
        workspace,
        scriptPath: "script.py",
        inputs: [],
        timeoutMs: 300_001,
      }),
    ).rejects.toThrow("300 seconds");
    await expect(runner.readJob("../../outside")).rejects.toThrow("job ID");
    expect(existsSync(path.join(directory, "jobs"))).toBe(false);
  });

  it("executes real Blender while denying network, other files, input writes and subprocesses; recovers its exact outputs", async () => {
    const outside = path.join(workspace, "outside.txt");
    await writeFile(outside, "keep this original");
    await writeFile(path.join(workspace, "parts.json"), '{"size": 0.5}');
    await writeFile(
      path.join(workspace, "model.py"),
      `import argparse, bpy, json, os, socket, subprocess, sys
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--input-dir"); p.add_argument("--output-dir")
a = p.parse_args(sys.argv[sys.argv.index("--") + 1:])
output = Path(a.output_dir)
checks = {"headless": bpy.app.background}
def denied(name, operation):
    try:
        operation()
        checks[name] = False
    except (OSError, PermissionError):
        checks[name] = True
denied("outside_read", lambda: Path(${JSON.stringify(outside)}).read_text())
denied("outside_write", lambda: Path(${JSON.stringify(outside)}).write_text("changed"))
denied("input_write", lambda: (Path(a.input_dir) / "parts.json").write_text("changed"))
denied("network", lambda: socket.create_connection(("127.0.0.1", 9), timeout=1))
denied("subprocess", lambda: subprocess.run(["/bin/sh", "-c", "true"], check=True))
denied("blender_subprocess", lambda: subprocess.run(["/Applications/Blender.app/Contents/MacOS/Blender", "--version"], check=True))
try:
    child = os.fork()
    if child == 0: os._exit(0)
    os.waitpid(child, 0)
    checks["fork"] = False
except OSError:
    checks["fork"] = True
checks["fresh_home"] = os.environ["HOME"] != ${JSON.stringify(process.env.HOME)}
checks["input_read"] = json.loads(Path("parts.json").read_text())["size"] == 0.5
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=0.5)
bpy.context.object.name = "WorkflowProp"
bpy.ops.wm.save_as_mainfile(filepath=str(output / "source.blend"))
bpy.ops.export_scene.gltf(filepath=str(output / "asset.glb"), export_format="GLB")
bpy.ops.object.camera_add(location=(2, -2, 2))
camera = bpy.context.object
from mathutils import Vector
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
scene = bpy.context.scene
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
scene.render.resolution_x = 64; scene.render.resolution_y = 64; scene.render.resolution_percentage = 100
scene.render.filepath = str(output / "preview.png")
bpy.ops.render.render(write_still=True)
(output / "checks.json").write_text(json.dumps(checks))
`,
    );
    const result = await runner.run({
      workspace,
      scriptPath: "model.py",
      inputs: ["parts.json"],
      timeoutMs: 60_000,
    });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "asset.glb",
      "checks.json",
      "preview.png",
      "source.blend",
    ]);
    expect(
      JSON.parse(
        await readFile(
          path.join(result.outputDirectory, "checks.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      headless: true,
      outside_read: true,
      outside_write: true,
      input_write: true,
      network: true,
      subprocess: true,
      blender_subprocess: true,
      fork: true,
      fresh_home: true,
      input_read: true,
    });
    expect(await readFile(outside, "utf8")).toBe("keep this original");
    expect(
      (await readFile(path.join(result.outputDirectory, "asset.glb")))
        .subarray(0, 4)
        .toString(),
    ).toBe("glTF");
    expect(await runner.readJob(result.id)).toEqual(result);
  }, 75_000);

  it("retains a failed or cancelled job without approving partial results or touching old assets", async () => {
    await writeFile(
      path.join(workspace, "model.py"),
      "import time\ntime.sleep(30)\n",
    );
    const abort = new AbortController();
    const pending = runner.run(
      { workspace, scriptPath: "model.py", inputs: [], timeoutMs: 60_000 },
      abort.signal,
    );
    const timer = setTimeout(() => abort.abort(), 1500);
    let failure: BlenderRunError | undefined;
    try {
      await pending;
    } catch (error) {
      failure = error as BlenderRunError;
    } finally {
      clearTimeout(timer);
    }
    expect(failure).toBeInstanceOf(BlenderRunError);
    expect(failure?.message).toContain("cancelled");
    expect(failure?.jobId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await runner.inspectJob(failure!.jobId!)).toMatchObject({
      id: failure!.jobId,
      status: "failed",
      message: expect.stringContaining("cancelled"),
    });
    await expect(runner.readJob(failure!.jobId!)).rejects.toThrow();
    expect(await readFile(path.join(workspace, "model.py"), "utf8")).toContain(
      "time.sleep",
    );
  }, 20_000);

  it("retains invocation identity on a real argument failure and supports nested inputs with the documented parser", async () => {
    const invocation = {
      callId: "original",
      sessionFile: "/private/session.jsonl",
      request: { stage: "custom" },
    };
    await writeFile(
      path.join(workspace, "model.py"),
      'import argparse\np = argparse.ArgumentParser()\np.add_argument("--input-dir", required=True)\np.parse_args()\n',
    );
    const workflowRequest = { ...invocation.request, reviewPresentation: "internal" };
    const failure = await runner
      .run({ workspace, scriptPath: "model.py", inputs: [], invocation, workflowRequest })
      .catch((error) => error as BlenderRunError);
    expect(failure).toBeInstanceOf(BlenderRunError);
    const id = (failure as BlenderRunError).jobId!;
    expect(await runner.inspectJob(id)).toMatchObject({
      status: "failed",
      log: expect.stringContaining("--input-dir"),
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "jobs", id, "invocation.json"),
          "utf8",
        ),
      ),
    ).toEqual(invocation);
    expect(JSON.parse(await readFile(path.join(directory, "jobs", id, "workflow.json"), "utf8"))).toEqual(workflowRequest);
    await mkdir(path.join(workspace, "nested"));
    await writeFile(
      path.join(workspace, "nested/source.json"),
      '{"preserved":true}',
    );
    await writeFile(
      path.join(workspace, "model.py"),
      `import argparse, sys
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--input-dir", required=True)
p.add_argument("--output-dir", required=True)
p.add_argument("--input", required=True)
a = p.parse_args(sys.argv[sys.argv.index("--") + 1:])
(Path(a.output_dir) / "report.json").write_bytes((Path(a.input_dir) / a.input).read_bytes())
`,
    );
    const corrected = await runner.run({
      workspace,
      scriptPath: "model.py",
      inputs: ["nested/source.json"],
      args: ["--input", "nested/source.json"],
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(corrected.outputDirectory, "report.json"),
          "utf8",
        ),
      ),
    ).toEqual({ preserved: true });
  }, 30_000);

  it("refuses a symlink output directory instead of reading a path outside its job", async () => {
    await writeFile(
      path.join(workspace, "model.py"),
      `import os, sys
output = sys.argv[sys.argv.index("--output-dir") + 1]
os.rmdir(output)
os.symlink(${JSON.stringify(workspace)}, output)
`,
    );
    await expect(
      runner.run({
        workspace,
        scriptPath: "model.py",
        inputs: [],
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/Linked|exited|limits/);
  }, 40_000);

  it("stops the real Blender process when its fixed memory monitor reports excess RSS", async () => {
    monitor.rss = "2097153\n";
    await writeFile(
      path.join(workspace, "model.py"),
      "import time\ntime.sleep(30)\n",
    );
    await expect(
      runner.run({
        workspace,
        scriptPath: "model.py",
        inputs: [],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/2 GiB resident-memory watchdog during custom script \(sampled RSS 2097153 KiB, limit 2097152 KiB\)/);
  }, 20_000);
});
