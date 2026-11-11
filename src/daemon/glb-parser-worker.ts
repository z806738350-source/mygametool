import { parentPort, workerData } from "node:worker_threads";
import { NodeIO, GLB_BUFFER } from "@gltf-transform/core";
import {
  KHRMaterialsUnlit,
  KHRTextureTransform,
  KHRMeshQuantization,
  EXTTextureWebP,
} from "@gltf-transform/extensions";
import {
  preflightGlb,
  packedGlbAccessor,
  glbSum,
  GLB_LIMITS,
  GlbPreflightError,
  type CheckedGlb,
} from "./glb-preflight.js";
import {
  mergeGlbAnimations,
  validateGlbAnimationBatch,
  type MergedGlb,
} from "./glb-merge.js";
import type { Model3DMetadata } from "../shared/contracts.js";

function encode(json: Record<string, any>, bin: Uint8Array): Uint8Array {
  const text = JSON.stringify(json),
    jsonBytes = Buffer.byteLength(text),
    paddedJson = Math.ceil(jsonBytes / 4) * 4,
    paddedBin = Math.ceil(bin.byteLength / 4) * 4;
  if (paddedJson > GLB_LIMITS.jsonBytes)
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "Transformed GLB JSON exceeds its inspection budget",
    );
  const total = glbSum(20, paddedJson, paddedBin ? 8 + paddedBin : 0);
  if (total > GLB_LIMITS.encodedBytes)
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "Transformed GLB exceeds the existing encoded limit",
    );
  const output = new Uint8Array(total),
    view = new DataView(output.buffer);
  output.set([103, 108, 84, 70]);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, paddedJson, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(32, 20, 20 + paddedJson);
  Buffer.from(output.buffer).write(text, 20, jsonBytes, "utf8");
  if (paddedBin) {
    view.setUint32(20 + paddedJson, paddedBin, true);
    view.setUint32(24 + paddedJson, 0x004e4942, true);
    output.set(bin, 28 + paddedJson);
  }
  return output;
}

function facing(checked: CheckedGlb): Uint8Array {
  const { json, bin } = checked,
    wrappers = new Map<number, number>();
  for (const scene of json.scenes)
    scene.nodes = (scene.nodes ?? []).map((index: number) => {
      let wrapper = wrappers.get(index);
      if (wrapper === undefined) {
        wrapper = Number(json.nodes.length);
        if (wrapper >= GLB_LIMITS.objects)
          throw new GlbPreflightError(
            "GLB_LIMIT",
            "GLB facing wrappers exceed the node budget",
          );
        json.nodes.push({
          name: "Forward axis +Z",
          rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
          children: [index],
        });
        wrappers.set(index, wrapper);
      }
      return wrapper;
    });
  return encode(json, bin);
}

function split(checked: CheckedGlb): { name: string; bytes: Uint8Array }[] {
  const { json, bin } = checked;
  const originalViews = json.bufferViews,
    views: any[] = [],
    files: Array<{ name: string; bytes: Uint8Array }> = [];
  const used = new Set<number>(),
    packed = new Map<number, number>();
  for (let index = 0; index < json.accessors.length; index++) {
    const accessor = json.accessors[index];
    if (accessor.bufferView !== undefined) {
      if (originalViews[accessor.bufferView].byteStride !== undefined) {
        const width = (
          { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<
            number,
            number
          >
        )[accessor.componentType]!;
        const elements = (
          {
            SCALAR: 1,
            VEC2: 2,
            VEC3: 3,
            VEC4: 4,
            MAT2: 4,
            MAT3: 9,
            MAT4: 16,
          } as Record<string, number>
        )[accessor.type]!;
        packed.set(index, accessor.count * width * elements);
      } else used.add(accessor.bufferView);
    }
    if (accessor.sparse) {
      used.add(accessor.sparse.indices.bufferView);
      used.add(accessor.sparse.values.bufferView);
    }
  }
  for (const image of json.images) used.add(image.bufferView);
  const sizes = [...used]
    .map((index) => originalViews[index].byteLength)
    .concat([...packed.values()]);
  if (
    sizes.some((size) => size > GLB_LIMITS.sourceFileBytes) ||
    sizes.reduce((a, b) => glbSum(a, b), 0) > GLB_LIMITS.sourceBytes
  )
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "Model resources exceed the unchanged 2 MiB per-file or 8 MiB aggregate source budget",
    );
  if (sizes.length >= 1900)
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "Model resource count exceeds its existing bound",
    );
  const mapping = new Map<number, number>();
  for (const index of used) {
    mapping.set(index, views.length);
    views.push({
      ...originalViews[index],
      buffer: views.length,
      byteOffset: 0,
    });
  }
  for (let index = 0; index < json.accessors.length; index++) {
    const accessor = json.accessors[index];
    if (packed.has(index)) {
      const value = packedGlbAccessor(checked, index);
      accessor.bufferView = views.length;
      accessor.byteOffset = 0;
      delete accessor.sparse;
      views.push({
        buffer: views.length,
        byteOffset: 0,
        byteLength: value.byteLength,
      });
      files.push({
        name: `buffer-${views.length - 1}.bin`,
        bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      });
    } else if (accessor.bufferView !== undefined)
      accessor.bufferView = mapping.get(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = mapping.get(
        accessor.sparse.indices.bufferView,
      );
      accessor.sparse.values.bufferView = mapping.get(
        accessor.sparse.values.bufferView,
      );
    }
  }
  const names = new Map<number, string>();
  for (const [index, image] of json.images.entries()) {
    const extension = (
      {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      } as Record<string, string>
    )[image.mimeType]!;
    const mapped = mapping.get(image.bufferView)!;
    names.set(mapped, names.get(mapped) ?? `texture-${index}.${extension}`);
    image.uri = names.get(mapped);
    delete image.bufferView;
  }
  for (const [original, mapped] of mapping) {
    const view = originalViews[original],
      name = names.get(mapped) ?? `buffer-${mapped}.bin`;
    files.push({
      name,
      bytes: bin.slice(
        view.byteOffset ?? 0,
        (view.byteOffset ?? 0) + view.byteLength,
      ),
    });
  }
  const byName = new Map(files.map((file) => [file.name, file]));
  json.bufferViews = views;
  json.buffers = views.map((view, index) => ({
    uri: names.get(index) ?? `buffer-${index}.bin`,
    byteLength: view.byteLength,
  }));
  const text = JSON.stringify(json),
    length = Buffer.byteLength(text);
  if (
    length > GLB_LIMITS.sourceFileBytes ||
    glbSum(
      length,
      ...[...byName.values()].map((file) => file.bytes.byteLength),
    ) > GLB_LIMITS.sourceBytes
  )
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "Model resource metadata exceeds the unchanged source budget",
    );
  const metadata = new Uint8Array(length);
  Buffer.from(metadata.buffer).write(text, "utf8");
  return [{ name: "model.gltf", bytes: metadata }, ...byName.values()];
}

try {
  let checked: CheckedGlb, merged: MergedGlb | undefined;
  const admitted = (input: any) =>
    input &&
    Object.keys(input).sort().join() === "bytes,sha256" &&
    input.bytes instanceof Uint8Array &&
    input.bytes.buffer instanceof ArrayBuffer &&
    input.bytes.byteOffset === 0 &&
    input.bytes.byteLength === input.bytes.buffer.byteLength &&
    /^[a-f0-9]{64}$/.test(input.sha256);
  if (workerData?.mode === "merge") {
    if (
      Object.keys(workerData).sort().join() !== "inputs,mode" ||
      !Array.isArray(workerData.inputs) ||
      workerData.inputs.length !== 2 ||
      !workerData.inputs.every(admitted)
    )
      throw new GlbPreflightError(
        "GLB_INVALID",
        "Invalid merge parser request",
      );
    merged = mergeGlbAnimations(
      workerData.inputs.map((input: any) => input.bytes),
    );
    if (
      merged.proof.inputSha256.some(
        (sha, index) => sha !== workerData.inputs[index].sha256,
      )
    )
      throw new GlbPreflightError(
        "GLB_INVALID",
        "Merge source changed before parsing",
      );
    checked = merged.checked;
  } else {
    if (
      !workerData ||
      Object.keys(workerData).sort().join() !== "bytes,mode,sha256" ||
      !admitted({ bytes: workerData.bytes, sha256: workerData.sha256 }) ||
      !["inspect", "face", "split", "animation-batch"].includes(workerData.mode)
    )
      throw new GlbPreflightError("GLB_INVALID", "Invalid GLB parser request");
    checked = preflightGlb(workerData.bytes);
    if (checked.summary.sha256 !== workerData.sha256)
      throw new GlbPreflightError(
        "GLB_INVALID",
        "GLB source changed before parsing",
      );
  }
  if (workerData.mode === "animation-batch") validateGlbAnimationBatch(checked);
  const document = await new NodeIO()
    .registerExtensions([
      KHRMaterialsUnlit,
      KHRTextureTransform,
      KHRMeshQuantization,
      EXTTextureWebP,
    ])
    .readJSON({
      // Core/extension preread may mutate nested JSON (notably optional WebP fallback).
      // Keep the admitted original AST for byte-preserving transforms. This is JSON-only heap data.
      json: structuredClone(checked.json) as any,
      resources: { [GLB_BUFFER]: checked.bin },
    });
  const root = document.getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const count =
          primitive.getIndices()?.getCount() ??
          primitive.getAttribute("POSITION")?.getCount() ??
          0,
        mode = primitive.getMode();
      triangles +=
        mode === 4
          ? Math.floor(count / 3)
          : mode === 5 || mode === 6
            ? Math.max(0, count - 2)
            : 0;
    }
  if (!triangles || !Number.isSafeInteger(triangles))
    throw new GlbPreflightError(
      "GLB_INVALID",
      "Model has no triangle geometry",
    );
  const clips = root.listAnimations(),
    metadata: Model3DMetadata = {
      triangles,
      textured: root.listTextures().length > 0,
      rigged: root.listSkins().length > 0,
      animations: clips.map((clip) => clip.getName()),
      ...(clips.length
        ? {
            animationClips: clips.map((clip) => ({
              name: clip.getName(),
              channels: clip.listChannels().length,
              durationSeconds: clip
                .listSamplers()
                .reduce(
                  (end, sampler) =>
                    Math.max(end, sampler.getInput()?.getMax([0])[0] ?? 0),
                  0,
                ),
            })),
          }
        : {}),
    };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 128 * 1024)
    throw new GlbPreflightError(
      "GLB_LIMIT",
      "GLB metadata output exceeds its bound",
    );
  const result: any = {
      metadata,
      preflight: checked.summary,
      measurement: process.memoryUsage(),
    },
    transfer: ArrayBuffer[] = [];
  if (merged) {
    result.bytes = merged.bytes;
    result.mergeProof = merged.proof;
    transfer.push(merged.bytes.buffer);
  }
  if (workerData.mode === "face") {
    result.bytes = facing(checked);
    transfer.push(result.bytes.buffer);
  }
  if (workerData.mode === "split") {
    try {
      result.resources = split(checked);
      transfer.push(...result.resources.map((file: any) => file.bytes.buffer));
    } catch (cause) {
      if (!(cause instanceof GlbPreflightError)) throw cause;
      result.resourceFailure = {
        code: cause.code === "GLB_LIMIT" ? "budget" : "unsupported",
        message: cause.message,
      };
    }
  }
  parentPort!.postMessage({ ok: true, result }, transfer);
} catch (cause) {
  parentPort!.postMessage({
    ok: false,
    code: cause instanceof GlbPreflightError ? cause.code : "GLB_PARSE_FAILED",
  });
}
