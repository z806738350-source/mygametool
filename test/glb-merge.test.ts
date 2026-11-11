import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import { mergeGlbAnimations } from "../src/daemon/glb-merge.js";
import { GLB_LIMITS, preflightGlb } from "../src/daemon/glb-preflight.js";
import {
  inspectModel3D,
  inspectModel3DAnimationBatch,
  mergeModel3DBatches,
} from "../src/daemon/model3d-inspect.js";
import { mergeAnimationClips } from "../src/daemon/merge-animations.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function encode(json: any, bin: Uint8Array): Buffer {
  const text = JSON.stringify(json),
    length = Math.ceil(Buffer.byteLength(text) / 4) * 4,
    paddedBin = Math.ceil(bin.byteLength / 4) * 4;
  const bytes = Buffer.alloc(28 + length + paddedBin);
  bytes.write("glTF");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(32, 20, 20 + length);
  bytes.write(text, 20, "utf8");
  bytes.writeUInt32LE(paddedBin, 20 + length);
  bytes.writeUInt32LE(0x004e4942, 24 + length);
  bytes.set(bin, 28 + length);
  return bytes;
}
function rewrite(
  bytes: Buffer,
  change: (json: any, bin: Buffer) => void,
): Buffer {
  const length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.toString("utf8", 20, 20 + length)),
    bin = Buffer.from(bytes.subarray(28 + length));
  change(json, bin);
  return encode(json, bin);
}
function floatData(values: number[]): Float32Array<ArrayBuffer> {
  return new Float32Array(values);
}
async function fixture(names: string[]): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene("Scene"),
    character = doc.createNode("Character"),
    root = doc.createNode("Root"),
    tip = doc.createNode("Tip");
  root.addChild(tip);
  scene.addChild(character).addChild(root);
  const accessor = (
    values: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>,
    type: "SCALAR" | "VEC2" | "VEC3" | "VEC4" | "MAT4",
  ) => doc.createAccessor().setArray(values).setType(type).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      accessor(floatData([0, 0, 0, 1, 0, 0, 0, 1, 0]), "VEC3"),
    )
    .setAttribute(
      "JOINTS_0",
      accessor(new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]), "VEC4"),
    )
    .setAttribute(
      "WEIGHTS_0",
      accessor(floatData([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), "VEC4"),
    );
  const texture = doc
    .createTexture()
    .setMimeType("image/png")
    .setImage(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB84AAAAASUVORK5CYII=",
        "base64",
      ),
    );
  primitive
    .setAttribute("TEXCOORD_0", accessor(floatData([0, 0, 1, 0, 0, 1]), "VEC2"))
    .setMaterial(doc.createMaterial().setBaseColorTexture(texture));
  primitive.addTarget(
    doc
      .createPrimitiveTarget()
      .setAttribute(
        "POSITION",
        accessor(floatData([0, 0, 0, 0, 0, 0.1, 0, 0, 0.2]), "VEC3"),
      ),
  );
  primitive.addTarget(
    doc
      .createPrimitiveTarget()
      .setAttribute(
        "POSITION",
        accessor(floatData([0, 0, 0, 0.3, 0, 0, 0.4, 0, 0]), "VEC3"),
      ),
  );
  const mesh = doc.createMesh().addPrimitive(primitive).setWeights([0, 0]);
  character.setMesh(mesh);
  const inverse = new Float32Array(32);
  for (let matrix = 0; matrix < 2; matrix++)
    for (let column = 0; column < 4; column++)
      inverse[matrix * 16 + column * 5] = 1;
  character.setSkin(
    doc
      .createSkin()
      .addJoint(root)
      .addJoint(tip)
      .setSkeleton(root)
      .setInverseBindMatrices(accessor(inverse, "MAT4")),
  );
  const times = accessor(floatData([0, 0.5, 1]), "SCALAR");
  for (const [index, name] of names.entries()) {
    const clip = doc.createAnimation(name);
    const channel = (
      path: "translation" | "rotation" | "scale" | "weights",
      target: typeof root,
      values: number[],
      type: "SCALAR" | "VEC3" | "VEC4",
      interpolation: "LINEAR" | "STEP" | "CUBICSPLINE",
    ) => {
      const sampler = doc
        .createAnimationSampler()
        .setInput(times)
        .setOutput(accessor(floatData(values), type))
        .setInterpolation(interpolation);
      clip
        .addSampler(sampler)
        .addChannel(
          doc
            .createAnimationChannel()
            .setTargetNode(target)
            .setTargetPath(path)
            .setSampler(sampler),
        );
    };
    channel(
      "translation",
      root,
      [0, 0, 0, index + 0.25, 0, 0, index + 0.5, 0, 0],
      "VEC3",
      "LINEAR",
    );
    channel(
      "scale",
      tip,
      [1, 1, 1, 1.1, 1.2, 1.3, 1.2, 1.3, 1.4],
      "VEC3",
      "STEP",
    );
    channel(
      "rotation",
      tip,
      [
        0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.995, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      ],
      "VEC4",
      "CUBICSPLINE",
    );
    channel(
      "weights",
      character,
      [0, 0, 0.2, 0.3, 0.4, 0.5],
      "SCALAR",
      "LINEAR",
    );
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
async function clipData(bytes: Buffer) {
  preflightGlb(bytes); // Never hand an unadmitted fixture to the independent reader.
  const doc = await new NodeIO().readBinary(bytes);
  return doc
    .getRoot()
    .listAnimations()
    .map((clip) => ({
      name: clip.getName(),
      channels: clip.listChannels().map((channel) => {
        const sampler = channel.getSampler()!;
        return {
          target: channel.getTargetNode()!.getName(),
          path: channel.getTargetPath(),
          interpolation: sampler.getInterpolation(),
          input: Array.from(sampler.getInput()!.getArray()!),
          output: Array.from(sampler.getOutput()!.getArray()!),
        };
      }),
    }));
}
function reordered(bytes: Buffer): Buffer {
  return rewrite(bytes, (json) => {
    const order = [2, 0, 1],
      map = new Map(order.map((old, index) => [old, index]));
    json.nodes = order.map((index) => json.nodes[index]);
    for (const node of json.nodes)
      if (node.children)
        node.children = node.children.map((index: number) => map.get(index));
    for (const scene of json.scenes)
      scene.nodes = scene.nodes.map((index: number) => map.get(index));
    for (const skin of json.skins) {
      skin.joints = skin.joints.map((index: number) => map.get(index));
      if (skin.skeleton !== undefined) skin.skeleton = map.get(skin.skeleton);
    }
    for (const clip of json.animations)
      for (const channel of clip.channels)
        channel.target.node = map.get(channel.target.node);
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});

describe("bounded incremental GLB merge", () => {
  it.each([12, 20, 30])(
    "preserves every curve and the base model across %i clips and serial batches",
    async (count) => {
      const batches: Buffer[] = [];
      for (let index = 0; index < count; index += 10)
        batches.push(
          await fixture(
            Array.from(
              { length: Math.min(10, count - index) },
              (_, offset) => `Action_${index + offset}`,
            ),
          ),
        );
      const originals = batches.map(sha),
        expected = (await Promise.all(batches.map(clipData))).flat(),
        bytes = await mergeAnimationClips(batches),
        actual = await clipData(bytes);
      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(count);
      expect(batches.map(sha)).toEqual(originals);
      const original = preflightGlb(batches[0]!),
        merged = preflightGlb(bytes);
      expect(merged.json.meshes).toEqual(original.json.meshes);
      expect(merged.json.materials).toEqual(original.json.materials);
      expect(merged.json.nodes).toEqual(original.json.nodes);
      expect(merged.json.skins).toEqual(original.json.skins);
      expect(Buffer.from(merged.bin.subarray(0, original.bin.length))).toEqual(
        Buffer.from(original.bin),
      );
      expect(await inspectModel3D(bytes)).toMatchObject({
        triangles: 1,
        textured: true,
        rigged: true,
        animations: expected.map((clip) => clip.name),
      });
      // Output metadata must not replace the base SHA cache entry.
      expect((await inspectModel3D(batches[0]!)).animations).toHaveLength(
        Math.min(count, 10),
      );
    },
  );
  it("maps reordered node arrays by full ancestry and normalizes absent default TRS", async () => {
    const base = await fixture(["A"]),
      next = rewrite(reordered(await fixture(["B"])), (json) => {
        const root = json.nodes.find((node: any) => node.name === "Root");
        root.translation = [0, 0, 0];
        root.rotation = [0, 0, 0, 1];
        root.scale = [1, 1, 1];
      });
    const result = await mergeModel3DBatches(base, next);
    expect(await clipData(result.bytes)).toEqual([
      ...(await clipData(base)),
      ...(await clipData(next)),
    ]);
    expect(result.proof.inputSha256).toEqual([sha(base), sha(next)]);
    expect(result.proof.outputSha256).toBe(sha(result.bytes));
  });
  it("preserves duplicate named clips with deterministic reported renames and distinct curves", async () => {
    const base = await fixture(["Idle", "Idle_2"]),
      next = await fixture(["Idle", "Idle"]),
      first = await mergeModel3DBatches(base, next),
      second = await mergeModel3DBatches(base, next);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.proof).toEqual(second.proof);
    expect(first.metadata.animations).toEqual([
      "Idle",
      "Idle_2",
      "Idle_3",
      "Idle_4",
    ]);
    expect(first.proof.renamedClips).toEqual([
      { input: 1, index: 0, from: "Idle", to: "Idle_3" },
      { input: 1, index: 1, from: "Idle", to: "Idle_4" },
    ]);
    expect(
      (await clipData(first.bytes)).map(({ channels }) => channels),
    ).toEqual(
      [...(await clipData(base)), ...(await clipData(next))].map(
        ({ channels }) => channels,
      ),
    );
  });
  it("copies shared source accessors and views once without widening array layouts", async () => {
    const base = await fixture(["Base"]),
      next = await fixture(
        Array.from({ length: 10 }, (_, index) => `Next_${index}`),
      ),
      result = mergeGlbAnimations([base, next]);
    expect(result.proof.copiedAccessors).toBe(41); // one shared time accessor plus four outputs per clip
    expect(result.proof.copiedViews).toBeLessThan(result.proof.copiedAccessors);
    expect(result.checked.summary.readerAllocationBytes).toBeLessThanOrEqual(
      GLB_LIMITS.readerAllocationBytes,
    );
    expect((await clipData(Buffer.from(result.bytes))).slice(1)).toEqual(
      await clipData(next),
    );
  });
  it.each([
    "rest",
    "parent",
    "joint-order",
    "inverse-bind",
    "morph-order",
    "geometry",
    "asset-extras",
  ])(
    "rejects incompatible %s without changing either original",
    async (kind) => {
      const base = await fixture(["A"]),
        next = rewrite(await fixture(["B"]), (json, bin) => {
          if (kind === "rest")
            json.nodes.find((node: any) => node.name === "Tip").translation = [
              1, 0, 0,
            ];
          if (kind === "parent") {
            json.nodes.find((node: any) => node.name === "Root").children = [];
            json.nodes.find((node: any) => node.name === "Character").children =
              [json.nodes.findIndex((node: any) => node.name === "Tip")];
          }
          if (kind === "joint-order") json.skins[0].joints.reverse();
          if (kind === "inverse-bind" || kind === "geometry") {
            const accessor =
                json.accessors[
                  kind === "inverse-bind"
                    ? json.skins[0].inverseBindMatrices
                    : json.meshes[0].primitives[0].attributes.POSITION
                ],
              view = json.bufferViews[accessor.bufferView],
              start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
            bin.writeFloatLE(2, start);
          }
          if (kind === "morph-order")
            json.meshes[0].primitives[0].targets.reverse();
          if (kind === "asset-extras")
            json.asset.extras = { units: "different" };
        }),
        before = [sha(base), sha(next)];
      expect(() => mergeGlbAnimations([base, next])).toThrow("differs");
      expect([sha(base), sha(next)]).toEqual(before);
    },
  );
  it.each([
    "unnamed-node",
    "duplicate-root",
    "duplicate-sibling",
    "empty-clips",
    "empty-channels",
    "same-target",
    "mixed-rest",
    "codec",
  ])("rejects unprovable %s", async (kind) => {
    const base = await fixture(["A"]),
      next = rewrite(await fixture(["B"]), (json) => {
        if (kind === "unnamed-node") delete json.nodes[0].name;
        if (kind === "duplicate-root")
          json.nodes.find((node: any) => node.name === "Character").name =
            "Root";
        if (kind === "duplicate-sibling") {
          const root = json.nodes.find((node: any) => node.name === "Root"),
            sibling = json.nodes.length;
          json.nodes.push({ name: "Tip" });
          root.children.push(sibling);
        }
        if (kind === "empty-clips") json.animations = [];
        if (kind === "empty-channels") json.animations[0].channels = [];
        if (kind === "same-target")
          json.animations[0].channels.push(
            structuredClone(json.animations[0].channels[0]),
          );
        if (kind === "mixed-rest")
          ((json.nodes[0].matrix = [
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ]),
            (json.nodes[0].translation = [0, 0, 0]));
        if (kind === "codec")
          json.meshes[0].primitives[0].extensions = {
            KHR_draco_mesh_compression: {
              bufferView: 0,
              attributes: { POSITION: 0 },
            },
          };
      });
    expect(() => mergeGlbAnimations([base, next])).toThrow();
  });
  it.each(["negative", "duplicate", "sparse-duplicate"])(
    "rejects %s sample times before invoking a reader",
    async (kind) => {
      const base = await fixture(["A"]);
      let next = await fixture(["B"]);
      if (kind === "sparse-duplicate") {
        const checked = preflightGlb(next),
          json = checked.json,
          accessor = json.accessors[json.animations[0].samplers[0].input],
          offset = checked.bin.length;
        const extra = Buffer.alloc(8);
        extra[0] = 1; // override sample 1 with zero, duplicating sample 0
        const index = json.bufferViews.length;
        json.bufferViews.push(
          { buffer: 0, byteOffset: offset, byteLength: 4 },
          { buffer: 0, byteOffset: offset + 4, byteLength: 4 },
        );
        accessor.sparse = {
          count: 1,
          indices: { bufferView: index, byteOffset: 0, componentType: 5121 },
          values: { bufferView: index + 1, byteOffset: 0 },
        };
        json.buffers[0].byteLength = offset + 8;
        next = encode(json, Buffer.concat([Buffer.from(checked.bin), extra]));
      } else
        next = rewrite(next, (json, bin) => {
          const accessor = json.accessors[json.animations[0].samplers[0].input],
            view = json.bufferViews[accessor.bufferView],
            start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
          bin.writeFloatLE(
            kind === "negative" ? -1 : 0,
            start + (kind === "negative" ? 0 : 4),
          );
        });
      expect(() => mergeGlbAnimations([base, next])).toThrow(
        "strictly increasing",
      );
    },
  );
  it("keeps sparse and interleaved animation output semantics and original typed bytes", async () => {
    const base = await fixture(["A"]),
      source = preflightGlb(await fixture(["B"])),
      json = source.json,
      output = json.accessors[json.animations[0].samplers[0].output],
      old = json.bufferViews[output.bufferView],
      start = (old.byteOffset ?? 0) + (output.byteOffset ?? 0),
      packed = Buffer.alloc(48);
    for (let row = 0; row < 3; row++)
      packed.set(
        source.bin.subarray(start + row * 12, start + row * 12 + 12),
        row * 16,
      );
    const offset = source.bin.length,
      view = json.bufferViews.length;
    json.bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: packed.length,
      byteStride: 16,
    });
    output.bufferView = view;
    output.byteOffset = 0;
    const sparse = Buffer.alloc(16);
    sparse[0] = 1;
    sparse.writeFloatLE(7, 4);
    sparse.writeFloatLE(8, 8);
    sparse.writeFloatLE(9, 12);
    const sparseView = json.bufferViews.length;
    json.bufferViews.push(
      { buffer: 0, byteOffset: offset + packed.length, byteLength: 4 },
      { buffer: 0, byteOffset: offset + packed.length + 4, byteLength: 12 },
    );
    output.sparse = {
      count: 1,
      indices: { bufferView: sparseView, byteOffset: 0, componentType: 5121 },
      values: { bufferView: sparseView + 1, byteOffset: 0 },
    };
    json.buffers[0].byteLength += packed.length + sparse.length;
    const next = encode(
        json,
        Buffer.concat([Buffer.from(source.bin), packed, sparse]),
      ),
      merged = mergeGlbAnimations([base, next]);
    expect((await clipData(Buffer.from(merged.bytes))).slice(1)).toEqual(
      await clipData(next),
    );
    const appended =
      merged.checked.json.accessors[
        merged.checked.json.animations[1].samplers[0].output
      ];
    expect(
      merged.checked.json.bufferViews[appended.bufferView].byteStride,
    ).toBe(16);
    expect(appended.sparse.count).toBe(1);
  });
  it.each(["animation", "sampler", "channel", "target", "accessor", "view"])(
    "refuses opaque extras/extensions on relocated %s without altering original bytes",
    async (location) => {
      const base = await fixture(["A"]);
      for (const metadata of ["extras", "extensions"]) {
        const next = rewrite(await fixture(["B"]), (json) => {
            const animation = json.animations[0],
              sampler = animation.samplers[0],
              channel = animation.channels[0],
              accessor = json.accessors[sampler.output],
              record =
                location === "animation"
                  ? animation
                  : location === "sampler"
                    ? sampler
                    : location === "channel"
                      ? channel
                      : location === "target"
                        ? channel.target
                        : location === "accessor"
                          ? accessor
                          : json.bufferViews[accessor.bufferView];
            record[metadata] =
              metadata === "extras"
                ? { privateSourceIndex: 1 }
                : { KHR_materials_unlit: {} };
          }),
          before = [sha(base), sha(next)];
        expect(() => mergeGlbAnimations([base, next])).toThrow(
          "Opaque metadata",
        );
        expect([sha(base), sha(next)]).toEqual(before);
      }
    },
  );
  it("preserves equal metadata on unchanged asset, geometry and material records", async () => {
    const attach = (bytes: Buffer) =>
      rewrite(bytes, (json) => {
        json.asset.extras = { units: "metres" };
        json.meshes[0].extras = { targetNames: ["Left", "Right"] };
        json.materials[0].extras = { label: "original" };
      });
    const base = attach(await fixture(["A"])),
      next = attach(await fixture(["B"])),
      result = mergeGlbAnimations([base, next]);
    expect(result.checked.json.asset.extras).toEqual({ units: "metres" });
    expect(result.checked.json.meshes[0].extras).toEqual({
      targetNames: ["Left", "Right"],
    });
    expect(result.checked.json.materials[0].extras).toEqual({
      label: "original",
    });
  });
  it("rejects final reader amplification before any NodeIO allocation", async () => {
    const base = await fixture(["A"]),
      checked = preflightGlb(base),
      allowance =
        GLB_LIMITS.readerAllocationBytes -
        checked.summary.readerAllocationBytes -
        32;
    const inflated = rewrite(base, (json) => {
      json.accessors.push({
        type: "SCALAR",
        componentType: 5126,
        count: Math.floor(allowance / 4),
      });
    });
    preflightGlb(inflated); // pure, unused zero-fill accessor has no dense allocation
    const next = await fixture(["B"]);
    expect(() => mergeGlbAnimations([inflated, next])).toThrow("128 MiB");
  });
  it("rejects an over-limit merged BIN before allocating its output", async () => {
    const small = await fixture(["A"]),
      checked = preflightGlb(small),
      bin = Buffer.alloc(GLB_LIMITS.encodedBytes - 4096);
    bin.set(checked.bin);
    checked.json.buffers[0].byteLength = bin.length;
    const base = encode(checked.json, bin),
      next = await fixture(
        Array.from({ length: 10 }, (_, index) => `B_${index}`),
      );
    expect(base.length).toBeLessThanOrEqual(GLB_LIMITS.encodedBytes);
    expect(() => mergeGlbAnimations([base, next])).toThrow(
      /100 MiB|BIN exceeds/,
    );
  });
  it("admits separate input JSON budgets while enforcing the final 8 MiB JSON ceiling", async () => {
    const notes = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `note${index}`,
        "a".repeat(900_000),
      ]),
    );
    const base = rewrite(await fixture(["A"]), (json) => {
        json.asset.extras = notes;
      }),
      next = rewrite(await fixture(["B"]), (json) => {
        json.asset.extras = notes;
      });
    expect(base.readUInt32LE(12) + next.readUInt32LE(12)).toBeGreaterThan(
      GLB_LIMITS.jsonBytes,
    );
    const result = mergeGlbAnimations([base, next]);
    expect(result.checked.summary.jsonBytes).toBeLessThanOrEqual(
      GLB_LIMITS.jsonBytes,
    );
    expect(
      result.checked.json.animations.map((clip: any) => clip.name),
    ).toEqual(["A", "B"]);
  }, 15_000);
  it("admits a pair above 100 MiB while retaining one base BIN and bounded animation additions", async () => {
    const small = await fixture(["A"]),
      checked = preflightGlb(small),
      bin = Buffer.alloc(53 * 1024 * 1024);
    bin.set(checked.bin);
    checked.json.buffers[0].byteLength = bin.length;
    const base = encode(checked.json, bin),
      next = rewrite(base, (json) => {
        json.animations[0].name = "B";
      });
    expect(base.length + next.length).toBeGreaterThan(GLB_LIMITS.encodedBytes);
    const result = await mergeModel3DBatches(base, next);
    expect(result.bytes.length).toBeLessThan(54 * 1024 * 1024);
    expect(result.metadata.animations).toEqual(["A", "B"]);
    expect(result.proof.inputBytes).toBe(base.length + next.length);
  }, 15_000);
  it("cancels a queued pair and detects changed inputs/policy without retaining third batch copies", async () => {
    const base = await fixture(["A"]),
      next = await fixture(["B"]),
      controller = new AbortController(),
      pending = mergeModel3DBatches(base, next, controller.signal),
      rejected = expect(pending).rejects.toThrow("cancel pair");
    controller.abort(new Error("cancel pair"));
    await rejected;
    const altered = Buffer.from(next),
      changing = mergeModel3DBatches(base, altered);
    altered[altered.length - 1] ^= 1;
    await expect(changing).rejects.toThrow("changed");
    expect((await mergeModel3DBatches(base, next)).metadata.animations).toEqual(
      ["A", "B"],
    );
  });
  it.each([
    "opaque-accessor",
    "normalized-curve",
    "unnamed",
    "duplicate-time",
    "empty-channel",
    "mixed-rest",
  ])(
    "checks strict first-batch %s eligibility despite a cached generic inspection",
    async (kind) => {
      const bytes = rewrite(await fixture(["A"]), (json, bin) => {
        if (kind === "unnamed") delete json.nodes[0].name;
        if (kind === "opaque-accessor")
          json.accessors[json.animations[0].samplers[0].output].extras = {
            sourceNodeIndex: 1,
          };
        if (kind === "normalized-curve")
          json.accessors[json.animations[0].samplers[0].output].normalized =
            true;
        if (kind === "empty-channel") json.animations[0].channels = [];
        if (kind === "mixed-rest") {
          json.nodes[0].matrix = [
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ];
          json.nodes[0].translation = [0, 0, 0];
        }
        if (kind === "duplicate-time") {
          const accessor = json.accessors[json.animations[0].samplers[0].input],
            view = json.bufferViews[accessor.bufferView];
          bin.writeFloatLE(
            0,
            (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + 4,
          );
        }
      });
      expect((await inspectModel3D(bytes)).animations).toEqual(["A"]);
      await expect(inspectModel3DAnimationBatch(bytes)).rejects.toThrow(
        "unsupported",
      );
    },
  );
  it("strictly admits a valid first batch without making a duplicate synthetic input", async () => {
    const bytes = await fixture(["A", "B"]),
      { Worker } = await import("node:worker_threads"),
      stop = vi.spyOn(Worker.prototype, "terminate");
    try {
      expect((await inspectModel3DAnimationBatch(bytes)).animations).toEqual([
        "A",
        "B",
      ]);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockRestore();
    }
  });
  it("counts pair input bytes against the shared queue even when there is only one active job", async () => {
    let created = 0,
      entered!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      second = new AbortController();
    class HoldingWorker extends EventEmitter {
      stdout = { resume() {} };
      stderr = { resume() {} };
      constructor() {
        super();
        created++;
        if (created === 1) entered();
        else
          queueMicrotask(() =>
            second.abort(new Error("unexpected second admission")),
          );
      }
      terminate() {
        return Promise.resolve(0);
      }
    }
    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ Worker: HoldingWorker }));
    const fresh = await import("../src/daemon/model3d-inspect.js"),
      payload = Buffer.alloc(51 * 1024 * 1024),
      controller = new AbortController();
    // Admission-only fixture; no reader consumes these bytes and no extra caller buffers are created.
    const pending = fresh.mergeModel3DBatches(
        payload,
        payload,
        controller.signal,
      ),
      rejected = expect(pending).rejects.toThrow("cancel held pair");
    try {
      await ready;
      expect(created).toBe(1);
      await expect(
        fresh.mergeModel3DBatches(payload, payload, second.signal),
      ).rejects.toThrow("queue is full");
      expect(created).toBe(1);
    } finally {
      controller.abort(new Error("cancel held pair"));
      second.abort();
      await rejected;
    }
  });
  it("transfers exactly a pair, enforces total queued bytes and latches unconfirmed termination", async () => {
    const base = await fixture(["A"]),
      next = await fixture(["B"]);
    let created = 0;
    class FailedWorker extends EventEmitter {
      stdout = { resume() {} };
      stderr = { resume() {} };
      constructor(_url: URL, options: any) {
        super();
        created++;
        expect(options.env).toEqual({});
        expect(options.workerData.mode).toBe("merge");
        expect(options.workerData.inputs).toHaveLength(2);
        expect(options.transferList).toHaveLength(2);
        queueMicrotask(() =>
          this.emit("error", new Error("private-error-canary")),
        );
      }
      terminate() {
        return Promise.reject(new Error("private-exit-canary"));
      }
    }
    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ Worker: FailedWorker }));
    const fresh = await import("../src/daemon/model3d-inspect.js"),
      error = await fresh
        .mergeModel3DBatches(base, next)
        .catch((error) => error);
    expect(fresh.isModel3DParserUncertain(error)).toBe(true);
    expect(error.message).not.toContain("canary");
    await expect(fresh.mergeModel3DBatches(base, next)).rejects.toThrow(
      "blocked",
    );
    expect(created).toBe(1);
  });
});
