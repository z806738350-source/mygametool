import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE_HASH = "2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0";
const MANIFEST_HASH = "5df212444717b1358fb5a6ed5a4c77dd235f0bc7eb988ca8d2ce6ff73cfe62d6";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function launchPaths(root) {
  const control = path.join(root, ".runtime/local-launch");
  const execution = path.join(root, ".runtime/local-execution");
  const data = path.join(execution, "manual-data");
  return { root, control, execution, data, home: path.join(control, "home"), tmp: path.join(control, "tmp"),
    profile: path.join(data, "desktop"), socket: path.join(control, "control.sock"), lock: path.join(control, "controller.lock"),
    tools: path.join(root, ".runtime/toolchain"), envFile: path.join(root, ".env") };
}

export function launchEnvironment(paths) {
  return { HOME: paths.home, TMPDIR: paths.tmp, XDG_CONFIG_HOME: path.join(paths.home, "config"),
    XDG_CACHE_HOME: path.join(paths.home, "cache"), LANG: "zh_CN.UTF-8",
    PATH: `${path.join(paths.tools, "node/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OHMYGAME_DATA_DIR: paths.data, PI_CODING_AGENT_DIR: path.join(paths.data, "pi-agent"), PI_OFFLINE: "1" };
}

async function privateDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("启动目录超出本项目。");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()) throw new Error("启动目录不是本人拥有的普通目录。");
  }
  await chmod(directory, 0o700);
}

async function privateJson(file, max = 4 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o077) || entry.size > max) throw new Error("私有启动记录不安全。");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function removeSocket(socket) {
  const entry = await lstat(socket).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!entry) return;
  if (!entry.isSocket() || entry.isSymbolicLink() || entry.uid !== process.getuid()) throw new Error("启动控制器路径被其他文件占用，未删除该文件。");
  await unlink(socket);
}

export async function protectEnvMetadata(file) {
  // Metadata only. The controller never reads the credential file's contents.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid()) throw new Error(".env 必须是本人拥有的普通单链接文件。");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

async function hash(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("运行时文件不是普通文件。");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally { await handle.close(); }
}

export async function verifyLocalRuntime(paths) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("当前项目专用运行时仅核验过 Apple 芯片 Mac。");
  const manifestFile = path.join(paths.tools, "verified.json");
  if (await hash(manifestFile) !== MANIFEST_HASH) throw new Error("运行时核验记录缺失或改变；不会自动下载替代软件。");
  const manifest = await privateJson(manifestFile);
  if (manifest.version !== 1 || manifest.nodeVersion !== "22.23.4" || manifest.electronVersion !== "43.3.0" || !Array.isArray(manifest.files)) throw new Error("运行时版本不匹配。");
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..")) throw new Error("运行时路径记录无效。");
    const file = path.join(paths.tools, entry.path);
    const resolved = await realpath(file);
    if (!resolved.startsWith(paths.tools + path.sep)) throw new Error("运行时链接越界。");
    if (entry.link !== undefined) {
      const { readlink } = await import("node:fs/promises");
      if (!(await lstat(file)).isSymbolicLink() || await readlink(file) !== entry.link) throw new Error("运行时链接已改变。");
    } else if (await hash(file) !== entry.sha256) throw new Error("运行时文件校验失败；没有执行该文件。");
  }
  if (await hash(path.join(paths.tools, "node/bin/node")) !== NODE_HASH) throw new Error("Node 校验失败。");
}

async function sourceFingerprint(root) {
  const digest = createHash("sha256");
  let files = 0, bytes = 0;
  const visit = async (relative) => {
    const file = path.join(root, relative), entry = await lstat(file);
    if (entry.isSymbolicLink()) throw new Error("构建源码不可包含链接。");
    if (entry.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (entry.isFile()) {
      if (++files > 20_000 || (bytes += entry.size) > 256 * 1024 * 1024 || entry.nlink !== 1) throw new Error("构建源码超过本地预算或包含硬链接。");
      digest.update(relative).update(await readFile(file));
    }
  };
  for (const name of ["src", "player", "CHANGELOG.md", "package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json", "vite.config.ts", "vite.player.config.ts", "vite.sandbox.config.ts", "index.html", "web-game-host.html", "playable-sandbox.html", "scripts/build-story-web.mjs"]) await visit(name);
  if (await lstat(path.join(root, "public")).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; })) await visit("public");
  return digest.digest("hex");
}

function run(binary, args, environment, cwd, timeout = 180_000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("本次启动已取消。")); return; }
    const child = spawn(binary, args, { cwd, env: environment, stdio: "ignore", detached: true });
    let expired = false;
    const terminate = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => { expired = true; terminate(); }, timeout);
    signal?.addEventListener("abort", terminate, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", terminate); };
    child.once("error", () => { finish(); reject(new Error("本地命令无法启动。")); });
    child.once("close", (code) => {
      finish();
      if (signal?.aborted) reject(new Error("本次启动已取消，已停止本次构建命令。"));
      else if (code === 0 && !expired) resolve();
      else reject(new Error(expired ? "本地命令超时，已停止本次命令。" : `本地命令失败（退出码 ${code ?? "未知"}）。不会自动安装依赖。`));
    });
  });
}

async function ensureBuild(paths, environment, signal) {
  for (const entry of ["typescript/bin/tsc", "vite/bin/vite.js", "tsx/dist/loader.mjs"]) {
    if (!(await lstat(path.join(paths.root, "node_modules", entry)).catch(() => undefined))?.isFile()) throw new Error("项目依赖未准备完整；启动项不会安装依赖或执行安装脚本。");
  }
  const fingerprint = await sourceFingerprint(paths.root);
  const stamp = await privateJson(path.join(paths.control, "build.json")).catch(() => undefined);
  const outputs = ["dist/desktop/bootstrap.cjs", "dist/daemon/server.js", "dist/renderer/index.html", "dist/player/index.html", "dist/story-web/resources.json"];
  if (stamp?.fingerprint === fingerprint && (await Promise.all(outputs.map((file) => lstat(path.join(paths.root, file)).catch(() => undefined)))).every((entry) => entry?.isFile())) return;
  const node = path.join(paths.tools, "node/bin/node");
  const commands = [
    ["检查并编译本地服务", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]],
    ["准备本地故事运行资源", ["--import", "tsx", "scripts/build-story-web.mjs"]],
    ["构建界面", ["node_modules/vite/bin/vite.js", "build"]],
    ["构建界面沙箱", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.sandbox.config.ts", "--outDir", "dist/renderer"]],
    ["构建试玩播放器", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.player.config.ts"]],
    ["构建播放器沙箱", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.sandbox.config.ts", "--outDir", "dist/player"]],
  ];
  for (const [label, args] of commands) { console.log(`${label}…`); await run(node, args, environment, paths.root, 180_000, signal); }
  await writePrivateJson(path.join(paths.control, "build.json"), { version: 1, fingerprint });
}

async function compactBrowserStorage(paths) {
  if (!(await lstat(path.join(paths.data, "project-browser-cleanup")).catch(() => undefined))) return;
  try {
    const { compactProjectBrowserStorage } = await import("../dist/desktop/project-browser-storage.js");
    await compactProjectBrowserStorage(paths.data);
  } catch {
    console.warn("旧项目的浏览器存储或诊断日志清理尚未完成，下次启动或退出将重试。");
  }
}

export async function assertBrowserStorageRestored(paths) {
  const live = path.join(paths.profile, "browser", "Local Storage", "leveldb");
  const existing = (file) => lstat(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!(await existing(live + ".project-cleanup-previous"))) return;
  if ((await existing(live))?.isDirectory() && (await existing(path.join(live, "CURRENT")))?.isFile()) return;
  throw new Error("浏览器设置库还未恢复。已保留原数据，暂不启动新的设置库。");
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function message(socket, command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    client.setTimeout(2_000, () => client.destroy(new Error("启动控制器未响应。")));
    let response = "";
    client.once("connect", () => client.write(`${command}\n`));
    client.on("data", (data) => {
      response += data;
      if (response.length > 1024) client.destroy(new Error("启动控制器响应超出限制。"));
    });
    client.once("end", () => {
      try {
        const value = JSON.parse(response);
        if (value?.ok !== true || typeof value.state !== "string") throw new Error();
        resolve(value);
      } catch { reject(new Error("启动控制器响应无效。")); }
    });
    client.once("error", reject);
  });
}

export async function recoverOwnedVm(paths, owner, exitedDaemonPid) {
  const lock = path.join(paths.execution, "manual-vm.lock");
  const directory = await lstat(lock).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!directory) return;
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o7777) !== 0o700 || await realpath(lock) !== lock) throw new Error("VM 租约目录未通过检查，已保留原记录。");
  const receipt = await privateJson(path.join(lock, "owner.json"), 4096).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!receipt) return;
  if (receipt.version !== 1 || receipt.instance !== "omg" || !UUID.test(receipt.sessionId ?? "") ||
      !["starting", "owned"].includes(receipt.state) || !Number.isSafeInteger(receipt.ownerPid) || receipt.ownerPid <= 1 ||
      receipt.ownerLaunchId !== owner.launchId || receipt.ownerParentPid !== owner.electronPid ||
      (exitedDaemonPid !== undefined && receipt.ownerPid !== exitedDaemonPid))
    throw new Error("VM 回执不属于本次启动或守护进程；已保留原记录。");
  if (exitedDaemonPid !== undefined && alive(exitedDaemonPid)) throw new Error("原守护进程的 PID 仍在使用，已保留 VM 回执。");
  const deadline = Date.now() + 30_000;
  while (alive(receipt.ownerPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  if (alive(receipt.ownerPid)) throw new Error("本次守护进程仍在关闭，保留 VM 回执和启动记录；请等待退出后重试。");
  const environment = { HOME: path.join(paths.execution, "home"), LIMA_HOME: path.join(paths.execution, "lima"), XDG_CONFIG_HOME: path.join(paths.execution, "config"), XDG_CACHE_HOME: path.join(paths.execution, "cache"), TMPDIR: path.join(paths.execution, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SSH: "/usr/bin/ssh -F /dev/null" };
  console.log("回收本次启动拥有的测试 VM…");
  await run(path.join(paths.execution, "tools/lima/bin/limactl"), ["stop", "--tty=false", "omg"], environment, paths.execution, 60_000);
  // Remove only records that are still byte-for-byte owned by this launch.
  const current = await privateJson(path.join(lock, "owner.json"), 4096);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error("VM 所有权回执已改变，保留记录。");
  await unlink(path.join(lock, "owner.json"));
  await unlink(path.join(lock, `owner-${receipt.sessionId}.tmp`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(lock);
}

export async function startLocal(root, action = "start") {
  const paths = launchPaths(await realpath(root));
  for (const directory of [paths.control, paths.home, paths.tmp, paths.data, path.join(paths.data, "projects"), paths.profile]) await privateDirectory(paths.root, directory);
  if (Buffer.byteLength(paths.socket) > 100) throw new Error("项目路径过长，无法创建私有启动控制器；请使用较短的本地项目路径。");
  if (action === "stop") {
    try { await message(paths.socket, "stop"); console.log("已请求正常退出；VM 将按本次所有权回收。"); return; }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
    const old = await privateJson(path.join(paths.lock, "owner.json")).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (old) {
      if (alive(old.pid) || alive(old.electronPid)) throw new Error("原启动窗口仍在运行但控制器未响应；请在该窗口按 ⌘Q，未停止其他程序。");
      await recoverOwnedVm(paths, old);
      const stale = path.join(paths.control, "stale-locks"); await privateDirectory(paths.root, stale);
      await rename(paths.lock, path.join(stale, `${Date.now()}-${randomUUID()}`));
      await removeSocket(paths.socket);
    }
    console.log("本项目当前没有启动实例；未停止其他程序。"); return;
  }
  if (action === "check") { await verifyLocalRuntime(paths); console.log("项目专用 Node 与 Electron 校验通过；没有读取 .env 或调用模型。"); return; }
  try { await message(paths.socket, "focus"); console.log("OhMyGame 已在运行，已请求显示现有窗口。"); return; } catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error; }
  const old = await privateJson(path.join(paths.lock, "owner.json")).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (old) {
    if (alive(old.pid) || alive(old.electronPid)) throw new Error("已有启动或界面仍在运行。请先在原窗口按 ⌘Q 退出，再双击；没有启动第二份服务。");
    await recoverOwnedVm(paths, old);
    const stale = path.join(paths.control, "stale-locks"); await privateDirectory(paths.root, stale);
    await rename(paths.lock, path.join(stale, `${Date.now()}-${randomUUID()}`));
  }
  await mkdir(paths.lock, { mode: 0o700 });
  const owner = { version: 1, pid: process.pid, launchId: randomUUID(), electronPid: undefined };
  const saveOwner = () => writePrivateJson(path.join(paths.lock, "owner.json"), owner);
  await saveOwner();
  await removeSocket(paths.socket);
  let child, childCompletion, stopping = false, state = "preparing", stopTimer;
  const buildAbort = new AbortController();
  const stop = () => {
    stopping = true; buildAbort.abort();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      stopTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }, 180_000);
    }
  };
  const server = net.createServer((client) => {
    client.setTimeout(2_000, () => client.destroy()); let text = "";
    client.on("data", (data) => {
      text += data; if (text.length > 32) { client.destroy(); return; }
      if (!text.includes("\n")) return;
      const command = text.trim();
      if (command === "stop") stop();
      else if (command === "focus" && child?.pid) child.kill("SIGUSR2");
      else if (command !== "focus") { client.destroy(); return; }
      client.end(JSON.stringify({ ok: true, state }));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve); });
  await chmod(paths.socket, 0o600);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    console.log("核对项目专用运行时…"); await verifyLocalRuntime(paths);
    await protectEnvMetadata(paths.envFile);
    const environment = launchEnvironment(paths);
    await ensureBuild(paths, environment, buildAbort.signal);
    const { ProjectLifecycle } = await import("../dist/daemon/project-lifecycle.js");
    await new ProjectLifecycle(paths.data).load();
    await compactBrowserStorage(paths);
    await writePrivateJson(path.join(paths.data, "isolated-execution.json"), { version: 1, projectsDirectory: path.join(paths.data, "projects") });
    let reuse = false, restarts = 0;
    while (!stopping) {
      await assertBrowserStorageRestored(paths);
      const args = [paths.root, "--built-renderer", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-domain-reliability", "--disable-breakpad", "--no-default-browser-check", "--local-profile", paths.profile, "--local-launch-id", owner.launchId,
        ...(reuse ? ["--reuse-local-env"] : ["--local-env", paths.envFile])];
      child = spawn(path.join(paths.tools, "electron/Electron.app/Contents/MacOS/Electron"), args, { cwd: paths.root, env: environment, stdio: "ignore", detached: true });
      childCompletion = new Promise((resolve, reject) => {
        child.once("error", () => reject(new Error("Electron 未能启动。")));
        child.once("exit", resolve);
      });
      // Attach immediately so an early spawn failure cannot become an unhandled rejection.
      void childCompletion.catch(() => {});
      owner.electronPid = child.pid; await saveOwner(); state = "running";
      console.log("OhMyGame 已启动。关闭主窗口或按 ⌘Q 即完整退出；停止脚本保留为备用入口。启动不会发起模型请求。");
      const code = await childCompletion;
      state = "closing";
      await recoverOwnedVm(paths, owner);
      await compactBrowserStorage(paths);
      if (code === 75 && !stopping && ++restarts <= 5) { reuse = true; console.log("按用户请求重启，复用本次凭据快照…"); continue; }
      if (code !== 0 && !stopping) throw new Error(`OhMyGame 已退出（代码 ${code ?? "未知"}）；没有自动重试模型请求。`);
      break;
    }
  } catch (error) {
    stop();
    await childCompletion?.catch(() => {});
    throw error;
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await new Promise((resolve) => server.close(resolve));
    await removeSocket(paths.socket);
    // Preserve ownership evidence on uncertain VM cleanup so a later launch can recover it.
    await recoverOwnedVm(paths, owner);
    await unlink(path.join(paths.lock, "owner.json")); await rmdir(paths.lock);
  }
  console.log("OhMyGame 已退出，本次启动控制器已关闭。");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const option = process.argv[2];
  const action = option === undefined ? "start" : option === "--stop" ? "stop" : option === "--check" ? "check" : undefined;
  if (!action) { console.error("不支持该启动选项。"); process.exitCode = 1; }
  else await startLocal(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), action).catch((error) => {
    if (error instanceof Error && !error.code) console.error(error.message);
    console.error("启动或关闭未完成。请查看 docs/manual-acceptance.md 与项目私有日志；没有显示或发送密钥，也不会自动安装软件。");
    process.exitCode = 1;
  });
}
