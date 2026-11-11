import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssetLibrary } from "../../src/daemon/asset-library.js";
import { CanvasStore } from "../../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../../src/daemon/projects.js";
import { ToolRunner } from "../../src/daemon/tools.js";
import { KunpoVideoProvider } from "../../src/daemon/kunpo-video-provider.js";
import { seedanceModel } from "../../src/daemon/seedance-models.js";
import { createAssetGenerationNode } from "../../src/shared/asset-canvas.js";
import { singleSubmissionVideoTransport } from "../../scripts/video-acceptance-transport.js";
import { referencePng } from "../video-reference-png-fixture.js";

export const FIXTURE_VIDEO_ID = "task_synthetic_response_id_must_survive";
const SOURCE = {
  name: "Synthetic provider",
  baseUrl: "http://127.0.0.1:43199/v1",
  apiKey: "fake-crash-recovery-key",
};
const SUBMISSION =
  "http://127.0.0.1:43199/doubao/api/v3/contents/generations/tasks";

export async function openAcceptanceFixture(
  directory: string,
  request: typeof fetch,
) {
  const library = new AssetLibrary(directory),
    projects = new ProjectManager(directory, library);
  const transport = singleSubmissionVideoTransport(request, {
    submissionUrl: SUBMISSION,
    markerFile: path.join(directory, "post-attempted.json"),
    privateRecoveryPermitted: true,
  });
  const adapter = new KunpoVideoProvider(SOURCE, transport, 0);
  const model = seedanceModel("volcengine-ark", "doubao-seedance-2-5-260628")!;
  const tools = new ToolRunner(
    directory,
    {
      generate: async () => {
        throw new Error("Images disabled in fixture");
      },
    },
    undefined,
    { generate: (input, signal) => adapter.generate(model, input, signal) },
    library,
  );
  await Promise.all([library.load(), projects.load(), tools.load()]);
  const store = new CanvasStore(projects, library, tools);
  return {
    library,
    projects,
    tools,
    store,
    close: async () => {
      await store.close();
      await tools.close();
    },
  };
}

async function runCrashFixture(directory: string, noId: boolean) {
  let posts = 0,
    jobsFile = "",
    projectId = "";
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      if (noId) throw new Error("Synthetic connection loss after sending POST");
      return Response.json({ id: FIXTURE_VIDEO_ID });
    }
    const files = await readdir(path.join(directory, "tools/video-tasks"));
    assert.equal(files.length, 1);
    const journalFile = path.join(directory, "tools/video-tasks", files[0]!),
      saved = JSON.parse(await readFile(journalFile, "utf8"));
    assert(saved.generate.task.taskId === FIXTURE_VIDEO_ID);
    assert.equal((await stat(journalFile)).mode & 0o777, 0o600);
    const job = JSON.parse(await readFile(jobsFile, "utf8"))[0];
    await writeFile(
      path.join(directory, "crash-checkpoint.json"),
      JSON.stringify({
        projectId,
        jobId: job.id,
        posts,
        persistedIdMatchesResponse: true,
      }),
      { mode: 0o600 },
    );
    process.exit(91); // Deliberate abrupt fixture exit after ID save, before any status result or graceful cleanup.
  };
  const runtime = await openAcceptanceFixture(directory, request);
  const project = await runtime.projects.create(
    "Synthetic crash recovery",
    "asset-canvas",
  );
  projectId = project.id;
  const boardId = (await runtime.store.workspace(projectId)).boards[0]!.id,
    detail = await runtime.store.board(projectId, boardId);
  const bytes = referencePng({
      width: 512,
      height: 512,
      color: 2,
      noise: true,
    }),
    reference = await runtime.library.add("synthetic.png", bytes);
  const node = createAssetGenerationNode("video", { x: 0, y: 0 });
  assert.equal(node.type, "video");
  Object.assign(node.data, {
    prompt: "Synthetic scene",
    model: { provider: "volcengine-ark", id: "doubao-seedance-2-5-260628" },
    referenceMode: "reference",
    references: [{ type: "library", assetId: reference.id }],
    duration: 4,
    resolution: "480p",
    aspectRatio: "adaptive",
  });
  detail.board.nodes = [node];
  detail.board.editorLayout.nodes = { [node.id]: node.position };
  await runtime.store.saveBoard(projectId, detail.board, detail.revision);
  jobsFile = path.join(project.workspacePath, "canvas/jobs.json");
  const first = await runtime.store.generateNode(projectId, boardId, node.id);
  await runtime.store.waitForProject(projectId);
  assert(noId);
  const job = (await runtime.store.jobs(projectId)).find(
    (entry) => entry.id === first.id,
  )!;
  assert.equal(job.status, "failed");
  assert.equal(job.canRecoverVideo, false);
  await writeFile(
    path.join(directory, "crash-checkpoint.json"),
    JSON.stringify({
      projectId,
      jobId: job.id,
      nodeId: node.id,
      boardId,
      posts,
      hasSavedId: false,
    }),
    { mode: 0o600 },
  );
  process.exit(91);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCrashFixture(process.argv[2]!, process.argv[3] === "no-id").catch(() => {
    process.stderr.write("Synthetic crash fixture failed\n");
    process.exit(92);
  });
}
