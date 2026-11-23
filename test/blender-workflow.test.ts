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
  it("loads an original FBX as editable quad geometry before cleanup", async () => {
    const root = await temporaryTestDirectory("ohmygame-blender-fbx-");
    const script = path.join(root, "fbx-source.py");
    await writeFile(script, `import sys
from pathlib import Path
import bpy
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(path.dirname(pipeline))})
import pipeline
root = Path(${JSON.stringify(root)}).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name = "QuadCrate"
material = bpy.data.materials.new("Paint")
material.use_nodes = True
image = bpy.data.images.new("CratePaint", 2, 2)
image.filepath_raw = str(root / "paint.png")
image.file_format = "PNG"
image.save()
image.source = "FILE"
image.pack()
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
bpy.context.object.data.materials.append(material)
source = root / "source.fbx"
bpy.ops.export_scene.fbx(filepath=str(source), use_triangles=False, embed_textures=True, path_mode="COPY")
(root / "paint.png").unlink()
bpy.ops.wm.read_factory_settings(use_empty=True)
pipeline.load_source(source, root)
meshes = pipeline.meshes()
assert len(meshes) == 1 and len(meshes[0].data.polygons) == 6
assert all(len(face.vertices) == 4 for face in meshes[0].data.polygons)
images = [node.image for mat in meshes[0].data.materials for node in mat.node_tree.nodes if node.type == "TEX_IMAGE"]
assert images and all(tuple(im.size) == (2, 2) for im in images)
print("RETAINED_QUAD_SOURCE")
`);
    const result = await execute(blender!, ["-b", "-t", "1", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "-P", script],
      { timeout: 45_000, maxBuffer: 1024 * 1024 });
    expect(result.stdout).toContain("RETAINED_QUAD_SOURCE");
  }, 50_000);

  it("keeps legacy custom checkpoints inert even with a live directory from an older launcher", async () => {
    const root = await temporaryTestDirectory("ohmygame-blender-headless-");
    const liveDirectory = path.join(root, "live");
    const script = path.join(root, "custom.py");
    await writeFile(script, `import sys
import bpy
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(path.dirname(pipeline))})
from live_preview import checkpoint
assert bpy.app.background
assert checkpoint("Initial shape") is False
assert checkpoint("Completed", force=True) is False
`);
    await execute(blender!, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script],
      { timeout: 45_000, env: { ...process.env, OHMYGAME_BLENDER_LIVE_DIR: liveDirectory } });
    await expect(stat(liveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 50_000);

  it("preserves hierarchy, pivots and mesh instances by default and applies explicit normalization once", async () => {
    const root = await temporaryTestDirectory("ohmygame-blender-instances-");
    const document = new Document();
    const positions = document.createAccessor().setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(document.createBuffer());
    const red = document.createMaterial("Paint").setBaseColorFactor([0.9, 0.025, 0.005, 1]).setMetallicFactor(0).setDoubleSided(true);
    const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute("POSITION", positions).setMaterial(red));
    const pivot = document.createNode("Axle").setTranslation([5, 2, 7]);
    const first = document.createNode("first").setMesh(mesh).setTranslation([1, 0, 3]);
    const second = document.createNode("second").setMesh(mesh).setTranslation([3, 0, 3]);
    document.createScene().addChild(pivot.addChild(first).addChild(second));
    const io = new NodeIO();
    const source = path.join(root, "source.glb");
    const configPath = path.join(root, "config.json");
    async function runStage(stage: string, name: string, config: Record<string, unknown>, input = source) {
      const output = path.join(root, name);
      if (input === source) await writeFile(source, await io.writeBinary(document));
      await writeFile(configPath, JSON.stringify({ previews: false, ...config }));
      await execute(blender!, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
        "--python", pipeline, "--", "--stage", stage, "--config", configPath, "--input", input,
        "--input-dir", root, "--output-dir", output], { timeout: 60000 });
      return JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    }
    const normalized = await runStage("clean", "normalized", { height: 1, triangleBudget: 100 });
    expect(normalized.geometry.bounds.size).toEqual([3, 0, 1]);
    expect(normalized.geometry.bounds.min).toEqual([-1.5, 0, 0]);
    expect(normalized.geometry.meshes).toHaveLength(2);
    expect(normalized.technicalChecksPassed).toBe(true);

    expect(normalized.checks.topology).toMatchObject({ policy: "inspect", boundaryEdges: 6 });
    const checked = await runStage("clean", "checked", { height: 2, yawDegrees: 180, previews: true, previewSize: 64, topologyPolicy: "watertight" });
    expect(checked.sourceGeometry.bounds.size).toEqual([3, 0, 1]);
    expect(checked.geometry.bounds.size[0]).toBeCloseTo(6);
    expect(checked.technicalChecksPassed).toBe(false);
    expect(checked.checks.topology).toMatchObject({ policy: "watertight", passed: false });
    const angles = ["front", "side", "back", "three-quarter"];
    expect(checked.sourcePreviews).toEqual(angles.map(angle => `source-${angle}.png`));
    expect(checked.previews).toEqual(angles.map(angle => `review-${angle}.png`));
    const { default: sharp } = await import("sharp");
    const alpha = (prefix: string, angle: string) => sharp(path.join(root, "checked", `${prefix}-${angle}.png`)).extractChannel(3).raw().toBuffer();
    for (const angle of ["front", "back", "three-quarter"]) {
      const before = await alpha("source", angle);
      const after = await alpha("review", angle);
      const pixels = before.filter(value => value > 127).length;
      expect(pixels).toBeGreaterThan(40);
      expect(pixels).toBeLessThan(64 * 64 * .8);
      const mismatch = before.filter((value, index) => (value > 127) !== (after[index]! > 127)).length;
      expect(mismatch / pixels).toBeLessThan(.06);
    }

    for (const prefix of ["source", "review"]) {
      const rgba = await sharp(path.join(root, "checked", `${prefix}-front.png`)).ensureAlpha().raw().toBuffer();
      let painted = 0;
      for (let pixel = 0; pixel < rgba.length; pixel += 4) {
        if (rgba[pixel + 3]! > 200 && rgba[pixel]! > 1.5 * rgba[pixel + 1]!) painted++;
      }
      expect(painted).toBeGreaterThan(40);
    }

    // A horizontal two-triangle kit with an off-center axle and linked, non-unit-scaled pieces.
    positions.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
    second.setScale([2, 1, 1]);
    const flat = await runStage("clean", "flat", { topologyPolicy: "allow-open" });
    expect(flat.geometry.triangles).toBe(2);
    expect(flat.geometry.bounds.size[2]).toBe(0);
    expect(flat.geometry.bounds.min[2]).toBe(2);
    expect(flat.technicalChecksPassed).toBe(true);
    const reviewed = (await io.read(path.join(root, "flat", "review.glb"))).getRoot();
    expect(reviewed.listMeshes()).toHaveLength(1);
    const nodes = reviewed.listNodes();
    const axle = nodes.find(node => node.getName() === "Axle");
    expect(axle?.getTranslation()).toEqual(pivot.getTranslation());
    for (const original of [first, second]) {
      const copy = nodes.find(node => node.getName() === original.getName());
      expect(copy?.getParentNode()).toBe(axle);
      expect(copy?.getMesh()).toBe(reviewed.listMeshes()[0]);
      expect(copy?.getTranslation()).toEqual(original.getTranslation());
      expect(copy?.getScale()).toEqual(original.getScale());
    }
    const binding = {
      joints: { a: [6, -10, 2], b: [7, -10, 2], c: [8, -10, 2], d: [9, -10, 2] },
      bones: [{ name: "A", head: "a", tail: "b" }, { name: "B", head: "c", tail: "d" }],
      regions: [{ object: "first", weights: { A: 1 } }, { object: "second", weights: { B: 1 } }],
      stressPoses: [{ name: "rotate first", rotations: { A: [0, 0, 60] } }],
    };
    const regionReport = await runStage("joints", "labeled", binding, path.join(root, "flat", "scene.blend"));
    expect(regionReport.technicalChecksPassed).toBe(true);
    expect((await io.read(path.join(root, "labeled", "review.glb"))).getRoot().listMeshes()).toHaveLength(1);
    const bound = await runStage("rig", "bound", binding, path.join(root, "labeled", "scene.blend"));
    expect(bound.technicalChecksPassed).toBe(true);
    expect(bound.geometry.bounds).toEqual(flat.geometry.bounds);
    const boundNodes = (await io.read(path.join(root, "bound", "review.glb"))).getRoot().listNodes();
    for (const [piece, bone] of [["first", "A"], ["second", "B"]]) {
      const node = boundNodes.find(node => node.getName() === piece)!;
      const joints = node.getMesh()!.listPrimitives()[0]!.getAttribute("JOINTS_0")!;
      const skin = node.getSkin()!;
      for (let i = 0; i < joints.getCount(); ++i) {
        expect(skin.listJoints()[joints.getElement(i, [])[0]!]!.getName()).toBe(bone);
      }
    }
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
        // These mirrored shoulder axes need the same local sign to swing in opposite world directions.
        swingRotations: { "arm.L": [0, 0, 12], "arm.R": [0, 0, 12] },
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
      await expect(stat(liveDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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
    const checkConfig = path.join(root, "rig-checks.json");
    const normalizedScene = path.join(root, "clean", "scene.blend");
    const partialRegions = [{ object: "torso", vertices: [0], weights: { spine: 1 } }];
    await writeFile(checkConfig, JSON.stringify({
      ...config, regions: partialRegions,
      joints: Object.fromEntries(Object.entries(joints).map(([name, [x, y, z]]) => [name, [x! + 10, y, z]])),
    }));
    const displaced = await run("joints", normalizedScene, "displaced", checkConfig);
    expect(displaced.technicalChecksPassed).toBe(false);
    expect(displaced.checks.skeleton.outsideDeformBones).toHaveLength(bones.length);
    expect(displaced.checks.regions).toMatchObject({
      coverage: "complete", unclassifiedVertices: displaced.geometry.vertices - 1, passed: false,
    });

    await writeFile(checkConfig, JSON.stringify({
      ...config, regions: partialRegions, weighting: "automatic", regionCoverage: "automatic-remainder",
      joints: { ...joints, control: [10, 0, 0], tip: [10, 0, 1] },
      bones: [...bones, { name: "Control", head: "control", tail: "tip", deform: false }],
    }));
    const partial = await run("joints", normalizedScene, "partial", checkConfig);
    expect(partial.technicalChecksPassed).toBe(true);
    expect(partial.checks.skeleton.outsideDeformBones).toEqual([]);
    expect(partial.checks.regions).toMatchObject({
      coverage: "automatic-remainder", unclassifiedVertices: partial.geometry.vertices - 1, passed: true,
    });

    await writeFile(checkConfig, JSON.stringify({
      ...config,
      regions: regions.map(rule => rule.object === "forearm.L" ? { ...rule, weights: { hips: 1 } } : rule),
      stressPoses: [
        { name: "unresponsive", rotations: { "forearm.L": [0, 0, 75] } },
        { name: "mixed", rotations: { "arm.R": [0, 0, 60], "forearm.L": [0, 0, 75] } },
      ],
    }));
    const misbound = await run("rig", normalizedScene, "misbound", checkConfig);
    expect(misbound.technicalChecksPassed).toBe(false);
    expect(misbound.checks.rig).toMatchObject({ passed: false, unweightedVertices: 0 });
    const [dead, mixed] = misbound.checks.rig.stressPoses;
    expect(dead).toMatchObject({ passed: false, movedVertices: 0, movedVerticesByBone: { "forearm.L": 0 } });
    expect(mixed).toMatchObject({ passed: false, movedVerticesByBone: { "forearm.L": 0 } });
    expect(mixed.movedVerticesByBone["arm.R"]).toBeGreaterThan(0);
    const animation = await run(
      "animate",
      path.join(root, "rig", "scene.blend"),
      "animate",
      reviewConfig,
    );
    const walkSamples = [1, 2, 3, 4].flatMap(index => ["front", "side"].map(angle => `walk-${index}-${angle}.png`));
    expect(animation.checks.animation.previews).toEqual(walkSamples);
    expect(animation.checks.animation.contactFootBones).toEqual([config.locomotion.left.foot, config.locomotion.right.foot]);
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
    await execute(blender!, ["-b", "-t", "1", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python-expr", `
import bpy, json, sys
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[-1])
with open(sys.argv[-2]) as config_file:
    joints = json.load(config_file)["joints"]
arm = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
data = arm.animation_data
for track in data.nla_tracks:
    track.mute = True

def pose(clip, phase):
    strip = data.nla_tracks[clip].strips[0]
    data.action = strip.action
    data.action_slot = strip.action_slot
    start, end = strip.action.frame_range
    bpy.context.scene.frame_set(round(start + phase * (end - start)))
    wrists, feet = [], []
    for side in ("L", "R"):
        shoulder = arm.pose.bones["arm." + side].head
        forearm = arm.pose.bones["forearm." + side]
        # glTF stores joint origins, so follow the fixture's wrist point on the forearm.
        rest_wrist = arm.matrix_world.inverted() @ Vector(joints["wrist." + side])
        wrist = forearm.matrix @ forearm.bone.matrix_local.inverted() @ rest_wrist
        wrists.append(-(arm.matrix_world.to_3x3() @ (wrist - shoulder)).y)
        feet.append(-(arm.matrix_world @ arm.pose.bones["foot." + side].head).y)
    return wrists, feet

idle, _ = pose("Idle", 0)
assert min(idle) > .1, ("Idle must retain the configured forward arm pose", idle)
for phase in (.25, .5, .75):
    idle_phase, _ = pose("Idle", phase)
    assert all(abs(a - b) < .001 for a, b in zip(idle_phase, idle)), ("Idle arm drift", idle_phase, idle)
for phase, lead in ((0, 1), (.5, -1)):
    wrists, feet = pose("Walk", phase)
    assert lead * (feet[0] - feet[1]) > .05, ("Expected leading foot", phase, feet)
    assert lead * (idle[0] - wrists[0]) > .03, ("Left wrist must oppose the left leg", phase, wrists, idle)
    assert lead * (wrists[1] - idle[1]) > .03, ("Right wrist must oppose the right leg", phase, wrists, idle)
`, "--", configPath, path.join(root, "export", "model.glb")], { timeout: 45_000 });
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
