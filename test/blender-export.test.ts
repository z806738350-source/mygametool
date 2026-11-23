import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const blender = process.env.BLENDER_EXECUTABLE;

describe("Blender GLB export", () => {
  it.skipIf(!blender)(
    "replays custom skin, morph and rigid clips and reports absent or stationary requests",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "ohmygame-blender-clips-"),
      );
      try {
        const source = path.join(root, "source.blend");
        const args = [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
        ];
        await run(blender!, [
          ...args,
          "--python",
          path.resolve("test/fixtures/blender-assets.py"),
          "--",
          source,
          "--stalled",
        ]);
        const config = path.join(root, "export.json");
        const stage = async (
          input: string,
          outputName: string,
          requiredClips: string[],
          operation: "export" | "inspect" = "export",
          motionReviewClips: string[] = [],
        ) => {
          const output = path.join(root, outputName);
          await writeFile(
            config,
            JSON.stringify({ requiredClips, motionReviewClips, previewSize: 96, topologyPolicy: "watertight" }),
          );
          const command = [
            ...args,
            "--python",
            path.resolve(
              "plugins/blender/skills/blender-assets/scripts/pipeline.py",
            ),
            "--",
            "--stage",
            operation,
            "--input-dir",
            root,
            "--config",
            config,
            "--input",
            input,
            "--output-dir",
            output,
          ];
          if (operation === "export") {
            const temporary = path.join(root, "tmp");
            await mkdir(temporary, { recursive: true });
            const state = path.join(temporary, `${outputName}-state.json`);
            const runPhase = (phase: "prepare" | "verify") =>
              run(blender!, [...command, "--export-phase", phase, "--export-state", state]);
            await runPhase("prepare");
            await expect(readFile(path.join(output, "report.json"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const outputHash = async () => {
              const glb = await readFile(path.join(output, "model.glb"));
              return createHash("sha256").update(glb).digest("hex");
            };
            const prepared = await outputHash();
            await runPhase("verify");
            expect(await outputHash()).toBe(prepared);
          } else {
            await run(blender!, command);
          }
          return JSON.parse(
            await readFile(path.join(output, "report.json"), "utf8"),
          );
        };
        const clips = ["Stretch", "Sway", "Trigger"];
        const original = await readFile(source);
        const intake = await stage(source, "intake", [], "inspect");
        expect(intake.sourceInventory).toMatchObject({
          actions: clips, armatures: [{ name: "PropRig", bones: 2 }],
          parts: expect.arrayContaining([expect.objectContaining({ name: "TexturedProp", parent: "AssetRoot" })]),
          materials: expect.arrayContaining([{ name: "CheckerMaterial", usesImageTexture: true }]),
        });
        expect(intake.previews).toEqual(expect.arrayContaining(["review-front.png", "review-side.png", "review-back.png", "review-three-quarter.png"]));
        expect(intake.sourceInventory.parts.map((part: { name: string }) => part.name)).not.toContain("HiddenCollectionHelper");
        expect(await readFile(source)).toEqual(original);
        const final = await stage(path.join(root, "intake", "scene.blend"), "complete", clips, "export", ["Trigger"]);
        expect(final.checks.topology).toMatchObject({ policy: "watertight", boundaryEdges: 0, passed: true });
        expect(final.geometry.meshes.map((mesh: { name: string }) => mesh.name)).not.toContain("HiddenCollectionHelper");
        const delivered = (await new NodeIO().read(path.join(root, "complete", "model.glb"))).getRoot();
        expect(delivered.listNodes().map(node => node.getName())).not.toContain("HiddenCollectionHelper");
        const complete = final.checks.roundtrip;
        for (const [inventory, file] of [
          [intake.checks.previewRoundtrip.glb, path.join(root, "intake", "review.glb")],
          [complete.glb, path.join(root, "complete", "model.glb")],
        ] as const) {
          expect(inventory).toMatchObject({
            bytes: (await stat(file)).size, meshPrimitives: 3, embeddedImages: 1, textures: 1,
            textureSources: [{ source: 0 }],
          });
          expect(inventory.materialTextureSlots).toContainEqual({
            name: "CheckerMaterial", slots: { baseColorTexture: 0 },
          });
        }
        expect(complete, JSON.stringify(complete)).toMatchObject({
          passed: true,
          requiredClips: clips,
          expectedClips: clips,
          exportedClips: clips,
          missingMaterials: [],
          missingTexturedMaterials: [],
          missingRequiredClips: [],
        });
        expect(complete.playback).toHaveLength(3);
        expect(Math.max(...complete.sizeError, complete.boundsError)).toBeLessThan(complete.boundsTolerance);
        expect(complete.previews).toEqual(
          expect.arrayContaining(["review-front.png", "review-side.png"]),
        );
        const view = await readFile(
          path.join(root, "complete", "review-front.png"),
        );
        expect(view.subarray(1, 4).toString("ascii")).toBe("PNG");
        for (const clip of complete.playback) {
          expect(clip.passed).toBe(true);
          expect(clip.sampledVertexDisplacement).toBeGreaterThan(0.001);
          if (clip.name !== "Trigger") expect(clip.motionReview).toBeUndefined();
        }
        const phases: { frame: number; file: string }[] = complete.playback.find((clip: { name: string }) => clip.name === "Trigger").motionReview;
        expect(phases.map(phase => phase.file)).toEqual([1, 2, 3].map(i => `motion-01-0${i}-three-quarter.png`));
        expect(phases[0]!.frame).toBeLessThan(phases[1]!.frame);
        expect(phases[1]!.frame).toBeLessThan(phases[2]!.frame);
        const { default: sharp } = await import("sharp");
        const alpha = await Promise.all(phases.map(phase => sharp(path.join(root, "complete", phase.file)).extractChannel(3).raw().toBuffer()));
        expect(alpha.slice(1).some(data => data.some((value, i) => Math.abs(value - alpha[0]![i]!) > 64))).toBe(true);
        const incomplete = (await stage(
          path.join(root, "stalled.blend"),
          "incomplete",
          ["Sway", "Jammed", "Attack"],
          "export", ["UnknownClip"],
        )).checks.roundtrip;
        expect(incomplete.passed).toBe(false);
        expect(incomplete.missingRequiredClips).toContain("Attack");
        expect(incomplete.missingMotionReviewClips).toEqual(["UnknownClip"]);
        // Depending on the exporter, a constant action is dropped or delivered as a stationary clip.
        expect(
          incomplete.missingRequiredClips.includes("Jammed") ||
            incomplete.playback.some(
              (clip: { name: string; passed: boolean }) =>
                clip.name === "Jammed" && !clip.passed,
            ),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!blender)(
    "preserves packed textures, hierarchy, skin animation and morph targets in delivered GLBs",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-blender-assets-"),
      );
      try {
        const source = path.join(directory, "assets.blend");
        await run(
          blender!,
          [
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            path.resolve("test/fixtures/blender-assets.py"),
            "--",
            source,
          ],
          { timeout: 60_000 },
        );
        const original = await readFile(source);
        const exported = async (collection: string) => {
          const output = path.join(directory, `${collection}.glb`);
          await run(
            blender!,
            [
              "--background",
              source,
              "--python-exit-code",
              "1",
              "--python",
              path.resolve(
                "plugins/blender/skills/blender-assets/scripts/export_glb.py",
              ),
              "--",
              "--output",
              output,
              "--collection",
              collection,
            ],
            { timeout: 60_000 },
          );
          return new NodeIO().read(output);
        };

        await expect(exported("Backups")).rejects.toMatchObject({ code: 1 });
        const staticRoot = (await exported("StaticAsset")).getRoot();
        const prop = staticRoot
          .listNodes()
          .find((node) => node.getName() === "TexturedProp")!;
        expect(staticRoot.listMeshes()).toHaveLength(1);
        expect(prop.getParentNode()?.getName()).toBe("AssetRoot");
        // Blender Z-up is converted to glTF Y-up, retaining the parent's transforms.
        prop
          .getWorldTranslation()
          .forEach((value, axis) =>
            expect(value).toBeCloseTo([3, 1, 1.5][axis]!, 5),
          );
        const primitive = prop.getMesh()!.listPrimitives()[0]!;
        expect(primitive.getAttribute("TEXCOORD_0")?.getCount()).toBe(
          primitive.getAttribute("POSITION")!.getCount(),
        );
        const material = primitive.getMaterial()!;
        expect(material.getMetallicFactor()).toBeCloseTo(0.2);
        expect(material.getRoughnessFactor()).toBeCloseTo(0.35);
        expect(material.getAlphaMode()).toBe("BLEND");
        expect(material.getBaseColorFactor()[3]).toBeCloseTo(0.5);
        const texture = material.getBaseColorTexture()!;
        expect(texture.getMimeType()).toBe("image/png");
        expect(Array.from(texture.getImage()!.slice(0, 8))).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        expect(staticRoot.listCameras()).toHaveLength(0);
        const excluded = new Set([
          "HiddenProp",
          "HiddenCollectionHelper",
          "AnimatedProp",
          "PresentationCamera",
          "PresentationLight",
        ]);
        expect(
          staticRoot.listNodes().filter((node) => excluded.has(node.getName())),
        ).toEqual([]);

        const animatedRoot = (await exported("AnimatedAsset")).getRoot();
        const animated = animatedRoot
          .listNodes()
          .find((node) => node.getName() === "AnimatedProp")!;
        const skin = animated.getSkin()!;
        expect(skin.listJoints().map((joint) => joint.getName())).toEqual([
          "Base",
          "Tip",
        ]);
        expect(skin.getInverseBindMatrices()?.getCount()).toBe(2);
        const mesh = animated.getMesh()!.listPrimitives()[0]!;
        expect(mesh.getAttribute("JOINTS_0")?.getCount()).toBe(
          mesh.getAttribute("POSITION")!.getCount(),
        );
        const weights = mesh.getAttribute("WEIGHTS_0")!;
        for (let index = 0; index < weights.getCount(); index++) {
          expect(
            weights
              .getElement(index, [])
              .reduce((sum, weight) => sum + weight, 0),
          ).toBeCloseTo(1);
        }
        expect(mesh.listTargets()).toHaveLength(1);
        expect(
          mesh.listTargets()[0]!.getAttribute("POSITION")?.getCount(),
        ).toBe(mesh.getAttribute("POSITION")!.getCount());
        expect(
          mesh.listTargets()[0]!.getAttribute("POSITION")!.getMax([])[1],
        ).toBeCloseTo(0.25);
        const animations = animatedRoot.listAnimations();
        expect(animations.map((animation) => animation.getName())).toEqual(
          expect.arrayContaining(["Sway", "Stretch"]),
        );
        const sway = animations.find(
          (animation) => animation.getName() === "Sway",
        )!;
        const rotation = sway
          .listChannels()
          .find(
            (channel) =>
              channel.getTargetNode()?.getName() === "Tip" &&
              channel.getTargetPath() === "rotation",
          )!;
        const sampler = rotation.getSampler()!;
        expect(sampler.getInput()!.getMax([])[0]).toBeGreaterThan(0);
        const rotations = sampler.getOutput()!;
        expect(
          new Set(
            Array.from({ length: rotations.getCount() }, (_, index) =>
              JSON.stringify(rotations.getElement(index, [])),
            ),
          ).size,
        ).toBeGreaterThan(1);
        const stretch = animations.find(
          (animation) => animation.getName() === "Stretch",
        )!;
        const morph = stretch
          .listChannels()
          .find(
            (channel) =>
              channel.getTargetNode() === animated &&
              channel.getTargetPath() === "weights",
          )!;
        expect(morph.getSampler()!.getOutput()!.getMax([])[0]).toBeGreaterThan(
          0.9,
        );
        expect(await readFile(source)).toEqual(original);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!blender)(
    "exports a chosen collection, preserves the source, and refuses accidental overwrite",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-blender-export-"),
      );
      try {
        const source = path.join(directory, "source.blend");
        const output = path.join(directory, "game asset.glb");
        const fixture = path.join(directory, "fixture.py");
        await writeFile(
          fixture,
          `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
collection = bpy.data.collections.new("GameAsset")
bpy.context.scene.collection.children.link(collection)
bpy.ops.mesh.primitive_cube_add()
asset = bpy.context.object
asset.name = "GameProp"
asset.data.name = "GamePropMesh"
bevel = asset.modifiers.new("EdgeBevel", "BEVEL")
bevel.width = 0.1
bevel.segments = 2
for parent in list(asset.users_collection):
    parent.objects.unlink(asset)
collection.objects.link(asset)
bpy.ops.mesh.primitive_cube_add(location=(10, 0, 0))
bpy.context.object.name = "PresentationOnly"
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(source)})
`,
        );
        await run(
          blender!,
          ["--background", "--python-exit-code", "1", "--python", fixture],
          { timeout: 60_000 },
        );
        const digest = async (file: string) =>
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
        const sourceBefore = await digest(source);
        const args = [
          "--background",
          source,
          "--python-exit-code",
          "1",
          "--python",
          path.resolve(
            "plugins/blender/skills/blender-assets/scripts/export_glb.py",
          ),
          "--",
          "--output",
          output,
          "--collection",
          "GameAsset",
        ];
        await run(blender!, args, { timeout: 60_000 });
        const document = await new NodeIO().read(output);
        expect(
          document
            .getRoot()
            .listMeshes()
            .map((mesh) => mesh.getName()),
        ).toEqual(["GamePropMesh"]);
        expect(
          document
            .getRoot()
            .listNodes()
            .map((node) => node.getName()),
        ).toContain("GameProp");
        expect(
          document
            .getRoot()
            .listNodes()
            .map((node) => node.getName()),
        ).not.toContain("PresentationOnly");
        expect(await digest(source)).toBe(sourceBefore);
        const outputBefore = await digest(output);
        await expect(
          run(blender!, args, { timeout: 60_000 }),
        ).rejects.toMatchObject({ code: 1 });
        expect(await digest(output)).toBe(outputBefore);
        await run(blender!, [...args, "--overwrite", "--apply-modifiers"], {
          timeout: 60_000,
        });
        const baked = await new NodeIO().read(output);
        expect(baked.getRoot().listMeshes()).toHaveLength(1);
        expect(
          baked
            .getRoot()
            .listMeshes()[0]!
            .listPrimitives()[0]!
            .getAttribute("POSITION")!
            .getCount(),
        ).toBeGreaterThan(
          document
            .getRoot()
            .listMeshes()[0]!
            .listPrimitives()[0]!
            .getAttribute("POSITION")!
            .getCount(),
        );
        const bakedBefore = await digest(output);
        const badScope = args.map((value) =>
          value === "GameAsset" ? "MissingCollection" : value,
        );
        await expect(
          run(blender!, [...badScope, "--overwrite"], { timeout: 60_000 }),
        ).rejects.toMatchObject({ code: 1 });
        expect(await digest(output)).toBe(bakedBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
