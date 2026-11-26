import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { assertCharacterViewScale, checkCharacterViewScale, type CharacterViewDirection } from "../src/shared/character-views.js";
import { stageCharacterViewPngs, type CharacterViewPublicationCandidate } from "../src/daemon/character-views.js";

describe("standing character head-to-ground scale", () => {
  const target = { headToGround: 144, displayHeadToGround: 144 };
  const measured = [
    ["N", 43, 1222, 1223],
    ["NE", 55, 1160, 1204],
    ["E", 55, 1167, 1222],
    ["SE", 57, 1152, 1213],
    ["S", 43, 1323, 1323],
    ["SW", 72, 1161, 1210],
    ["W", 72, 1170, 1214],
    ["NW", 40, 1196, 1239],
  ] as const satisfies readonly (readonly [CharacterViewDirection, number, number, number])[];

  it("catches the six low crowns hidden by equal silhouette height", () => {
    const rejected = [];
    for (const [direction, head, ground, toe] of measured) {
      const view = { direction, sourceHeadY: head, sourceGroundPoint: { x: 500, y: ground }, scale: 144 / (toe - head + 1) };
      const observation = checkCharacterViewScale(view, target);
      if (!observation.matches) {
        rejected.push(direction);
        expect(() => assertCharacterViewScale(view, target)).toThrow(`${direction}: measured head-to-ground height differs`);
      }
      const corrected = assertCharacterViewScale({ ...view, scale: observation.expectedScale }, target);
      expect(corrected.renderedHeadToGround).toBeCloseTo(144, 8);
      expect(corrected.displayOffset).toBeCloseTo(0, 8);
    }
    expect(rejected).toEqual(["NE", "E", "SE", "SW", "W", "NW"]);
  });

  it("compares against display size and rejects invalid landmarks", () => {
    const view = { direction: "E", sourceHeadY: 100, sourceGroundPoint: { x: 200, y: 500 }, scale: 1 } as const;
    expect(checkCharacterViewScale(view, { headToGround: 404, displayHeadToGround: 144 }).matches).toBe(true);
    expect(checkCharacterViewScale(view, { headToGround: 412, displayHeadToGround: 144 }).matches).toBe(false);
    expect(() => checkCharacterViewScale({ ...view, sourceHeadY: 501 }, target)).toThrow("head point above the ground point");
  });

  it("checks all scales before reading or staging a single candidate", async () => {
    const candidates = measured.map(([direction, head, ground, toe]) => ({
      direction, sourceHeadY: head, sourceGroundPoint: { x: 500, y: ground }, scale: 144 / (toe - head + 1),
      viewRevision: "r1", sampling: "nearest", sourceSha256: "a".repeat(64),
    } as const));
    const read = vi.fn(), stagePng = vi.fn();
    await expect(stageCharacterViewPngs(candidates, { ...target, canvas: { width: 160, height: 192 }, pivot: { x: 80, y: 160 } }, read, { stagePng }))
      .rejects.toThrow("NE: measured head-to-ground height differs");
    expect(read).not.toHaveBeenCalled();
    expect(stagePng).not.toHaveBeenCalled();
  });

  it("stages a transparent corrected derivative with a measurement receipt", async () => {
    const pixels = Buffer.alloc(4 * 6 * 4);
    for (const offset of [20, 36, 52, 68]) pixels.fill(255, offset, offset + 4);
    const input = await sharp(pixels, { raw: { width: 4, height: 6, channels: 4 } }).png().toBuffer();
    const sourceSha256 = createHash("sha256").update(input).digest("hex");
    const candidate: CharacterViewPublicationCandidate = {
      direction: "N", sourceHeadY: 1, sourceGroundPoint: { x: 1.5, y: 5 }, scale: 2,
      viewRevision: "r1", sourceSha256, sampling: "nearest",
    };
    const stagePng = vi.fn(async (_direction: string, png: Buffer) => ({ path: "staged-test.png", sha256: createHash("sha256").update(png).digest("hex"), size: png.length }));
    const result = await stageCharacterViewPngs([candidate], { headToGround: 8, displayHeadToGround: 144, canvas: { width: 16, height: 20 }, pivot: { x: 8, y: 14 } }, async () => input, { stagePng });
    expect(result).toEqual([expect.objectContaining({ direction: "N", sourceSha256, scaleCheck: { expectedScale: 2, renderedHeadToGround: 8, displayOffset: 0, matches: true } })]);
    expect(stagePng).toHaveBeenCalledOnce();
    expect(await sharp(stagePng.mock.calls[0]![1]).metadata()).toMatchObject({ format: "png", width: 16, height: 20, hasAlpha: true });
  });
});
