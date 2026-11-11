import { createHash } from "node:crypto";
import {
  preflightGlb,
  GLB_LIMITS,
  GlbPreflightError,
  glbSum,
  type CheckedGlb,
} from "./glb-preflight.js";

type Json = Record<string, any>;
export interface GlbMergeProof {
  version: 1;
  compatibility: "exact-model-semantic-v1";
  inputSha256: [string, string];
  inputBytes: number;
  outputSha256: string;
  outputBytes: number;
  copiedAccessors: number;
  copiedViews: number;
  renamedClips: Array<{
    input: 0 | 1;
    index: number;
    from: string;
    to: string;
  }>;
}
export interface MergedGlb {
  bytes: Uint8Array<ArrayBuffer>;
  checked: CheckedGlb;
  proof: GlbMergeProof;
}
const unsupported = (message: string): never => {
  throw new GlbPreflightError("GLB_UNSUPPORTED", message);
};
const limit = (message: string): never => {
  throw new GlbPreflightError("GLB_LIMIT", message);
};
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function without(value: Json, keys: string[]): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}
const widths: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const components: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
/** Iterates admitted logical elements without allocating a dense/sparse expansion. */
function elements(
  checked: CheckedGlb,
  accessor: Json,
  consume: (bytes: Uint8Array, index: number) => void,
): void {
  const { json, bin } = checked,
    size = widths[accessor.componentType]! * components[accessor.type]!,
    zero = new Uint8Array(size);
  const view =
      accessor.bufferView === undefined
        ? undefined
        : json.bufferViews[accessor.bufferView],
    stride = view?.byteStride ?? size;
  const start = (view?.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const sparse = accessor.sparse,
    indices = sparse && json.bufferViews[sparse.indices.bufferView],
    values = sparse && json.bufferViews[sparse.values.bufferView];
  const indexStart = sparse
    ? (indices.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0)
    : 0;
  const valueStart = sparse
    ? (values.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0)
    : 0;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  let cursor = 0;
  const readIndex = () => {
    if (!sparse || cursor >= sparse.count) return -1;
    const offset = indexStart + cursor * widths[sparse.indices.componentType]!;
    return sparse.indices.componentType === 5121
      ? data.getUint8(offset)
      : sparse.indices.componentType === 5123
        ? data.getUint16(offset, true)
        : data.getUint32(offset, true);
  };
  let next = readIndex();
  for (let index = 0; index < accessor.count; index++) {
    if (index === next) {
      consume(
        bin.subarray(
          valueStart + cursor * size,
          valueStart + (cursor + 1) * size,
        ),
        index,
      );
      cursor++;
      next = readIndex();
    } else if (view)
      consume(
        bin.subarray(start + index * stride, start + index * stride + size),
        index,
      );
    else consume(zero, index);
  }
}
function accessorIdentity(
  checked: CheckedGlb,
  index: number,
  memo: Map<number, string>,
): string {
  const found = memo.get(index);
  if (found) return found;
  const accessor = checked.json.accessors[index],
    hash = createHash("sha256");
  hash
    .update("ohmygame-glb-accessor-v1\n")
    .update(
      canonical(without(accessor, ["bufferView", "byteOffset", "sparse"])),
    );
  const view =
    accessor.bufferView === undefined
      ? undefined
      : checked.json.bufferViews[accessor.bufferView];
  const size = widths[accessor.componentType]! * components[accessor.type]!;
  if (
    view &&
    !accessor.sparse &&
    (view.byteStride === undefined || view.byteStride === size)
  ) {
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    hash.update(checked.bin.subarray(start, start + accessor.count * size));
  } else
    elements(checked, accessor, (bytes) => {
      hash.update(bytes);
    });
  const result = hash.digest("hex");
  memo.set(index, result);
  return result;
}
function nodeKeys(checked: CheckedGlb): string[] {
  const nodes: Json[] = checked.json.nodes,
    parents = new Map<number, number>();
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parents.set(child, index);
  });
  const keys: string[] = [],
    seen = new Set<string>(),
    stack = nodes
      .map((_, index) => index)
      .filter((index) => !parents.has(index))
      .map((index) => ({ index, parent: "root" }));
  while (stack.length) {
    const { index, parent } = stack.pop()!,
      node = nodes[index];
    if (typeof node.name !== "string" || !node.name || node.name.length > 256)
      unsupported(
        "Animation merge requires unambiguous named model nodes; originals remain retained",
      );
    const key = createHash("sha256")
      .update("ohmygame-glb-node-path-v1\n")
      .update(canonical([parent, node.name]))
      .digest("hex");
    if (seen.has(key))
      unsupported(
        "Animation merge encountered ambiguous sibling or root node names; originals remain retained",
      );
    seen.add(key);
    keys[index] = key;
    for (const child of node.children ?? [])
      stack.push({ index: child, parent: key });
  }
  return keys;
}
function modelIdentity(checked: CheckedGlb, keys: string[]): string {
  const { json, bin } = checked,
    memo = new Map<number, string>();
  const accessor = (index: number) => accessorIdentity(checked, index, memo);
  const nodes = json.nodes
    .map((node: Json, index: number) => {
      if (
        node.matrix !== undefined &&
        ["translation", "rotation", "scale"].some(
          (key) => node[key] !== undefined,
        )
      )
        unsupported("Mixed matrix and TRS model nodes cannot be merged safely");
      return [
        keys[index],
        {
          ...without(node, [
            "name",
            "children",
            "translation",
            "rotation",
            "scale",
          ]),
          ...(node.matrix === undefined
            ? {
                translation: node.translation ?? [0, 0, 0],
                rotation: node.rotation ?? [0, 0, 0, 1],
                scale: node.scale ?? [1, 1, 1],
              }
            : {}),
          children: (node.children ?? [])
            .map((child: number) => keys[child])
            .sort(),
        },
      ];
    })
    .sort((a: any, b: any) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const skins = json.skins.map((skin: Json) => ({
    ...without(skin, ["joints", "skeleton", "inverseBindMatrices"]),
    joints: skin.joints.map((index: number) => keys[index]),
    ...(skin.skeleton === undefined ? {} : { skeleton: keys[skin.skeleton] }),
    ...(skin.inverseBindMatrices === undefined
      ? {}
      : { inverseBindMatrices: accessor(skin.inverseBindMatrices) }),
  }));
  const meshes = json.meshes.map((mesh: Json) => ({
    ...mesh,
    primitives: mesh.primitives.map((primitive: Json) => ({
      ...primitive,
      attributes: Object.fromEntries(
        Object.entries(primitive.attributes).map(([key, index]) => [
          key,
          accessor(index as number),
        ]),
      ),
      ...(primitive.indices === undefined
        ? {}
        : { indices: accessor(primitive.indices) }),
      ...(primitive.targets === undefined
        ? {}
        : {
            targets: primitive.targets.map((target: Json) =>
              Object.fromEntries(
                Object.entries(target).map(([key, index]) => [
                  key,
                  accessor(index as number),
                ]),
              ),
            ),
          }),
    })),
  }));
  const images = json.images.map((image: Json) => {
    const view = json.bufferViews[image.bufferView];
    return {
      ...without(image, ["bufferView"]),
      sha256: createHash("sha256")
        .update(
          bin.subarray(
            view.byteOffset ?? 0,
            (view.byteOffset ?? 0) + view.byteLength,
          ),
        )
        .digest("hex"),
      size: view.byteLength,
    };
  });
  const scenes = json.scenes.map((scene: Json) => ({
    ...scene,
    nodes: (scene.nodes ?? []).map((index: number) => keys[index]),
  }));
  return canonical({
    ...without(json, [
      "buffers",
      "bufferViews",
      "accessors",
      "animations",
      "nodes",
      "skins",
      "meshes",
      "images",
      "scenes",
    ]),
    nodes,
    skins,
    meshes,
    images,
    scenes,
  });
}
function assertRelocatable(record: Json): void {
  for (const key of ["extras", "extensions"]) {
    const value = record[key];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "object" || Object.keys(value).length)
    )
      unsupported(
        "Opaque metadata on relocated animation resources cannot be remapped safely; originals remain retained",
      );
  }
}
function validateClips(checked: CheckedGlb): void {
  if (!checked.json.animations.length)
    unsupported("Animation batch contains no clips; originals remain retained");
  for (const animation of checked.json.animations) {
    assertRelocatable(animation);
    if (
      typeof animation.name !== "string" ||
      !animation.name ||
      animation.name.length > 256
    )
      unsupported("Animation merge requires a nonempty bounded clip name");
    if (!animation.channels.length || !animation.samplers.length)
      unsupported(
        "Animation batch contains an unusable empty clip; originals remain retained",
      );
    for (const sampler of animation.samplers) {
      assertRelocatable(sampler);
      for (const index of [sampler.input, sampler.output]) {
        const accessor = checked.json.accessors[index];
        assertRelocatable(accessor);
        if (accessor.normalized)
          unsupported(
            "Normalized floating-point animation curves are unsupported",
          );
        for (const view of [
          accessor.bufferView,
          accessor.sparse?.indices.bufferView,
          accessor.sparse?.values.bufferView,
        ])
          if (view !== undefined)
            assertRelocatable(checked.json.bufferViews[view]);
      }
      let previous = -Infinity;
      elements(checked, checked.json.accessors[sampler.input], (bytes) => {
        const value = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getFloat32(0, true);
        if (!Number.isFinite(value) || value < 0 || value <= previous)
          unsupported(
            "Animation sample times must be finite, nonnegative and strictly increasing",
          );
        previous = value;
      });
    }
    const targets = new Set<string>();
    for (const channel of animation.channels) {
      assertRelocatable(channel);
      assertRelocatable(channel.target);
      const target = canonical([channel.target.node, channel.target.path]);
      if (targets.has(target))
        unsupported(
          "Animation contains ambiguous channels for the same model target",
        );
      targets.add(target);
    }
  }
}

/** Strict eligibility for the first durable batch, before any subsequent paid stage. */
export function validateGlbAnimationBatch(checked: CheckedGlb): void {
  validateClips(checked);
  modelIdentity(checked, nodeKeys(checked));
}

/** Two already-retained batches. No NodeIO reader/writer and no dense accessor copies are used here. */
export function mergeGlbAnimations(inputs: readonly Uint8Array[]): MergedGlb {
  if (
    inputs.length !== 2 ||
    inputs.some(
      (bytes) =>
        !(bytes instanceof Uint8Array) ||
        !(bytes.buffer instanceof ArrayBuffer) ||
        bytes.byteLength < 20 ||
        bytes.byteLength > GLB_LIMITS.encodedBytes,
    )
  )
    unsupported(
      "A bounded animation merge requires two GLBs within their existing encoded limits",
    );
  const inputBytes = glbSum(...inputs.map((bytes) => bytes.byteLength));
  if (inputBytes > 2 * GLB_LIMITS.encodedBytes)
    limit("Animation pair inputs exceed 200 MiB");
  const jsonBytes = inputs.map((bytes) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      12,
      true,
    ),
  );
  if (
    jsonBytes.some((bytes) => bytes > GLB_LIMITS.jsonBytes) ||
    glbSum(...jsonBytes) > 2 * GLB_LIMITS.jsonBytes
  )
    limit("Animation pair JSON exceeds the bounded input budget");
  const [base, next] = inputs.map(preflightGlb) as [CheckedGlb, CheckedGlb];
  validateClips(base);
  validateClips(next);
  const baseKeys = nodeKeys(base),
    nextKeys = nodeKeys(next);
  if (modelIdentity(base, baseKeys) !== modelIdentity(next, nextKeys))
    unsupported(
      "Animation batch model, hierarchy, rest pose, skins or morph geometry differs; originals remain retained",
    );
  const nodeMap = new Map(baseKeys.map((key, index) => [key, index]));
  const json = base.json,
    chunks: Array<{ offset: number; bytes: Uint8Array }> = [];
  let binLength = base.bin.byteLength;
  const views = new Map<number, number>(),
    accessors = new Map<number, number>();
  const addView = (index: number): number => {
    const found = views.get(index);
    if (found !== undefined) return found;
    const view = next.json.bufferViews[index],
      start = view.byteOffset ?? 0,
      output = json.bufferViews.length;
    if (output >= GLB_LIMITS.objects)
      limit("Merged buffer view count exceeds its existing bound");
    const offset = binLength;
    binLength = glbSum(binLength, Math.ceil(view.byteLength / 4) * 4);
    if (binLength > GLB_LIMITS.encodedBytes)
      limit("Merged GLB BIN exceeds its existing encoded limit");
    json.bufferViews.push({ ...view, buffer: 0, byteOffset: offset });
    chunks.push({
      offset,
      bytes: next.bin.subarray(start, start + view.byteLength),
    });
    views.set(index, output);
    return output;
  };
  const addAccessor = (index: number): number => {
    const found = accessors.get(index);
    if (found !== undefined) return found;
    const accessor = structuredClone(next.json.accessors[index]),
      output = json.accessors.length;
    if (output >= GLB_LIMITS.objects)
      limit("Merged accessor count exceeds its existing bound");
    if (accessor.bufferView !== undefined)
      accessor.bufferView = addView(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = addView(
        accessor.sparse.indices.bufferView,
      );
      accessor.sparse.values.bufferView = addView(
        accessor.sparse.values.bufferView,
      );
    }
    json.accessors.push(accessor);
    accessors.set(index, output);
    return output;
  };
  if (
    json.animations.length + next.json.animations.length >
    GLB_LIMITS.animations
  )
    limit("Merged animation count exceeds its existing bound");
  const renamedClips: GlbMergeProof["renamedClips"] = [],
    names = new Set<string>();
  const nameClip = (clip: Json, input: 0 | 1, index: number) => {
    const original = clip.name;
    let candidate = original;
    for (let suffix = 2; names.has(candidate); suffix++)
      candidate = `${original}_${suffix}`;
    if (candidate.length > 256)
      limit("Merged clip name exceeds its existing metadata bound");
    names.add(candidate);
    clip.name = candidate;
    if (candidate !== original)
      renamedClips.push({ input, index, from: original, to: candidate });
  };
  json.animations.forEach((clip: Json, index: number) =>
    nameClip(clip, 0, index),
  );
  next.json.animations.forEach((animation: Json, index: number) => {
    const clip = structuredClone(animation);
    nameClip(clip, 1, index);
    for (const sampler of clip.samplers) {
      sampler.input = addAccessor(sampler.input);
      sampler.output = addAccessor(sampler.output);
    }
    for (const channel of clip.channels) {
      const mapped = nodeMap.get(nextKeys[channel.target.node]!);
      if (mapped === undefined)
        unsupported("Animation target node could not be matched");
      channel.target.node = mapped;
    }
    json.animations.push(clip);
  });
  json.buffers[0] = { ...json.buffers[0], byteLength: binLength };
  const text = JSON.stringify(json),
    paddedJson = Math.ceil(Buffer.byteLength(text) / 4) * 4;
  if (paddedJson > GLB_LIMITS.jsonBytes) limit("Merged GLB JSON exceeds 8 MiB");
  const total = glbSum(28, paddedJson, binLength);
  if (total > GLB_LIMITS.encodedBytes)
    limit("Merged GLB exceeds 100 MiB; every original remains retained");
  const bytes = new Uint8Array(total),
    header = new DataView(bytes.buffer);
  bytes.set([103, 108, 84, 70]);
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, paddedJson, true);
  header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + paddedJson);
  Buffer.from(bytes.buffer).write(text, 20, "utf8");
  header.setUint32(20 + paddedJson, binLength, true);
  header.setUint32(24 + paddedJson, 0x004e4942, true);
  bytes.set(base.bin, 28 + paddedJson);
  for (const chunk of chunks)
    bytes.set(chunk.bytes, 28 + paddedJson + chunk.offset);
  const checked = preflightGlb(bytes);
  const proof: GlbMergeProof = {
    version: 1,
    compatibility: "exact-model-semantic-v1",
    inputSha256: [base.summary.sha256, next.summary.sha256],
    inputBytes,
    outputSha256: checked.summary.sha256,
    outputBytes: bytes.byteLength,
    copiedAccessors: accessors.size,
    copiedViews: views.size,
    renamedClips,
  };
  if (Buffer.byteLength(JSON.stringify(proof)) > 128 * 1024)
    limit("Animation merge proof exceeds its bounded metadata budget");
  return { bytes, checked, proof };
}
