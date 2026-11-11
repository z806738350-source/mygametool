import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    testTempDirectory: string;
  }
}

/** Collect even fixture directories a suite leaves behind, once all workers have stopped. */
export default async function setup(project: TestProject) {
  const directory = await mkdtemp(path.join(tmpdir(), "omg-"));
  project.provide("testTempDirectory", directory);
  return () => rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
