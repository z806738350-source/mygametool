// A real process exits after the first file is linked, before normal alias cleanup.
// No VM, model, provider, user project or network is used.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { projectFiles } from "../../src/daemon/isolated-project-files.js";
import { applySourceChanges } from "../../src/daemon/isolated-source-changes.js";

const workspace = process.argv[2]!;
const file = (name: string, text: string) => ({
  path: name,
  data: Buffer.from(text).toString("base64"),
  sha256: createHash("sha256").update(text).digest("hex"),
  executable: false,
});
const signal = {
  throwIfAborted() {
    // Observe the real hardlink phase instead of counting unrelated cancellation checks.
    try { if (lstatSync(path.join(workspace, "game.js")).nlink === 2) process.exit(42); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  },
} as AbortSignal;
await applySourceChanges(
  workspace,
  await projectFiles(workspace),
  [file("game.js", "guest"), file("new.js", "added")],
  signal,
  undefined,
  0,
  process.argv[3] ? JSON.parse(process.argv[3]) : {
    namespace: "test",
    projectId: "5e849fb8-9236-4f0e-a58a-76cb223b8a74",
    generation: 2,
    snapshotId: "b".repeat(64),
  },
);
throw new Error("The publication crash boundary was not reached");
