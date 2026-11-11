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
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      );
      return JSON.parse(
        await readFile(path.join(output, "report.json"), "utf8"),
      );
    };
    expect((await run("parts")).technicalChecksPassed).toBe(true);
    const source = path.join(root, "parts", "scene.blend");
    const original = await readFile(source);
    expect(original.subarray(0, 7).toString()).toBe("BLENDER");
    expect((await run("clean", source)).technicalChecksPassed).toBe(true);
    expect(
      (await run("joints", path.join(root, "clean", "scene.blend")))
        .technicalChecksPassed,
    ).toBe(true);
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
