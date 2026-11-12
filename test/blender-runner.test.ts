import { existsSync } from "node:fs";
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
beforeEach(async () => {
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
    const result = await runner.run({ workspace, scriptPath: "model.py", inputs: [], liveView: false, timeoutMs: 30_000 });
    expect(monitor.transientStats).toBe(0);
    expect(monitor.transientDirectories).toBe(0);
    expect(result.files).toEqual([{ path: "report.json", size: 2 }]);
    monitor.missingCompletedOutput = true;
    await expect(runner.run({ workspace, scriptPath: "model.py", inputs: [], liveView: false, timeoutMs: 30_000 })).rejects.toThrow("ENOENT");
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
checks = {}
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
    const failure = await runner
      .run({ workspace, scriptPath: "model.py", inputs: [], invocation })
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
    ).rejects.toThrow("2 GiB resident-memory watchdog");
  }, 20_000);
});
