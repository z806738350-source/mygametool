import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readSafeProjectFile,
  SafeProjectFileError,
} from "./safe-project-file.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";
import { resolveBlenderWindowBounds } from "./blender-window-bounds.js";
import { blenderLiveViewLabels } from "../shared/blender-live-view-labels.js";

const EXECUTABLE = "/Applications/Blender.app/Contents/MacOS/Blender";
const FILE_LIMIT = 64 * 1024 * 1024;
export interface BlenderLiveViewResult {
  shown: boolean;
  updates: number;
  warning?: string;
}
export interface BlenderLiveView {
  finish(): Promise<BlenderLiveViewResult>;
}

// Only this bundled observer gets window services. Agent scripts keep the background worker's policy.
export function blenderObserverProfile(directory: string): string {
  const quote = JSON.stringify;
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(EXECUTABLE)}))
(allow process-info* sysctl-read)
(allow system-info (info-type "vfs.disk-space"))
(allow file-map-executable (subpath "/System") (subpath "/usr/lib") (subpath "/Applications/Blender.app"))
(allow file-read-metadata)
(allow file-read* ${["/System", "/usr/lib", "/usr/share", "/Library/Apple", "/Library/Fonts", "/Applications/Blender.app", directory].map((value) => `(subpath ${quote(value)})`).join(" ")}
  (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath ${quote(path.join(directory, "home"))}) (subpath ${quote(path.join(directory, "tmp"))}) (literal "/dev/null"))
(allow mach-lookup ${["com.apple.system.logger", "com.apple.system.opendirectoryd.libinfo", "com.apple.FontObjectsServer", "com.apple.windowserver.active", "com.apple.CARenderServer", "com.apple.CoreDisplay.master", "com.apple.CoreDisplay.Notification", "com.apple.lsd.mapdb", "com.apple.coreservices.launchservicesd", "com.apple.coreservices.appleevents", "com.apple.window_proxies", "com.apple.windowmanager.server"].map((value) => `(global-name ${quote(value)})`).join(" ")}
  (xpc-service-name "com.apple.MTLCompilerService") (xpc-service-name "com.apple.hiservices-xpcservice") (xpc-service-name "com.apple.ViewBridgeAuxiliary"))
(allow mach-register (local-name "com.apple.axserver") (local-name "com.apple.coredrag") (local-name "com.apple.tsm.portname"))
(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "IOSurfaceSendRight" "IOAccelerationUserClient" "AGXDeviceUserClient"))
`;
}

// No Agent Python runs here. Scene scripts are disabled and the observer can only write its own temporary preferences.
const OBSERVER = `import bpy, json, os, resource, blf
from pathlib import Path
root = Path(__file__).parent
labels = json.loads((root / 'view-config.json').read_text())['labels']
resource.setrlimit(resource.RLIMIT_FSIZE, (${FILE_LIMIT}, ${FILE_LIMIT}))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
resource.setrlimit(resource.RLIMIT_CPU, (330, 330))
bpy.context.preferences.view.show_splash = False
bpy.context.preferences.filepaths.save_version = 0
bpy.context.preferences.filepaths.use_auto_save_temporary_files = False
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
sequence = 0
label = labels['waiting']
updated = ""
def ready(value):
    pending = root / 'home' / 'ready.pending.json'
    pending.write_text(json.dumps({'sequence': value, 'windows': len(bpy.context.window_manager.windows)}))
    os.replace(pending, root / 'home' / 'ready.json')
def draw():
    blf.position(0, 18, 42, 0)
    blf.size(0, 16)
    blf.color(0, 1.0, 1.0, 1.0, 1.0)
    blf.draw(0, label)
    blf.position(0, 18, 20, 0)
    blf.size(0, 12)
    blf.draw(0, updated)
bpy.types.SpaceView3D.draw_handler_add(draw, (), 'WINDOW', 'POST_PIXEL')
def tick():
    global sequence, label, updated
    if (root / 'stop.json').exists():
        bpy.ops.wm.quit_blender()
        return None
    try:
        # Acknowledge the previous tick: the UI had a chance to draw that scene.
        ready(sequence)
        status = json.loads((root / 'status.json').read_text())
        if status.get('error'):
            label = labels['unavailable']
        elif status['sequence'] != sequence:
            bpy.ops.wm.open_mainfile(filepath=str(root / 'scene.blend'), load_ui=False, use_scripts=False)
            bpy.context.preferences.view.show_splash = False
            for window in bpy.context.window_manager.windows:
                for area in window.screen.areas:
                    if area.type != 'VIEW_3D':
                        continue
                    area.spaces.active.shading.type = 'SOLID'
                    area.spaces.active.shading.color_type = 'TEXTURE'
                    region = next((r for r in area.regions if r.type == 'WINDOW'), None)
                    if region:
                        with bpy.context.temp_override(window=window, area=area, region=region):
                            bpy.ops.view3d.view_all(center=False)
                    area.tag_redraw()
            sequence = status['sequence']
            label = "Blender | " + status['label']
            updated = status['updatedAt']
    except FileNotFoundError:
        pass
    except Exception as error:
        label = labels['sceneUnavailable']
        (root / 'home' / 'error.txt').write_text(str(error)[:1000])
    return 0.25
bpy.app.timers.register(tick, first_interval=0.1, persistent=True)
`;

async function optionalFile(root: string, name: string, limit: number) {
  return readSafeProjectFile(root, path.join(root, name), limit).catch(
    (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        (error instanceof SafeProjectFileError && error.statusCode === 409)
      )
        return undefined;
      throw error;
    },
  );
}

/** The worker's files and success receipts are independent of this best-effort, per-job display. */
export async function startBlenderLiveView(
  jobDirectory: string,
  checkResources: (child: ChildProcess, directory: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<BlenderLiveView> {
  const directory = path.join(
    path.dirname(jobDirectory),
    ".live-view",
    path.basename(jobDirectory),
  );
  const result: BlenderLiveViewResult = { shown: false, updates: 0 };
  let child: ChildProcess | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined,
    closing: Promise<BlenderLiveViewResult> | undefined,
    terminating: Promise<void> | undefined;
  let sent = 0,
    received = 0,
    log = "",
    active = true,
    owned = false;
  const warn = (error: unknown) => {
    result.warning ??=
      error instanceof Error ? error.message : "Blender live view unavailable";
  };
  const stopped = () =>
    !child || child.exitCode !== null || child.signalCode !== null;
  const receipt = async () => {
    const bytes = await optionalFile(directory, "home/ready.json", 1024);
    if (!bytes) return false;
    const ready = JSON.parse(bytes.toString("utf8"));
    if (
      !Number.isSafeInteger(ready.sequence) ||
      ready.sequence < 0 ||
      !(ready.windows > 0)
    )
      return false;
    if (ready.sequence > received && ready.sequence <= sent) {
      received = ready.sequence;
      result.updates++;
    }
    return true;
  };
  const sync = async () => {
    if (!active || stopped()) return;
    await checkResources(child!, directory);
    await receipt();
    const bytes = await optionalFile(
      jobDirectory,
      "tmp/live/status.json",
      4096,
    );
    if (!bytes) return;
    const status = JSON.parse(bytes.toString("utf8"));
    if (typeof status.error === "string") {
      warn(
        new Error(
          "The Blender scene preview stopped updating; production continues",
        ),
      );
      return;
    }
    if (
      !Number.isSafeInteger(status.sequence) ||
      status.sequence <= 0 ||
      typeof status.label !== "string" ||
      status.label.length > 160 ||
      typeof status.updatedAt !== "string" ||
      status.updatedAt.length > 64
    )
      throw new Error("Invalid Blender live scene status");
    if (status.sequence <= sent) return;
    const scene = await optionalFile(
      jobDirectory,
      "tmp/live/scene.blend",
      FILE_LIMIT,
    );
    if (!scene) return;
    if (scene.toString("ascii", 0, 7) !== "BLENDER")
      throw new Error("Invalid Blender live scene file");
    await writeFile(path.join(directory, "scene.pending.blend"), scene, {
      mode: 0o400,
    });
    await rename(
      path.join(directory, "scene.pending.blend"),
      path.join(directory, "scene.blend"),
    );
    await writeFile(
      path.join(directory, "status.pending.json"),
      JSON.stringify(status),
      { mode: 0o400 },
    );
    await rename(
      path.join(directory, "status.pending.json"),
      path.join(directory, "status.json"),
    );
    sent = status.sequence;
  };
  const terminate = () =>
    (terminating ??= child
      ? terminateProjectProcess(child).catch(warn)
      : Promise.resolve());
  const abort = () => {
    active = false;
    void terminate();
  };
  const finish = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      await pending;
      if (active && !stopped()) {
        await sync().catch(warn);
        const deadline = Date.now() + 1500;
        while (
          received < sent &&
          !signal?.aborted &&
          !stopped() &&
          Date.now() < deadline
        ) {
          await receipt().catch(warn);
          if (received < sent)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (received < sent && !signal?.aborted)
          warn(
            new Error(
              "The last Blender scene was not confirmed by the work window",
            ),
          );
      }
      active = false;
      if (child) {
        await writeFile(path.join(directory, "stop.json"), "{}", {
          mode: 0o400,
        }).catch(warn);
        const deadline = Date.now() + 1000;
        while (!stopped() && !signal?.aborted && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        await terminate();
      }
      await writeFile(
        path.join(jobDirectory, "live-view.json"),
        JSON.stringify(result),
        { mode: 0o600 },
      ).catch(() => {});
      if (log)
        await writeFile(path.join(jobDirectory, "live-view.log"), log, {
          mode: 0o600,
        }).catch(() => {});
      if (
        owned &&
        (await realpath(directory).catch(() => undefined)) === directory
      )
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      return result;
    })());
  try {
    const parent = path.dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await realpath(parent)) !== parent)
      throw new Error("Linked Blender work-window storage is unavailable");
    await mkdir(directory, { mode: 0o700 });
    owned = true;
    for (const name of ["home", "tmp"])
      await mkdir(path.join(directory, name), { mode: 0o700 });
    await writeFile(path.join(directory, "observer.py"), OBSERVER, {
      flag: "wx",
      mode: 0o400,
    });
    const bounds = await resolveBlenderWindowBounds();
    await writeFile(
      path.join(directory, "view-config.json"),
      JSON.stringify({
        labels: blenderLiveViewLabels[bounds?.language ?? "en"],
      }),
      { flag: "wx", mode: 0o400 },
    );
    signal?.throwIfAborted();
    child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        blenderObserverProfile(directory),
        EXECUTABLE,
        "--factory-startup",
        "--disable-autoexec",
        "-noaudio",
        "--window-geometry",
        ...[
          bounds?.x ?? 500,
          bounds?.y ?? 120,
          bounds?.width ?? 640,
          bounds?.height ?? 480,
        ].map(String),
        "--threads",
        "2",
        "--python-exit-code",
        "1",
        "--python",
        path.join(directory, "observer.py"),
      ],
      {
        cwd: directory,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: path.join(directory, "home"),
          TMPDIR: path.join(directory, "tmp"),
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          PYTHONNOUSERSITE: "1",
          BLENDER_USER_CONFIG: path.join(directory, "home"),
          BLENDER_USER_SCRIPTS: path.join(directory, "home"),
        },
      },
    );
    registerProjectProcess(child);
    child.on("error", warn);
    child.on("close", () => {
      if (active && result.shown)
        warn(
          new Error(
            "The Blender work window closed; production continued in the background",
          ),
        );
    });
    const capture = (bytes: Buffer) => {
      log = (log + bytes.toString("utf8")).slice(-8192);
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + 12_000;
    let checkedAt = 0;
    while (!stopped() && !signal?.aborted && Date.now() < deadline) {
      if (Date.now() - checkedAt >= 1000) {
        await checkResources(child, directory);
        checkedAt = Date.now();
      }
      if (await receipt()) {
        result.shown = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result.shown)
      throw new Error(
        "Blender work window could not open; production continues in the background",
      );
    timer = setInterval(() => {
      if (pending || !active || stopped()) return;
      pending = sync()
        .catch((error) => {
          warn(error);
          abort();
        })
        .finally(() => {
          pending = undefined;
        });
    }, 500);
  } catch (error) {
    warn(error);
    await finish();
  }
  return { finish };
}
