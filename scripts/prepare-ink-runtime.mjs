import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, version as esbuildVersion } from "esbuild";

const upstream = "https://github.com/siliconjungle/shapeshift-labs-ink-studio";
const upstreamCommit = "f4b5644a26f4a0d2a707b1c74dc58ea4f5ba692c";
const archiveUrl = `https://codeload.github.com/siliconjungle/shapeshift-labs-ink-studio/tar.gz/${upstreamCommit}`;
// Only unpack the reviewed GitHub archive, even when rebuilding from a local file.
const archiveSha256 = "95330a43635bc311ffafb3961cfa4f045399d6c0613016c4f1531f24cf2ac90b";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [archivePath, outputPath, ...extra] = process.argv.slice(2);
if (!archivePath || extra.length) throw new Error("Usage: node scripts/prepare-ink-runtime.mjs <pinned-source.tar.gz> [output-directory]");

const destination = path.resolve(outputPath ?? fileURLToPath(new URL("../plugins/ink-studio/runtime", import.meta.url)));
const archive = await readFile(archivePath);
if (sha256(archive) !== archiveSha256) throw new Error(`Use the reviewed Ink Studio source archive at ${archiveUrl}`);

const temporary = await mkdtemp(path.join(tmpdir(), "ohmygame-ink-build-"));
try {
  const verifiedArchive = path.join(temporary, "source.tar.gz");
  await writeFile(verifiedArchive, archive);
  await promisify(execFile)("tar", ["-xzf", verifiedArchive, "-C", temporary]);
  const root = path.join(temporary, `shapeshift-labs-ink-studio-${upstreamCommit}`);
  const read = (name) => readFile(path.join(root, name), "utf8");
  const { name, version, license } = JSON.parse(await read("package.json"));
  const index = await read("index.js");

  // Match upstream bundle({ profile: "bake", format: "module" }) without running its JavaScript.
  const listedFiles = (part) => Array.from(part.matchAll(/'([^']+\.js)'/g), (match) => match[1]);
  const storyFiles = new Set(["src/story-document.js", "src/story-analysis.js", "src/story-inventory.js"]);
  const core = listedFiles(index.split("const files =")[1].split("const demoFiles =")[0]);
  const kit = listedFiles(index.split("const bakeKit =")[1].split("const files =")[0]).sort();
  const inputs = [...core.filter((file) => !storyFiles.has(file)), ...kit.map((file) => `src/kit/${file}`)];
  const sources = await Promise.all(inputs.map(async (file) => (await read(file)).replace(/\nif \(typeof module[^\n]*\n?$/, "\n")));
  const exports = index.match(/const EXPORTS\s*=\s*'([^']+)'/)[1];
  const browserSource = `${sources.join("\n")}\nexport { ${exports} };\n`;
  const [toolkit, renderer] = await Promise.all([
    bundle({
      stdin: { contents: browserSource, sourcefile: "ink-studio.bake.mjs" },
      define: { module: "undefined", require: "undefined" },
    }),
    bundle({ absWorkingDir: root, entryPoints: ["src/webgl/renderer.mjs"] }),
  ]);

  const notice = `# Ink Studio browser runtime

These bundles contain ${name} ${version} by siliconjungle. The original ${license} license is included in LICENSE.txt. [Pinned upstream source](${upstream}/tree/${upstreamCommit})

The toolkit uses the upstream bake profile. The renderer bundles the standalone WebGL 2 renderer entry. Both are built with esbuild ${esbuildVersion}.

To rebuild, run \`node scripts/prepare-ink-runtime.mjs /path/to/source.tar.gz\` from the repository with dependencies installed. [Pinned source archive](${archiveUrl})
`;
  const files = {
    "ink-toolkit.min.mjs": toolkit,
    "ink-renderer.min.mjs": renderer,
    "LICENSE.txt": await readFile(path.join(root, "LICENSE")),
    "NOTICE.md": Buffer.from(notice),
  };
  const manifest = {
    upstreamCommit,
    profile: "bake",
    distributionRevision: 1,
    files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, { size: bytes.length, sha256: sha256(bytes) }])),
  };
  const entries = [...Object.entries(files), ["runtime-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`]];
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(path.join(destination, ".prepare-ink-"));
  try {
    await Promise.all(entries.map(([file, contents]) => writeFile(path.join(staging, file), contents)));
    for (const [file] of entries) await rename(path.join(staging, file), path.join(destination, file));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Prepared Ink Studio ${version} browser runtime at ${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function bundle(entry) {
  const result = await build({
    ...entry,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    legalComments: "inline",
    minify: true,
    metafile: true,
    write: false,
  });
  const outputs = Object.values(result.metafile.outputs);
  const [artifact] = result.outputFiles;
  if (outputs.length !== 1 || outputs[0].imports.length || artifact.contents.length >= 2 * 1024 * 1024) {
    throw new Error("The Ink browser module must be self-contained and smaller than 2 MiB");
  }
  return artifact.contents;
}
