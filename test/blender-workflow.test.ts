import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { temporaryTestDirectory } from "./temporary-test-directory.js";

const execute = promisify(execFile);
const blender = process.env.BLENDER_EXECUTABLE;
const pipeline = path.resolve(
  "plugins/blender/skills/blender-assets/scripts/pipeline.py",
);

// Real Blender is opt-in: ordinary unit tests must not launch host applications.
describe.skipIf(!blender)("Blender production stages", () => {
  it("publishes throttled live scene copies without modifying sources and keeps preview failures independent", async () => {
    const root = await temporaryTestDirectory("ohmygame-blender-live-");
    const script = path.join(root, "live-check.py");
    await writeFile(
      script,
      `import json, os, sys
from pathlib import Path
import bpy
sys.path.insert(0, ${JSON.stringify(path.dirname(pipeline))})
import live_preview
root = Path(${JSON.stringify(root)})
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name = "Original"
image = bpy.data.images.new("Texture", width=2, height=2)
image.filepath_raw = str(root / "texture.png")
image.file_format = "PNG"
image.save()
image.source = "FILE"
material = bpy.data.materials.new("Textured")
material.use_nodes = True
material.node_tree.nodes.new("ShaderNodeTexImage").image = image
bpy.context.object.data.materials.append(material)
bpy.ops.wm.save_as_mainfile(filepath=str(root / "source.blend"), compress=False)
source_bytes = (root / "source.blend").read_bytes()
source_path = bpy.data.filepath
save_version = bpy.context.preferences.filepaths.save_version
os.environ.pop("OHMYGAME_BLENDER_LIVE_DIR", None)
assert live_preview.checkpoint("Disabled", force=True) is False
assert not (root / "live").exists()
os.environ["OHMYGAME_BLENDER_LIVE_DIR"] = str(root / "live")
live_preview.monotonic = lambda: 0
assert live_preview.checkpoint("Initial shape", force=True) is True
assert bpy.data.filepath == source_path
assert bpy.context.preferences.filepaths.save_version == save_version
first = json.loads((root / "live/status.json").read_text())
bpy.ops.mesh.primitive_cube_add(location=(3, 0, 0))
bpy.context.object.name = "Second"
assert live_preview.checkpoint("Throttled") is False
assert json.loads((root / "live/status.json").read_text()) == first
live_preview.monotonic = lambda: 1.1
assert live_preview.checkpoint("Second part") is True
second = json.loads((root / "live/status.json").read_text())
assert second["sequence"] == first["sequence"] + 1
assert second["label"] == "Second part"
assert bpy.data.filepath == source_path
bpy.ops.mesh.primitive_cube_add(location=(6, 0, 0))
bpy.context.object.name = "Unsaved third"
replace = live_preview.os.replace
def broken_replace(source, destination):
    if Path(destination).name == "scene.blend":
        raise OSError("Synthetic observer snapshot failure")
    return replace(source, destination)
live_preview.os.replace = broken_replace
assert live_preview.checkpoint("Failed preview", force=True) is False
live_preview.os.replace = replace
assert live_preview.checkpoint("Disabled after failure", force=True) is False
failed = json.loads((root / "live/status.json").read_text())
assert all(failed[key] == value for key, value in second.items())
assert "Synthetic observer snapshot failure" in failed["error"]
assert bpy.data.filepath == source_path
assert len(bpy.context.scene.objects) == 3
assert (root / "source.blend").read_bytes() == source_bytes
assert sorted(p.name for p in (root / "live").iterdir()) == ["scene.blend", "status.json"]
bpy.ops.wm.open_mainfile(filepath=str(root / "live/scene.blend"), load_ui=False, use_scripts=False)
assert sorted(obj.name for obj in bpy.context.scene.objects) == ["Original", "Second"]
assert bpy.data.images["Texture"].packed_file is not None
(root / "verified.json").write_text(json.dumps({"first": first, "second": second, "failed": failed, "sourcePreserved": True}))
`,
    );
    const result = await execute(
      blender!,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code",
        "1",
        "--python",
        script,
      ],
      { timeout: 60000 },
    );
    expect(result.stderr.match(/LIVE_PREVIEW_ERROR/g)).toHaveLength(1);
    const verified = JSON.parse(
      await readFile(path.join(root, "verified.json"), "utf8"),
    );
    expect(verified).toMatchObject({
      first: { sequence: 1 },
      second: { sequence: 2, label: "Second part" },
      sourcePreserved: true,
    });
    expect(Number.isFinite(Date.parse(verified.second.updatedAt))).toBe(true);
  }, 75000);

  it("normalizes shared mesh instances without applying one instance transform to another", async () => {
    const root = await temporaryTestDirectory("ohmygame-blender-instances-");
    const document = new Document();
    const buffer = document.createBuffer();
    const positions = document
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const mesh = document
      .createMesh()
      .addPrimitive(
        document.createPrimitive().setAttribute("POSITION", positions),
      );
    document
      .createScene()
      .addChild(document.createNode("first").setMesh(mesh))
      .addChild(
        document.createNode("second").setMesh(mesh).setTranslation([2, 0, 0]),
      );
    await writeFile(
      path.join(root, "source.glb"),
      await new NodeIO().writeBinary(document),
    );
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ height: 1, previews: false, triangleBudget: 100 }),
    );
    await execute(
      blender!,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--python-exit-code",
        "1",
        "--python",
        pipeline,
        "--",
        "--stage",
        "clean",
        "--config",
        path.join(root, "config.json"),
        "--input",
        path.join(root, "source.glb"),
        "--input-dir",
        root,
        "--output-dir",
        path.join(root, "output"),
      ],
      { timeout: 60000 },
    );
    const report = JSON.parse(
      await readFile(path.join(root, "output", "report.json"), "utf8"),
    );
    expect(report.geometry.bounds.size).toEqual([3, 0, 1]);
    expect(report.geometry.meshes).toHaveLength(2);
    expect(report.technicalChecksPassed).toBe(true);
  }, 75000);

  it("preserves the source and delivers two playable clips through a clean roundtrip", async () => {
    const retainedRoot = process.env.BLENDER_ACCEPTANCE_OUTPUT;
    if (retainedRoot) await mkdir(retainedRoot, { recursive: true });
    const root = retainedRoot
      ? await mkdtemp(path.join(retainedRoot, "humanoid-"))
      : await temporaryTestDirectory("ohmygame-blender-workflow-");
    if (retainedRoot) console.info("Blender acceptance artifacts:", root);
    const joints: Record<string, number[]> = {
      hips: [0, 0, 0.9],
      spine: [0, 0, 1.1],
      chest: [0, 0, 1.4],
      neck: [0, 0, 1.5],
      head: [0, 0, 1.75],
    };
    const bones: {
      name: string;
      head: string;
      tail: string;
      parent?: string;
    }[] = [
      { name: "hips", head: "hips", tail: "spine" },
      { name: "spine", head: "spine", tail: "chest", parent: "hips" },
      { name: "head", head: "neck", tail: "head", parent: "spine" },
    ];
    const parts = [
      {
        name: "torso",
        size: [0.35, 0.2, 0.5],
        position: [0, 0, 1.2],
        color: [0.2, 0.5, 0.2],
      },
      {
        name: "head",
        size: [0.23, 0.2, 0.25],
        position: [0, 0, 1.625],
        color: [0.8, 0.55, 0.3],
      },
    ];
    const regions: { object: string; weights: Record<string, number> }[] = [
      { object: "torso", weights: { spine: 1 } },
      { object: "head", weights: { head: 1 } },
    ];
    for (const [side, sign] of [
      ["L", 1],
      ["R", -1],
    ] as const) {
      joints[`hip.${side}`] = [sign * 0.11, 0, 0.9];
      joints[`knee.${side}`] = [sign * 0.11, -0.035, 0.48];
      joints[`ankle.${side}`] = [sign * 0.11, 0, 0.09];
      joints[`toe.${side}`] = [sign * 0.11, -0.18, 0.06];
      joints[`shoulder.${side}`] = [sign * 0.22, 0, 1.4];
      joints[`elbow.${side}`] = [sign * 0.5, 0, 1.25];
      joints[`wrist.${side}`] = [sign * 0.7, 0, 1.1];
      bones.push(
        {
          name: `thigh.${side}`,
          head: `hip.${side}`,
          tail: `knee.${side}`,
          parent: "hips",
        },
        {
          name: `shin.${side}`,
          head: `knee.${side}`,
          tail: `ankle.${side}`,
          parent: `thigh.${side}`,
        },
        {
          name: `foot.${side}`,
          head: `ankle.${side}`,
          tail: `toe.${side}`,
          parent: `shin.${side}`,
        },
        {
          name: `arm.${side}`,
          head: `shoulder.${side}`,
          tail: `elbow.${side}`,
          parent: "spine",
        },
        {
          name: `forearm.${side}`,
          head: `elbow.${side}`,
          tail: `wrist.${side}`,
          parent: `arm.${side}`,
        },
      );
      for (const [name, size, position] of [
        [`thigh.${side}`, [0.12, 0.14, 0.38], [sign * 0.11, -0.02, 0.69]],
        [`shin.${side}`, [0.1, 0.12, 0.36], [sign * 0.11, -0.02, 0.285]],
        [`foot.${side}`, [0.13, 0.25, 0.1], [sign * 0.11, -0.07, 0.05]],
        [`arm.${side}`, [0.26, 0.1, 0.13], [sign * 0.36, 0, 1.325]],
        [`forearm.${side}`, [0.2, 0.09, 0.12], [sign * 0.6, 0, 1.175]],
      ] as [string, number[], number[]][]) {
        parts.push({ name, size, position, color: [0.3, 0.6, 0.4] });
        regions.push({ object: name, weights: { [name]: 1 } });
      }
    }
    const config = {
      parts,
      joints,
      bones,
      regions,
      weighting: "regions",
      previews: false,
      triangleBudget: 10000,
      stressPoses: [{ name: "raise-arm", rotations: { "arm.L": [0, 0, 60] } }],
      locomotion: {
        hips: "hips",
        frames: 24,
        fps: 24,
        stride: 0.18,
        lift: 0.05,
        poseRotations: { "arm.L": [-50, 0, 0], "arm.R": [-50, 0, 0] },
        swingRotations: { "arm.L": [0, 0, 6], "arm.R": [0, 0, -6] },
        left: {
          upper: "thigh.L",
          lower: "shin.L",
          foot: "foot.L",
          contactPoint: [0.11, -0.07, 0],
        },
        right: {
          upper: "thigh.R",
          lower: "shin.R",
          foot: "foot.R",
          contactPoint: [-0.11, -0.07, 0],
        },
      },
    };
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config));
    const run = async (
      stage: string,
      input?: string,
      outputName = stage,
      settingsPath = configPath,
    ) => {
      const output = path.join(root, outputName);
      const liveDirectory = path.join(root, "live-" + outputName);
      await execute(
        blender!,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python",
          pipeline,
          "--",
          "--stage",
          stage,
          "--config",
          settingsPath,
          "--input-dir",
          root,
          "--output-dir",
          output,
          ...(input ? ["--input", input] : []),
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, OHMYGAME_BLENDER_LIVE_DIR: liveDirectory },
        },
      );
      const status = JSON.parse(
        await readFile(path.join(liveDirectory, "status.json"), "utf8"),
      );
      expect(status).toMatchObject({ label: "Finished stage: " + stage });
      expect(status.error).toBeUndefined();
      expect(status.sequence).toBeGreaterThanOrEqual(2);
      expect(
        (await stat(path.join(liveDirectory, "scene.blend"))).size,
      ).toBeGreaterThan(0);
      const report = JSON.parse(
        await readFile(path.join(output, "report.json"), "utf8"),
      );
      expect(report.outputs).not.toContain("status.json");
      expect(report.outputs).not.toContain("scene.pending.blend");
      return report;
    };
    expect((await run("parts")).technicalChecksPassed).toBe(true);
    const source = path.join(root, "parts", "scene.blend");
    const original = await readFile(source);
    expect(original.subarray(0, 7).toString()).toBe("BLENDER");
    expect((await run("clean", source)).technicalChecksPassed).toBe(true);
    const reviewConfig = path.join(root, "review-config.json");
    await writeFile(
      reviewConfig,
      JSON.stringify({ ...config, previews: true, previewSize: 64 }),
    );
    const jointReview = await run(
      "joints",
      path.join(root, "clean", "scene.blend"),
      "joints",
      reviewConfig,
    );
    expect(jointReview.technicalChecksPassed).toBe(true);
    expect(jointReview.previews).toEqual([
      "review-front.png",
      "review-side.png",
    ]);
    expect(jointReview.checks.regions.previews).toEqual([
      "regions-front.png",
      "regions-side.png",
    ]);
    const rig = await run("rig", path.join(root, "joints", "scene.blend"));
    expect(rig.checks.rig).toMatchObject({
      passed: true,
      unweightedVertices: 0,
      nonNormalizedVertices: 0,
    });
    const animation = await run(
      "animate",
      path.join(root, "rig", "scene.blend"),
    );
    expect(
      animation.checks.animation.clips.map(
        (clip: { name: string }) => clip.name,
      ),
    ).toEqual(["Idle", "Walk"]);
    expect(
      animation.checks.animation,
      JSON.stringify(animation.checks.animation),
    ).toMatchObject({ passed: true });
    for (const stage of ["parts", "clean", "joints", "rig", "animate"]) {
      const report = JSON.parse(
        await readFile(path.join(root, stage, "report.json"), "utf8"),
      );
      expect(report).toMatchObject({
        previewModel: "review.glb",
        humanReview: "pending",
        checks: { previewRoundtrip: { passed: true } },
      });
      expect(report.outputs).toContain("review.glb");
      const preview = (
        await new NodeIO().read(path.join(root, stage, "review.glb"))
      ).getRoot();
      expect(preview.listMeshes()).toHaveLength(parts.length);
      expect(
        preview
          .listNodes()
          .filter((node) => node.getMesh())
          .map((node) => node.getName())
          .sort(),
      ).toEqual(parts.map((part) => part.name).sort());
      expect(preview.listCameras()).toHaveLength(0);
      expect(preview.listMaterials()).toHaveLength(parts.length);
      expect(preview.listSkins()).toHaveLength(
        ["rig", "animate"].includes(stage) ? 1 : 0,
      );
      expect(preview.listAnimations().map((clip) => clip.getName())).toEqual(
        stage === "animate" ? ["Idle", "Walk"] : [],
      );
      if (stage === "animate") {
        expect(report.checks.previewRoundtrip.playback).toHaveLength(2);
        for (const sample of report.checks.previewRoundtrip.playback)
          expect(sample.sampledVertexDisplacement).toBeGreaterThan(0.000001);
        for (const clip of preview.listAnimations()) {
          const times = clip
            .listSamplers()
            .flatMap((sampler) => Array.from(sampler.getInput()!.getArray()!));
          expect(Math.min(...times)).toBe(0);
          expect(Math.max(...times)).toBeCloseTo(1, 6);
        }
      }
    }
    const exported = await run(
      "export",
      path.join(root, "animate", "scene.blend"),
    );
    expect(
      exported.checks.roundtrip,
      JSON.stringify(exported.checks.roundtrip),
    ).toMatchObject({ passed: true, exportedClips: ["Idle", "Walk"] });
    expect(await readFile(source)).toEqual(original);
    const model = await new NodeIO().read(
      path.join(root, "export", "model.glb"),
    );
    expect(model.getRoot().listSkins()).toHaveLength(1);
    expect(
      model
        .getRoot()
        .listAnimations()
        .map((clip) => clip.getName()),
    ).toEqual(["Idle", "Walk"]);
    for (const clip of model.getRoot().listAnimations()) {
      const times = clip
        .listSamplers()
        .flatMap((sampler) => Array.from(sampler.getInput()!.getArray()!));
      expect(Math.min(...times)).toBe(0);
      expect(Math.max(...times)).toBeCloseTo(1, 6);
      expect(
        clip.listChannels().some((channel) => {
          const data = channel.getSampler()?.getOutput()?.getArray();
          return (
            data &&
            Array.from(data).some(
              (value, index) =>
                index > 3 &&
                Math.abs(
                  value -
                    data[
                      index % (channel.getTargetPath() === "rotation" ? 4 : 3)
                    ]!,
                ) > 0.00001,
            )
          );
        }),
      ).toBe(true);
    }
    expect(
      (await stat(path.join(root, "export", "scene.blend"))).size,
    ).toBeGreaterThan(1000);
    expect(
      (await readFile(path.join(root, "export", "scene.blend")))
        .subarray(0, 7)
        .toString(),
    ).toBe("BLENDER");
    const incompleteConfig = path.join(root, "incomplete-config.json");
    await writeFile(
      incompleteConfig,
      JSON.stringify({ ...config, stressPoses: [] }),
    );
    const incomplete = await run(
      "rig",
      path.join(root, "clean", "scene.blend"),
      "incomplete-rig",
      incompleteConfig,
    );
    expect(incomplete).toMatchObject({
      technicalChecksPassed: false,
      checks: {
        rig: {
          passed: false,
          incomplete: expect.stringContaining("stressPoses"),
        },
      },
    });
    await writeFile(
      incompleteConfig,
      JSON.stringify({
        ...config,
        locomotion: {
          ...config.locomotion,
          left: { ...config.locomotion.left, contactPoint: undefined },
        },
      }),
    );
    await expect(
      run(
        "animate",
        path.join(root, "rig", "scene.blend"),
        "missing-contact",
        incompleteConfig,
      ),
    ).rejects.toThrow();
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "missing-contact", "report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      technicalChecksPassed: false,
      error: expect.stringContaining("contactPoint"),
    });
    // The same stage must not silently replace reviewed artifacts.
    await expect(run("parts")).rejects.toThrow();
  }, 360000);
});
