import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { localAgentPath } from "./agent-local-files.js";
import { readSafeProjectFile } from "./safe-project-file.js";

const appRequire = createRequire(import.meta.url);
const runtimeFiles = ["build/three.module.js", "build/three.core.js", "LICENSE"] as const;
const addonSources = ["examples/jsm/loaders/GLTFLoader.js", "examples/jsm/utils/BufferGeometryUtils.js"] as const;

async function bundledRuntime() {
  // Resolve only from the application. Project code and its node_modules never supply these files.
  const root = path.dirname(path.dirname(appRequire.resolve("three")));
  const read = async (name: string) => {
    const file = path.join(root, name);
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw new Error("Invalid bundled Three.js file");
    return readFile(file);
  };
  const { name, version, license } = JSON.parse((await read("package.json")).toString("utf8"));
  if (name !== "three" || license !== "MIT" || version !== appRequire("../../package.json").dependencies.three || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("The bundled Three.js package does not match the application dependency");
  const files = new Map<string, Buffer>();
  for (const source of runtimeFiles) files.set(path.basename(source), await read(source));
  files.set("provenance.json", Buffer.from(JSON.stringify({ name, version, license, source: "OhMyGame bundled npm dependency", files: runtimeFiles }, null, 2) + "\n"));
  const addons = new Map<string, Buffer>();
  for (const source of addonSources) {
    // Resolve the official add-ons against the same project module as the game, including in plain HTML.
    const module = (await read(source)).toString("utf8")
      .replace("from 'three'", "from '../three.module.js'")
      .replace("from '../utils/BufferGeometryUtils.js'", "from './BufferGeometryUtils.js'");
    addons.set(path.basename(source), Buffer.from(module));
  }
  addons.set("provenance.json", Buffer.from(JSON.stringify({ name, version, license, files: addonSources, imports: "Relative to the bundled runtime" }, null, 2) + "\n"));
  return { version: version as string, files, addons };
}

async function installRuntimeDirectory(workspace: string, directory: string, files: ReadonlyMap<string, Buffer>) {
  const target = await localAgentPath(workspace, directory, true);
  const checkExisting = async () => {
    for (const [name, expected] of files) {
      const actual = await readSafeProjectFile(workspace, path.join(target, name)).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") throw new Error(`Existing Three.js directory is missing ${name}. Preserve your files and resolve the conflict before preparing this runtime.`);
        throw cause;
      });
      if (!actual.equals(expected)) throw new Error(`Existing Three.js file differs: ${directory}/${name}. Preserve it and resolve the conflict before using the bundled runtime.`);
    }
  };
  const existing = await lstat(target).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
  if (existing) {
    if (!existing.isDirectory()) throw new Error("The bundled Three.js destination is not a directory");
    await checkExisting();
    return;
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  await localAgentPath(workspace, path.posix.dirname(directory));
  const staging = await mkdtemp(path.join(parent, ".ohmygame-three-"));
  try {
    for (const [name, bytes] of files) await writeFile(path.join(staging, name), bytes, { mode: 0o600, flag: "wx" });
    await localAgentPath(workspace, directory, true);
    try { await rename(staging, target); }
    catch (cause) {
      // Another caller can finish the same install between the check and the rename.
      if (!["ENOTEMPTY", "EEXIST"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
      await checkExisting();
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function prepareThreeRuntime(workspace: string, startupDirectory: string) {
  const { version, files, addons } = await bundledRuntime();
  const directory = path.posix.join(startupDirectory, "vendor", `ohmygame-three-${version}`);
  // A verified legacy install can acquire the add-ons without replacing any existing files.
  await installRuntimeDirectory(workspace, directory, files);
  await installRuntimeDirectory(workspace, directory + "/addons", addons);
  return { version, directory, modulePath: directory + "/three.module.js", gltfLoaderPath: directory + "/addons/GLTFLoader.js" };
}
