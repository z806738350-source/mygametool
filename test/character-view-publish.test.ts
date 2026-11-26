import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  CHARACTER_VIEW_DIRECTIONS,
  type CharacterViewPublishInput,
  type CharacterViewRuntimeManifest,
} from "../src/shared/character-views.js";
import { getToolPreflightFailure } from "../src/daemon/agent-tool-errors.js";
import {
  CharacterViewPublicationJournal,
  type CharacterViewOperationIdentity,
  type CharacterViewPublicationReceipt,
} from "../src/daemon/character-view-publication.js";
import {
  publishCharacterViewSet,
  type CharacterViewPublishOptions,
} from "../src/daemon/character-view-publish.js";
import { temporaryTestDirectory } from "./temporary-test-directory.js";

const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const startup = "client";
const setId = "courier";
const packagePath = `${startup}/public/characters/${setId}`;
const authoringPath = `assets/generated/character-sets/${setId}/authoring.json`;
const activePath = `${packagePath}/manifest.json`;

async function image(red: number) {
  const width = 6,
    height = 7;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 1; y < 6; y++) {
    for (let x = 1; x < 5; x++)
      rgba.set([red, 40, 120, 255], (y * width + x) * 4);
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function fixture() {
  const directory = await realpath(
    await temporaryTestDirectory("ohmygame-managed-character-"),
  );
  const projectId = randomUUID();
  const root = path.join(directory, "workspace");
  const storage = path.join(directory, "image-recovery", projectId);
  const journal = new CharacterViewPublicationJournal({
    workspace: root,
    storage,
    projectId,
  });
  await mkdir(path.join(root, startup), { recursive: true });
  const authoring = Buffer.from(
    JSON.stringify({ designRevision: "d1", displayHeadToGround: 144 }),
  );
  await mkdir(path.dirname(path.join(root, authoringPath)), {
    recursive: true,
  });
  await writeFile(path.join(root, authoringPath), authoring);
  const original = await image(20);
  const updated = await image(200);
  await writeFile(path.join(root, "original.png"), original);
  await writeFile(path.join(root, "updated.png"), updated);
  const view = (
    direction: (typeof CHARACTER_VIEW_DIRECTIONS)[number],
    next = false,
  ): CharacterViewPublishInput["views"][number] => ({
    direction,
    viewRevision: next ? "r2" : "r1",
    source: {
      kind: "workspace",
      reference: next ? "updated.png" : "original.png",
      expectedSha256: hash(next ? updated : original),
    },
    sourceHeadY: 1,
    sourceGroundPoint: { x: 3, y: 6 },
    scale: 1,
    sampling: "nearest",
    visualReview: "Identity and common ground contact checked.",
  });
  const makeInput = (
    purpose: CharacterViewPublishInput["purpose"],
    expectedActiveSha256: string | null = null,
  ): CharacterViewPublishInput => ({
    designRevision: "d1",
    purpose,
    expectedActiveSha256,
    canvas: { width: 10, height: 10 },
    pivot: { x: 5, y: 7 },
    headToGround: 5,
    views:
      purpose === "release"
        ? CHARACTER_VIEW_DIRECTIONS.map((direction) => view(direction))
        : [view("NE", purpose === "revision")],
  });
  const options = (input: CharacterViewPublishInput) =>
    ({
      project: { workspacePath: root, startupDirectory: startup },
      setId,
      input,
      expectedAuthoringSha256: hash(authoring),
      identity: {
        operationId: randomUUID(),
        fingerprint: hash(JSON.stringify(input)),
        action: "publish",
        purpose: input.purpose,
      } satisfies CharacterViewOperationIdentity,
      journal,
      checkAuthoring: (bytes: Buffer) =>
        JSON.parse(bytes.toString()) as { displayHeadToGround: number },
      readCandidate: (
        source: CharacterViewPublishInput["views"][number]["source"],
      ) => readFile(path.join(root, source.reference)),
      mutateWorkspace: <T>(operation: () => Promise<T>) => operation(),
    }) satisfies CharacterViewPublishOptions;
  return { root, storage, journal, makeInput, options, authoring };
}

function committed(receipt: CharacterViewPublicationReceipt) {
  expect(receipt).toMatchObject({ state: "committed" });
  if (receipt.state !== "committed")
    throw new Error("Expected committed character publication");
  return receipt.result as {
    manifestPath: string;
    manifest: CharacterViewRuntimeManifest;
    sha256: string;
    reportPath: string;
    markerCurrent?: boolean;
  };
}

describe("managed character publication", () => {
  it("publishes full and sample sets and revises just one direction while keeping original receipts", async () => {
    const { root, makeInput, options, authoring } = await fixture();
    const releaseOptions = options(makeInput("release"));
    const release = committed(await publishCharacterViewSet(releaseOptions));
    expect(release.manifestPath).toBe(activePath);
    expect(release.manifest).toMatchObject({ complete: true, headToGround: 5 });
    expect(Object.keys(release.manifest.views)).toEqual(
      CHARACTER_VIEW_DIRECTIONS,
    );
    expect(hash(await readFile(path.join(root, activePath)))).toBe(
      release.sha256,
    );
    for (const image of Object.values(release.manifest.views)) {
      expect(
        hash(await readFile(path.join(root, packagePath, image.file))),
      ).toBe(image.sha256);
    }
    const report = JSON.parse(
      await readFile(path.join(root, release.reportPath), "utf8"),
    );
    expect(report).toMatchObject({
      intendedManifestSha256: release.sha256,
      geometry: { displayHeadToGround: 144 },
    });
    expect(report.observations[0]).toMatchObject({
      sourceHeadY: 1,
      sourceGroundPoint: { x: 3, y: 6 },
      scale: 1,
      sampling: "nearest",
    });
    expect(report).not.toHaveProperty("active");
    expect(await readFile(path.join(root, authoringPath))).toEqual(authoring);
    const sample = committed(
      await publishCharacterViewSet(
        options(makeInput("sample", release.sha256)),
      ),
    );
    expect(sample.manifestPath).not.toBe(activePath);
    expect(sample.manifest).toMatchObject({ complete: false });
    expect(Object.keys(sample.manifest.views)).toEqual(["NE"]);
    expect(hash(await readFile(path.join(root, activePath)))).toBe(
      release.sha256,
    );

    const wrongGeometry = makeInput("revision", release.sha256);
    wrongGeometry.headToGround = 6;
    wrongGeometry.views[0]!.scale = 1.2;
    await expect(
      publishCharacterViewSet(options(wrongGeometry)),
    ).rejects.toSatisfy(error => getToolPreflightFailure(error)?.reason === "invalid_character_view_input" &&
      /same design and display geometry/.test(String(error)));

    const sameRevision = makeInput("revision", release.sha256);
    sameRevision.views[0]!.viewRevision = release.manifest.views.NE!.viewRevision;
    await expect(publishCharacterViewSet(options(sameRevision))).rejects.toSatisfy(error =>
      getToolPreflightFailure(error)?.reason === "invalid_character_view_input" && /own view revision/.test(String(error)));

    const revised = committed(
      await publishCharacterViewSet(
        options(makeInput("revision", release.sha256)),
      ),
    );
    expect(revised.manifest.setRevision).not.toBe(release.manifest.setRevision);
    expect(revised.manifest.views.NE?.viewRevision).toBe("r2");
    expect(revised.manifest.views.NE?.sha256).not.toBe(
      release.manifest.views.NE?.sha256,
    );
    for (const direction of CHARACTER_VIEW_DIRECTIONS.filter(
      (direction) => direction !== "NE",
    )) {
      expect(revised.manifest.views[direction]).toEqual(
        release.manifest.views[direction],
      );
    }
    expect(await readdir(path.join(root, packagePath, "images"))).toHaveLength(
      9,
    );
    expect(hash(await readFile(path.join(root, activePath)))).toBe(
      revised.sha256,
    );
    expect(
      committed(await publishCharacterViewSet(releaseOptions)),
    ).toMatchObject({ sha256: release.sha256, markerCurrent: false });
    expect(hash(await readFile(path.join(root, activePath)))).toBe(
      revised.sha256,
    );
  });

  it("rejects visible head-to-ground drift before a reservation or project write", async () => {
    const { root, storage, makeInput, options } = await fixture();
    const input = makeInput("release");
    input.views[0]!.scale = 0.95;
    const begin = vi.spyOn(options(input).journal, "begin");
    const declined = publishCharacterViewSet(options(input));
    await expect(declined).rejects.toThrow("head-to-ground height differs");
    expect(await declined.catch(getToolPreflightFailure)).toMatchObject({
      effect: "none",
      reason: "invalid_character_view_input",
    });
    expect(begin).not.toHaveBeenCalled();
    await expect(stat(path.join(root, packagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(storage, "space-reservations")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles an opaque source rejection after privately staging another direction", async () => {
    const { root, storage, journal, makeInput, options } = await fixture();
    const sample = makeInput("sample");
    const jpeg = await sharp(await image(60)).jpeg().toBuffer();
    await writeFile(path.join(root, "reference.jpg"), jpeg);
    sample.views.push({
      ...sample.views[0]!,
      direction: "SW",
      source: { kind: "workspace", reference: "reference.jpg", expectedSha256: hash(jpeg) },
    });
    const invalid = options(sample);
    const result = await publishCharacterViewSet(invalid);
    expect(result).toMatchObject({
      state: "failed",
      reason: "Character raster input must be static PNG or WebP with alpha",
      effects: { retainedFiles: [] },
    });
    expect(await journal.recover(invalid.identity)).toEqual(result);
    expect(await readdir(path.join(storage, "space-reservations"))).toEqual([]);
    expect(await readdir(path.join(storage, "character-publications"))).not.toContainEqual(expect.stringMatching(/\.stage$/));
    await expect(stat(path.join(root, packagePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(committed(await publishCharacterViewSet(options(makeInput("sample")))).manifest.complete).toBe(false);
  });

  it.each(["authoring", "source", "active", "budget"] as const)(
    "keeps pre-staged effects private when the locked %s check fails",
    async (change) => {
      const { root, storage, journal, makeInput, options } = await fixture();
      const release = committed(
        await publishCharacterViewSet(options(makeInput("release"))),
      );
      const revision = options(makeInput("revision", release.sha256));
      let expectedActive = await readFile(path.join(root, activePath));
      revision.mutateWorkspace = async (operation) => {
        if (change === "authoring")
          await writeFile(path.join(root, authoringPath), "{}");
        if (change === "source")
          await writeFile(path.join(root, "updated.png"), await image(240));
        if (change === "active") {
          expectedActive = Buffer.from("{}");
          await writeFile(path.join(root, activePath), expectedActive);
        }
        if (change === "budget") {
          const extra = path.join(root, "oversized.js");
          await writeFile(extra, "");
          await truncate(extra, 9 * 1024 * 1024);
        }
        return operation();
      };
      const result = await publishCharacterViewSet(revision);
      const reasons = {
        authoring: /authoring changed/,
        source: /source pixels changed/,
        active: /manifest changed/,
        budget: /project budget/,
      };
      expect(result).toMatchObject({
        state: "failed",
        reason: reasons[change],
        effects: { retainedFiles: [] },
      });
      expect(await readFile(path.join(root, activePath))).toEqual(
        expectedActive,
      );
      expect(
        await readdir(path.join(root, packagePath, "images")),
      ).toHaveLength(8);
      expect(await journal.recover(revision.identity)).toEqual(result);
      const privateEntries = await readdir(
        path.join(storage, "character-publications"),
      );
      expect(privateEntries.some((name) => name.endsWith(".stage"))).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    "settles an interrupted save from its original marker evidence (switched: %s)",
    async (switched) => {
      const { root, journal, makeInput, options } = await fixture();
      const release = committed(
        await publishCharacterViewSet(options(makeInput("release"))),
      );
      const revision = options(makeInput("revision", release.sha256));
      const begin = journal.begin.bind(journal);
      vi.spyOn(journal, "begin").mockImplementation(async (...args) => {
        const result = await begin(...args);
        if (result.state === "started") {
          const publish = result.operation.publishMarker;
          result.operation.publishMarker = async () => {
            if (switched) await publish();
            throw new Error("Simulated interruption at marker switch");
          };
        }
        return result;
      });
      const result = await publishCharacterViewSet(revision);
      if (switched) {
        const revised = committed(result);
        expect(hash(await readFile(path.join(root, activePath)))).toBe(
          revised.sha256,
        );
        expect(revised.manifest.views.NE?.viewRevision).toBe("r2");
      } else {
        expect(result).toMatchObject({
          state: "failed",
          reason: "Simulated interruption at marker switch",
          effects: {
            retainedFiles: [
              expect.objectContaining({
                path: expect.stringContaining("/images/NE-r2-"),
              }),
              expect.objectContaining({
                path: expect.stringContaining("/publications/"),
              }),
            ],
          },
        });
        expect(hash(await readFile(path.join(root, activePath)))).toBe(
          release.sha256,
        );
      }
      expect(await journal.recover(revision.identity)).toEqual(result);
      expect(await journal.assertSettled()).toBeUndefined();
    },
  );

  it("holds an uncertain manifest change without replaying it or deleting retained files", async () => {
    const { root, journal, makeInput, options } = await fixture();
    const release = committed(
      await publishCharacterViewSet(options(makeInput("release"))),
    );
    const revision = options(makeInput("revision", release.sha256));
    const competing = Buffer.from(
      JSON.stringify({ ...release.manifest, setRevision: "external" }),
    );
    const begin = journal.begin.bind(journal);
    vi.spyOn(journal, "begin").mockImplementation(async (...args) => {
      const result = await begin(...args);
      if (result.state === "started") {
        result.operation.publishMarker = async () => {
          await writeFile(path.join(root, activePath), competing);
          throw new Error("Simulated out-of-band manifest update");
        };
      }
      return result;
    });
    await expect(publishCharacterViewSet(revision)).resolves.toMatchObject({
      state: "unknown",
      operationId: revision.identity.operationId,
    });
    expect(await readFile(path.join(root, activePath))).toEqual(competing);
    await expect(publishCharacterViewSet(revision)).resolves.toMatchObject({
      state: "unknown",
    });
    expect(await readdir(path.join(root, packagePath, "images"))).toHaveLength(
      9,
    );
    await expect(journal.assertSettled()).rejects.toThrow(
      /cannot verify|cannot settle/i,
    );
  });
});
