import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterViewPublicationJournal, type CharacterViewOperationIdentity } from "../src/daemon/character-view-publication.js";
import { findLocalImageRecoverySpace, reserveLocalImageRecoverySpace } from "../src/daemon/recovery-space.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDfcAAAAASUVORK5CYII=", "base64");
const space = { rawBytes: 0, workingBytes: 0, beforeBytes: 0, afterBytes: 256, manifestBytes: 64 * 1024, additionalEntries: 32 };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const temporary: string[] = [];

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "character-publication-")));
  temporary.push(directory);
  const projectId = randomUUID();
  const anchor = { workspace: path.join(directory, "workspace"), storage: path.join(directory, "image-recovery", projectId), projectId };
  await mkdir(anchor.workspace);
  const identity: CharacterViewOperationIdentity = {
    operationId: "conversation/original-call", fingerprint: digest("original input"), action: "publish", purpose: "complete",
  };
  const reopen = () => new CharacterViewPublicationJournal(anchor);
  return { anchor, identity, reopen, journal: reopen() };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("character view publication", () => {
  it("reclaims the original owner when space was persisted before its receipt association", async () => {
    const { anchor, identity, journal, reopen } = await fixture();
    const begun = await journal.begin(identity);
    if (begun.state !== "started") throw new Error("Expected new operation");
    const owner = digest(JSON.stringify([anchor.projectId, identity.operationId, identity.action, identity.purpose, identity.fingerprint])).slice(0, 32);
    const original = await reserveLocalImageRecoverySpace(anchor, space, { ownerKey: owner });
    expect((await findLocalImageRecoverySpace(anchor, owner))?.id).toBe(original.id);
    expect(await findLocalImageRecoverySpace(anchor, "0".repeat(32))).toBeUndefined();
    // Keep the exact disk intent while clearing the ledger's in-memory record.
    const intentPath = path.join(anchor.storage, "space-reservations", `${original.id}.json`);
    const persisted = await readFile(intentPath);
    await original.release();
    await writeFile(intentPath, persisted, { mode: 0o600 });
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "failed" });
    expect(await findLocalImageRecoverySpace(anchor, owner)).toBeUndefined();
    expect(await reopen().begin(identity)).toMatchObject({ state: "failed" });
  });

  it("clears owned staged PNGs after an interruption before any project write", async () => {
    const { identity, journal, reopen } = await fixture();
    const begun = await journal.begin(identity, { space });
    if (begun.state !== "started") throw new Error("Expected new operation");
    const staged = await begun.operation.stagePng("N", png);
    expect(staged.sha256).toBe(digest(png));
    expect(await readFile(staged.path)).toEqual(png);
    expect(await reopen().recover(identity)).toMatchObject({ state: "unknown", reason: /still running/ });
    await truncate(staged.path, 16);
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "failed" });
    await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reopen().assertSettled()).resolves.toBeUndefined();
  });

  it("recovers a lost response after a full marker switch and retains the original receipt across later versions", async () => {
    const { anchor, identity, journal, reopen } = await fixture();
    const marker = path.join(anchor.workspace, "manifest.json");
    const before = Buffer.from('{"version":1}');
    const after = Buffer.from('{"version":2}');
    await writeFile(marker, before);
    const begun = await journal.begin(identity, { space });
    if (begun.state !== "started") throw new Error("Expected new operation");
    const staged = await begun.operation.stagePng("N", png);
    await begun.operation.prepareCommit({ marker: { path: "manifest.json", before, after }, files: [{ path: "n.png", sha256: staged.sha256 }], result: { version: 2 } });
    await writeFile(path.join(anchor.workspace, "n.png"), png);
    await begun.operation.publishMarker();
    begun.operation.detach();
    expect(await reopen().recover(identity)).toEqual({ state: "committed", result: { version: 2 } });
    await writeFile(marker, '{"version":3}');
    expect(await reopen().begin(identity)).toEqual({ state: "committed", result: { version: 2 } });
    expect(await readFile(marker, "utf8")).toBe('{"version":3}');
    await expect(reopen().begin({ ...identity, fingerprint: digest("changed input") })).rejects.toThrow("different input");
  });

  it("recognizes a cold interruption before marker switch and retains only verified workspace files", async () => {
    const { anchor, identity, journal, reopen } = await fixture();
    const marker = path.join(anchor.workspace, "manifest.json");
    const before = Buffer.from('{"version":1}');
    const after = Buffer.from('{"version":2}');
    await writeFile(marker, before);
    const begun = await journal.begin(identity, { space });
    if (begun.state !== "started") throw new Error("Expected a new operation");
    const fileProof = { path: "n.png", sha256: digest(png) };
    await begun.operation.prepareCommit({ marker: { path: "manifest.json", before, after }, files: [fileProof, { path: "ne.png", sha256: digest(png) }], result: { version: 2 } });
    await writeFile(path.join(anchor.workspace, fileProof.path), png);
    await expect(begun.operation.publishMarker()).rejects.toMatchObject({ code: "ENOENT" });
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "failed", effects: { retainedFiles: [fileProof] } });
    expect(await readFile(marker)).toEqual(before);
    expect(await readFile(path.join(anchor.workspace, fileProof.path))).toEqual(png);
  });

  it("leaves a changed active marker untouched and cannot infer the prior commit", async () => {
    const { anchor, identity, journal, reopen } = await fixture();
    const marker = path.join(anchor.workspace, "manifest.json");
    const before = Buffer.from('{"version":1}');
    const after = Buffer.from('{"version":2}');
    await writeFile(marker, before);
    const begun = await journal.begin(identity, { space });
    if (begun.state !== "started") throw new Error("Expected a new operation");
    await begun.operation.prepareCommit({ marker: { path: "manifest.json", before, after }, result: { version: 2 } });
    await writeFile(marker, '{"version":3}');
    await expect(begun.operation.publishMarker()).rejects.toThrow("changed before publication");
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "unknown" });
    expect(await readFile(marker, "utf8")).toBe('{"version":3}');
    await writeFile(marker, before);
    // Reveal the original unchanged state to release the test's durable lease.
    expect(await reopen().recover(identity)).toMatchObject({ state: "failed" });
  });

  it("keeps an incomplete publication unknown and rejects unrelated operations", async () => {
    const { anchor, identity, journal, reopen } = await fixture();
    const begun = await journal.begin(identity);
    if (begun.state !== "started") throw new Error("Expected new operation");
    const after = Buffer.from('{"version":2}');
    await begun.operation.prepareCommit({ marker: { path: "manifest.json", before: null, after }, files: [{ path: "n.png", sha256: digest(png) }], result: { version: 2 } });
    await writeFile(path.join(anchor.workspace, "manifest.json"), after);
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "unknown" });
    await expect(reopen().begin({ ...identity, operationId: "conversation/other-call" })).rejects.toThrow("Cannot settle");
    await expect(readFile(path.join(anchor.workspace, "n.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records proven retained plan effects without treating an interrupted write as effect-free", async () => {
    const { identity: original, journal, reopen } = await fixture();
    const identity = { ...original, action: "plan" as const, purpose: "plan" };
    const begun = await journal.begin(identity);
    if (begun.state !== "started") throw new Error("Expected new operation");
    await begun.operation.markEffectsStarted();
    expect(await begun.operation.settleFailure("Plan did not get ready")).toMatchObject({ state: "unknown" });
    const retained = { canvasNodeIds: ["known-owned-node"] };
    expect(await begun.operation.settleFailure("Plan did not get ready", retained)).toEqual({ state: "failed", reason: "Plan did not get ready", effects: retained });
    begun.operation.detach();
    expect(await reopen().recover(identity)).toMatchObject({ state: "failed", effects: retained });
  });

  it("commits a plan against a frozen ready marker and original receipt", async () => {
    const { anchor, identity: original, journal, reopen } = await fixture();
    const identity = { ...original, action: "plan" as const, purpose: "plan" };
    const begun = await journal.begin(identity);
    if (begun.state !== "started") throw new Error("Expected new operation");
    await begun.operation.markEffectsStarted();
    const after = Buffer.from('{"state":"ready"}');
    const result = { nodes: ["n-ready"] };
    await begun.operation.prepareCommit({ marker: { path: "authoring.json", before: null, after }, result });
    result.nodes[0] = "later uncommitted edit";
    await writeFile(path.join(anchor.workspace, "authoring.json"), after);
    expect(await begun.operation.commit()).toEqual({ state: "committed", result: { nodes: ["n-ready"] } });
    begun.operation.detach();
    expect(await reopen().recover(identity)).toEqual({ state: "committed", result: { nodes: ["n-ready"] } });
  });
});
