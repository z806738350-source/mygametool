import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectLifecycle } from "../src/daemon/project-lifecycle.js";

const id = "5e849fb8-9236-4f0e-a58a-76cb223b8a74";
const other = "9e849fb8-9236-4f0e-a58a-76cb223b8a74";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "project-lifecycle-")));
  directories.push(directory);
  return { directory, lifecycle: new ProjectLifecycle(directory) };
}
it("closes project admission synchronously and rejects duplicate deletion while other projects work", async () => {
  const { lifecycle } = await fixture();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const deletion = lifecycle.delete(id, async () => { entered(); await done; });
  expect(() => lifecycle.assertAvailable(id)).toThrow("deletion is pending");
  lifecycle.assertAvailable(other);
  await expect(lifecycle.delete(id, async () => {})).rejects.toThrow("already running");
  await ready; finish(); await deletion;
  expect(lifecycle.pending(id)).toBe(false);
});
it("restores admission after a refusal before guest retirement", async () => {
  const { lifecycle } = await fixture();
  await expect(lifecycle.delete(id, async () => { throw new Error("active task"); })).rejects.toThrow("active task");
  lifecycle.assertAvailable(id);
});
it("reloads an uncertain guest retirement as pending and allows a confirmed source recovery to clear it", async () => {
  const { lifecycle, directory } = await fixture();
  await expect(lifecycle.delete(id, async (stage) => { await stage("retiring-volume"); throw new Error("response lost"); })).rejects.toThrow("response lost");
  const restarted = new ProjectLifecycle(directory); await restarted.load();
  expect(() => restarted.assertAvailable(id)).toThrow("deletion is pending");
  await restarted.recovered(id); restarted.assertAvailable(id);
});
it("keeps a host deletion failure blocked across crashes and never clears it as a source recovery", async () => {
  const { lifecycle, directory } = await fixture();
  await mkdir(path.join(directory, "projects", id), { recursive: true });
  await expect(lifecycle.delete(id, async (stage) => { await stage("volume-retired"); await stage("deleting-host"); throw new Error("permission"); })).rejects.toThrow("permission");
  const restarted = new ProjectLifecycle(directory); await restarted.load();
  await expect(restarted.recovered(id)).rejects.toThrow("Host project deletion has already begun");
  expect(() => restarted.assertAvailable(id)).toThrow();
  // An explicit new deletion request may finish the same pending operation.
  await restarted.delete(id, async (stage) => { await stage("retiring-volume"); });
  await expect(readFile(path.join(directory, "project-lifecycle", id + ".json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
it.skipIf(process.platform === "win32")("keeps an unreadable deletion record pending for its own project", async () => {
  const { directory, lifecycle } = await fixture();
  const records = path.join(directory, "project-lifecycle");
  await mkdir(records, { mode: 0o700 });
  await symlink(path.join(directory, "missing-record"), path.join(records, id + ".json"));
  await lifecycle.load();
  lifecycle.assertAvailable(other);
  expect(() => lifecycle.assertAvailable(id)).toThrow("deletion is pending");
  await expect(lifecycle.delete(id, async () => { throw new Error("unexpected deletion"); })).rejects.toThrow("requires review");
  expect(await readdir(records)).toEqual([id + ".json"]);
});
it("prunes completed, aborted and interrupted temporary records on startup", async () => {
  const { lifecycle, directory } = await fixture();
  await mkdir(path.join(directory, "project-lifecycle"), { mode: 0o700 });
  for (const [projectId, phase] of [[id, "complete"], [other, "aborted"]])
    await writeFile(path.join(directory, "project-lifecycle", projectId + ".json"), JSON.stringify({ version: 1, projectId, phase, updatedAt: "now" }), { mode: 0o600 });
  const temporary = path.join(directory, "project-lifecycle", `.${id}.${other}.tmp`);
  await writeFile(temporary, "{", { mode: 0o600 });
  await lifecycle.load();
  expect(await readdir(path.join(directory, "project-lifecycle"))).toEqual([]);
  expect(lifecycle.pending(id)).toBe(false); expect(lifecycle.pending(other)).toBe(false);
});
it("collects a legacy host journal only if its project directory is truly gone", async () => {
  const { lifecycle, directory } = await fixture();
  const projects = path.join(directory, "projects");
  await mkdir(path.join(projects, other), { recursive: true });
  for (const target of [id, other]) await expect(lifecycle.delete(target, async stage => {
    await stage("deleting-host"); throw new Error("interrupted");
  })).rejects.toThrow("interrupted");
  const restarted = new ProjectLifecycle(directory);
  await restarted.load();
  expect(await readdir(path.join(directory, "project-lifecycle"))).toEqual([other + ".json"]);
  expect(restarted.pending(other)).toBe(true);
});
it.skipIf(process.platform === "win32")("never resumes final project removal through a linked folder", async () => {
  const { lifecycle, directory } = await fixture();
  const projects = path.join(directory, "projects");
  await mkdir(path.join(projects, other), { recursive: true });
  await symlink(path.join(projects, other), path.join(projects, id), "dir");
  await writeFile(path.join(projects, other, "keep.txt"), "keep");
  await expect(lifecycle.delete(id, async stage => {
    await stage("removing-project"); throw new Error("interrupted");
  })).rejects.toThrow("interrupted");
  const restarted = new ProjectLifecycle(directory);
  await restarted.load();
  expect(await readFile(path.join(projects, other, "keep.txt"), "utf8")).toBe("keep");
  expect(restarted.pending(id)).toBe(true);
});
it("blocks a damaged journal instead of treating uncertain cleanup as complete", async () => {
  const { lifecycle, directory } = await fixture();
  await mkdir(path.join(directory, "project-lifecycle"), { mode: 0o700 });
  await writeFile(path.join(directory, "project-lifecycle", id + ".json"), "{", { mode: 0o600 });
  await lifecycle.load();
  expect(() => lifecycle.assertAvailable(id)).toThrow();
  await expect(lifecycle.delete(id, async () => {})).rejects.toThrow("requires review");
});
it("does not publish a cleanup journal for traversal identities", async () => {
  const { lifecycle } = await fixture();
  await expect(lifecycle.delete("../outside", async () => {})).rejects.toThrow("Invalid project deletion identity");
});
it("serializes source recovery against deletion before either can change data", async () => {
  const { lifecycle } = await fixture();
  let finish!: () => void;
  const recovery = lifecycle.recover(id, () => new Promise<void>((resolve) => { finish = resolve; }));
  expect(() => lifecycle.assertAvailable(id)).toThrow();
  await expect(lifecycle.delete(id, async () => { throw new Error("must not run"); })).rejects.toThrow("already running");
  await expect(lifecycle.recover(id, async () => { throw new Error("must not run"); })).rejects.toThrow("still running");
  finish(); await recovery;
  lifecycle.assertAvailable(id);
});

it("holds inspection admission without clearing or rewriting a pending deletion record", async () => {
  const { lifecycle, directory } = await fixture();
  await expect(lifecycle.delete(id, async stage => { await stage("retiring-volume"); throw new Error("retained source"); })).rejects.toThrow();
  const file = path.join(directory, "project-lifecycle", id + ".json"), before = await readFile(file);
  let finish!: () => void;
  const inspection = lifecycle.inspectRecovery(id, () => new Promise<void>(resolve => { finish = resolve; }));
  await expect(lifecycle.delete(id, async () => {})).rejects.toThrow("already running");
  finish(); await inspection;
  expect(await readFile(file)).toEqual(before);
  expect(lifecycle.pending(id)).toBe(true);
});
it("validates an interrupted host deletion before calling a source recovery writer", async () => {
  const { lifecycle } = await fixture();
  await expect(lifecycle.delete(id, async (stage) => { await stage("deleting-host"); throw new Error("interrupted"); })).rejects.toThrow();
  let called = false;
  await expect(lifecycle.recover(id, async () => { called = true; })).rejects.toThrow("Host project deletion has already begun");
  expect(called).toBe(false);
});
