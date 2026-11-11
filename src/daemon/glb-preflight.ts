import { createHash } from "node:crypto";

const MiB = 1024 * 1024;
export const GLB_LIMITS = Object.freeze({
  encodedBytes: 100 * MiB,
  jsonBytes: 8 * MiB,
  readerAllocationBytes: 128 * MiB,
  objects: 16_384,
  jsonValues: 200_000,
  depth: 256,
  animations: 1024,
  sourceFileBytes: 2 * MiB,
  sourceBytes: 8 * MiB,
});
export type GlbFailureCode = "GLB_INVALID" | "GLB_LIMIT" | "GLB_UNSUPPORTED";
export class GlbPreflightError extends Error {
  constructor(
    readonly code: GlbFailureCode,
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new GlbPreflightError("GLB_INVALID", message);
};
const limit = (message: string): never => {
  throw new GlbPreflightError("GLB_LIMIT", message);
};
const unsupported = (message: string): never => {
  throw new GlbPreflightError("GLB_UNSUPPORTED", message);
};
// These extensions do not introduce a codec, binary resource, or native array allocation.
const extensions = new Set([
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "EXT_texture_webp",
]);
type Json = Record<string, any>;
export interface GlbPreflightSummary {
  version: 1;
  sha256: string;
  encodedBytes: number;
  jsonBytes: number;
  binBytes: number;
  accessorAllocationBytes: number;
  sparseAllocationBytes: number;
  imageAllocationBytes: number;
  readerAllocationBytes: number;
  accessorCount: number;
  imageCount: number;
  /** Encoded image bytes are counted; textures are never decoded by this parser. */
  textureDecoding: "not-performed";
}
export interface CheckedGlb {
  json: Json;
  bin: Uint8Array<ArrayBuffer>;
  summary: GlbPreflightSummary;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > maximum
  )
    fail("Invalid GLB integer or resource range");
  return Number(value);
}
export function glbSum(...values: number[]): number {
  let result = 0;
  for (const value of values) {
    integer(value);
    result += value;
    integer(result);
  }
  return result;
}
export function glbProduct(a: number, b: number): number {
  integer(a);
  integer(b);
  return integer(a * b);
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid GLB object");
  return value as Json;
}
function array(value: unknown, max: number = GLB_LIMITS.objects): any[] {
  if (!Array.isArray(value) || value.length > max)
    fail("Invalid or excessive GLB object count");
  return value as any[];
}
function ref(value: unknown, values: unknown[]): number {
  const index = integer(value);
  if (index >= values.length) fail("Invalid GLB object reference");
  return index;
}
function finiteArray(value: unknown, length: number): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  )
    fail("Invalid GLB numeric vector");
}
const components: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const widths: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
function accessorLayout(accessor: Json) {
  if (
    typeof accessor.type !== "string" ||
    !Object.hasOwn(components, accessor.type) ||
    typeof accessor.componentType !== "number" ||
    !Object.hasOwn(widths, accessor.componentType)
  )
    fail("Unsupported GLB accessor layout");
  const count = integer(accessor.count),
    elements = components[accessor.type],
    width = widths[accessor.componentType];
  if (!count || !elements || !width) fail("Unsupported GLB accessor layout");
  if (["MAT2", "MAT3"].includes(accessor.type) && width < 4)
    unsupported(
      "Padded integer matrix accessors are unsupported; preserve the original GLB",
    );
  if (
    accessor.normalized !== undefined &&
    typeof accessor.normalized !== "boolean"
  )
    fail("Invalid GLB accessor normalization");
  return {
    count,
    elements,
    width,
    elementBytes: glbProduct(elements, width),
    bytes: glbProduct(glbProduct(count, elements), width),
  };
}
function viewRange(
  json: Json,
  bin: Uint8Array,
  viewIndex: unknown,
  offset: unknown,
  count: number,
  elementBytes: number,
  width: number,
  sparse = false,
) {
  const views = json.bufferViews ?? [],
    view = views[ref(viewIndex, views)];
  const start = integer(view.byteOffset ?? 0),
    length = integer(view.byteLength),
    relative = integer(offset ?? 0);
  const stride = integer(view.byteStride ?? elementBytes);
  if (
    !stride ||
    stride < elementBytes ||
    stride % width ||
    relative % width ||
    start % width ||
    (sparse && view.byteStride !== undefined)
  )
    fail("Invalid GLB accessor stride or alignment");
  if (
    view.byteStride !== undefined &&
    (stride < 4 || stride > 252 || stride % 4)
  )
    fail("Invalid GLB vertex stride");
  const required = count
    ? glbSum(glbProduct(count - 1, stride), elementBytes)
    : 0;
  if (
    glbSum(relative, required) > length ||
    glbSum(start, length) > bin.byteLength
  )
    fail("GLB accessor exceeds its own buffer view");
  return { offset: start + relative, stride };
}
function component(data: DataView, offset: number, type: number): number {
  switch (type) {
    case 5120:
      return data.getInt8(offset);
    case 5121:
      return data.getUint8(offset);
    case 5122:
      return data.getInt16(offset, true);
    case 5123:
      return data.getUint16(offset, true);
    case 5125:
      return data.getUint32(offset, true);
    case 5126:
      return data.getFloat32(offset, true);
    default:
      return fail("Invalid GLB component type");
  }
}
function validateValues(
  bin: Uint8Array,
  range: { offset: number; stride: number },
  count: number,
  elements: number,
  width: number,
  type: number,
  maximum?: number,
): void {
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let index = 0; index < count; index++)
    for (let column = 0; column < elements; column++) {
      const value = component(
        data,
        range.offset + index * range.stride + column * width,
        type,
      );
      if (
        !Number.isFinite(value) ||
        (maximum !== undefined && (value < 0 || value >= maximum))
      )
        fail("Invalid GLB accessor value");
    }
}

/** Pure admission. Production invokes this in the isolated worker, before any NodeIO call. */
export function preflightGlb(input: Uint8Array): CheckedGlb {
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.byteLength < 20 ||
    input.byteLength > GLB_LIMITS.encodedBytes
  )
    limit("GLB exceeds the existing 100 MiB encoded limit");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (
    bytes.toString("ascii", 0, 4) !== "glTF" ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    fail("Invalid GLB container");
  const jsonBytes = bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    jsonBytes % 4 ||
    !jsonBytes ||
    20 + jsonBytes > bytes.length
  )
    fail("Invalid GLB JSON chunk");
  if (jsonBytes > GLB_LIMITS.jsonBytes)
    limit("GLB JSON exceeds its 8 MiB inspection budget");
  let json: Json;
  try {
    json = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(20, 20 + jsonBytes),
        ),
      ),
    );
  } catch (cause) {
    if (cause instanceof GlbPreflightError) throw cause;
    return fail("Invalid GLB JSON");
  }
  let bin = new Uint8Array(0);
  if (20 + jsonBytes < bytes.length) {
    const offset = 20 + jsonBytes;
    if (
      offset + 8 > bytes.length ||
      bytes.readUInt32LE(offset + 4) !== 0x004e4942 ||
      bytes.readUInt32LE(offset) % 4 ||
      offset + 8 + bytes.readUInt32LE(offset) !== bytes.length
    )
      unsupported(
        "Unknown GLB chunks are unsupported; preserve the original GLB",
      );
    bin = new Uint8Array(
      input.buffer as ArrayBuffer,
      input.byteOffset + offset + 8,
      bytes.readUInt32LE(offset),
    );
  }
  let values = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: json, depth: 0 },
  ];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++values > GLB_LIMITS.jsonValues || depth > GLB_LIMITS.depth)
      limit("GLB JSON structure exceeds its inspection budget");
    if (typeof value === "number" && !Number.isFinite(value))
      fail("Non-finite GLB number");
    if (typeof value === "string" && value.length > 1024 * 1024)
      limit("GLB metadata string is excessive");
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          unsupported("Unsupported GLB metadata key");
        if (key === "extensions")
          for (const extension of Object.keys(object(child)))
            if (!extensions.has(extension))
              unsupported(
                "This GLB extension is outside the inspected allocation contract; retain the original",
              );
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  if (
    object(json.asset).version !== "2.0" ||
    (json.asset.minVersion && json.asset.minVersion !== "2.0")
  )
    unsupported("Unsupported glTF asset version");
  for (const name of ["extensionsUsed", "extensionsRequired"])
    if (json[name] !== undefined)
      for (const extension of array(json[name]))
        if (!extensions.has(extension))
          unsupported(
            "This GLB codec or extension is unsupported; retain the original",
          );
  for (const name of [
    "buffers",
    "bufferViews",
    "accessors",
    "images",
    "textures",
    "samplers",
    "materials",
    "meshes",
    "nodes",
    "skins",
    "scenes",
    "animations",
  ]) {
    json[name] ??= [];
    array(
      json[name],
      name === "animations" ? GLB_LIMITS.animations : GLB_LIMITS.objects,
    ).forEach(object);
  }
  if (
    json.buffers.length > 1 ||
    json.buffers.some((buffer: Json) => buffer.uri !== undefined)
  )
    unsupported(
      "Only an embedded GLB BIN is supported; external and data URIs are not read",
    );
  if (json.buffers.length) {
    const declared = integer(json.buffers[0].byteLength);
    if (declared > bin.byteLength || bin.byteLength - declared > 3)
      fail("GLB BIN length differs from its resource");
  } else if (bin.byteLength) fail("Unbound GLB BIN chunk");
  for (const view of json.bufferViews) {
    if (
      view.buffer !== 0 ||
      !json.buffers.length ||
      !integer(view.byteLength) ||
      glbSum(integer(view.byteOffset ?? 0), view.byteLength) >
        json.buffers[0].byteLength
    )
      fail("Invalid GLB buffer view");
    if (view.target !== undefined && ![34962, 34963].includes(view.target))
      fail("Invalid GLB buffer target");
  }
  let accessorAllocationBytes = 0,
    sparseAllocationBytes = 0,
    imageAllocationBytes = 0;
  const admit = () => {
    if (
      glbSum(
        accessorAllocationBytes,
        sparseAllocationBytes,
        imageAllocationBytes,
      ) > GLB_LIMITS.readerAllocationBytes
    )
      limit(
        "Declared GLB reader allocations exceed 128 MiB; retain the original without reparsing",
      );
  };
  for (const accessor of json.accessors) {
    const layout = accessorLayout(accessor);
    accessorAllocationBytes = glbSum(accessorAllocationBytes, layout.bytes);
    admit();
    if (accessor.bufferView !== undefined) {
      const range = viewRange(
        json,
        bin,
        accessor.bufferView,
        accessor.byteOffset,
        layout.count,
        layout.elementBytes,
        layout.width,
      );
      if (accessor.componentType === 5126)
        validateValues(
          bin,
          range,
          layout.count,
          layout.elements,
          layout.width,
          accessor.componentType,
        );
    } else if (accessor.byteOffset) fail("Unbound GLB accessor offset");
    for (const name of ["min", "max"])
      if (accessor[name] !== undefined)
        finiteArray(accessor[name], layout.elements);
    if (accessor.sparse !== undefined) {
      const sparse = object(accessor.sparse),
        count = integer(sparse.count, layout.count),
        indices = object(sparse.indices),
        values = object(sparse.values);
      // The pinned reader spreads these records over accessorDef. Unknown keys
      // could otherwise override its validated type/componentType and amplify allocation.
      for (const [record, keys] of [
        [sparse, ["count", "indices", "values"]],
        [indices, ["bufferView", "byteOffset", "componentType"]],
        [values, ["bufferView", "byteOffset"]],
      ] as const) {
        if (Object.keys(record).some((key) => !keys.includes(key as never)))
          unsupported(
            "Unknown sparse GLB fields are outside the inspected allocation contract",
          );
      }
      // Core 4.5.1 inherits the parent byteOffset when either sparse record omits it.
      // Reject that unmodeled reader quirk rather than read a different range from the admission scan.
      if (
        accessor.byteOffset &&
        (indices.byteOffset === undefined || values.byteOffset === undefined)
      )
        unsupported(
          "Sparse GLB offset defaults are unsupported for a nonzero parent offset",
        );
      if (!count || ![5121, 5123, 5125].includes(indices.componentType))
        fail("Invalid sparse GLB indices");
      const indexWidth = widths[indices.componentType]!;
      // Dense sparse accessors are copied initially and again by NodeIO's sparse override pass.
      sparseAllocationBytes = glbSum(
        sparseAllocationBytes,
        accessor.bufferView === undefined ? 0 : layout.bytes,
        glbProduct(count, indexWidth),
        glbProduct(count, layout.elementBytes),
      );
      admit();
      const indexRange = viewRange(
          json,
          bin,
          indices.bufferView,
          indices.byteOffset,
          count,
          indexWidth,
          indexWidth,
          true,
        ),
        valueRange = viewRange(
          json,
          bin,
          values.bufferView,
          values.byteOffset,
          count,
          layout.elementBytes,
          layout.width,
          true,
        );
      const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
      let previous = -1;
      for (let index = 0; index < count; index++) {
        const value = component(
          data,
          indexRange.offset + index * indexRange.stride,
          indices.componentType,
        );
        if (value <= previous || value >= layout.count)
          fail("Invalid sparse GLB index order");
        previous = value;
      }
      if (accessor.componentType === 5126)
        validateValues(
          bin,
          valueRange,
          count,
          layout.elements,
          layout.width,
          accessor.componentType,
        );
    }
  }
  for (const image of json.images) {
    if (
      image.uri !== undefined ||
      !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)
    )
      unsupported("Only embedded PNG/JPEG/WebP GLB textures are supported");
    const view = json.bufferViews[ref(image.bufferView, json.bufferViews)];
    if (view.byteStride !== undefined) fail("Interleaved GLB image resource");
    imageAllocationBytes = glbSum(imageAllocationBytes, view.byteLength);
    admit();
  }
  for (const texture of json.textures) {
    if (texture.sampler !== undefined) ref(texture.sampler, json.samplers);
    const source =
      texture.extensions?.EXT_texture_webp?.source ?? texture.source;
    ref(source, json.images);
  }
  for (const material of json.materials) {
    for (const info of [
      material.pbrMetallicRoughness?.baseColorTexture,
      material.pbrMetallicRoughness?.metallicRoughnessTexture,
      material.normalTexture,
      material.occlusionTexture,
      material.emissiveTexture,
    ])
      if (info !== undefined) ref(object(info).index, json.textures);
  }
  for (const mesh of json.meshes) {
    let targetCount: number | undefined;
    for (const primitive of array(mesh.primitives)) {
      object(primitive);
      const attributes = object(primitive.attributes),
        position = json.accessors[ref(attributes.POSITION, json.accessors)],
        count = position.count;
      if (
        position.type !== "VEC3" ||
        (primitive.mode !== undefined &&
          (!Number.isInteger(primitive.mode) ||
            primitive.mode < 0 ||
            primitive.mode > 6))
      )
        fail("Invalid GLB primitive");
      for (const index of Object.values(attributes))
        if (json.accessors[ref(index, json.accessors)].count !== count)
          fail("GLB vertex attributes have different counts");
      if (primitive.material !== undefined)
        ref(primitive.material, json.materials);
      if (primitive.indices !== undefined) {
        const index = json.accessors[ref(primitive.indices, json.accessors)],
          layout = accessorLayout(index);
        if (
          index.type !== "SCALAR" ||
          ![5121, 5123, 5125].includes(index.componentType) ||
          index.normalized
        )
          fail("Invalid GLB primitive indices");
        if (index.bufferView !== undefined)
          validateValues(
            bin,
            viewRange(
              json,
              bin,
              index.bufferView,
              index.byteOffset,
              layout.count,
              layout.elementBytes,
              layout.width,
            ),
            layout.count,
            1,
            layout.width,
            index.componentType,
            count,
          );
        if (index.sparse)
          validateValues(
            bin,
            viewRange(
              json,
              bin,
              index.sparse.values.bufferView,
              index.sparse.values.byteOffset,
              index.sparse.count,
              layout.elementBytes,
              layout.width,
              true,
            ),
            index.sparse.count,
            1,
            layout.width,
            index.componentType,
            count,
          );
      }
      const targets =
        primitive.targets === undefined ? [] : array(primitive.targets, 256);
      if (targetCount !== undefined && targets.length !== targetCount)
        fail("GLB morph target counts differ");
      targetCount = targets.length;
      for (const target of targets)
        for (const [semantic, index] of Object.entries(object(target)))
          if (
            !["POSITION", "NORMAL", "TANGENT"].includes(semantic) ||
            json.accessors[ref(index, json.accessors)].count !== count
          )
            fail("Invalid GLB morph accessor");
    }
    if (mesh.weights !== undefined) finiteArray(mesh.weights, targetCount ?? 0);
  }
  const colors = new Uint8Array(json.nodes.length),
    parents = new Set<number>();
  for (const node of json.nodes) {
    if (node.mesh !== undefined) ref(node.mesh, json.meshes);
    if (node.skin !== undefined) ref(node.skin, json.skins);
    for (const [key, length] of [
      ["matrix", 16],
      ["translation", 3],
      ["rotation", 4],
      ["scale", 3],
    ] as const)
      if (node[key] !== undefined) finiteArray(node[key], length);
    for (const child of node.children === undefined
      ? []
      : array(node.children)) {
      const index = ref(child, json.nodes);
      if (parents.has(index)) fail("GLB node has multiple parents");
      parents.add(index);
    }
    if (node.weights !== undefined) {
      if (node.mesh === undefined) fail("Unbound GLB morph weights");
      finiteArray(
        node.weights,
        json.meshes[node.mesh].primitives[0]?.targets?.length ?? 0,
      );
    }
  }
  // Starting at every true root avoids index-order memoization hiding a long chain.
  // Single-parent validation above means every reachable node is visited exactly once.
  for (let root = 0; root < json.nodes.length; root++) {
    if (parents.has(root)) continue;
    const stack = [{ index: root, depth: 0 }];
    while (stack.length) {
      const { index, depth } = stack.pop()!;
      if (depth > GLB_LIMITS.depth || colors[index])
        fail("Cyclic or excessive GLB node hierarchy");
      colors[index] = 1;
      for (const child of json.nodes[index].children ?? [])
        stack.push({ index: child, depth: depth + 1 });
    }
  }
  if (colors.some((value) => !value)) fail("Cyclic GLB node hierarchy");
  for (const scene of json.scenes) {
    const members = new Set<number>();
    for (const index of array(scene.nodes ?? [])) {
      ref(index, json.nodes);
      if (parents.has(index) || members.has(index))
        fail("Invalid GLB scene root membership");
      members.add(index);
    }
  }
  if (json.scene !== undefined) ref(json.scene, json.scenes);
  for (const skin of json.skins) {
    const joints = array(skin.joints);
    if (!joints.length || new Set(joints).size !== joints.length)
      fail("Invalid GLB skin joints");
    joints.forEach((index) => ref(index, json.nodes));
    if (skin.skeleton !== undefined) ref(skin.skeleton, json.nodes);
    if (skin.inverseBindMatrices !== undefined) {
      const accessor =
        json.accessors[ref(skin.inverseBindMatrices, json.accessors)];
      if (
        accessor.type !== "MAT4" ||
        accessor.componentType !== 5126 ||
        accessor.count !== joints.length
      )
        fail("Invalid GLB inverse bind matrices");
    }
  }
  for (const animation of json.animations) {
    if (
      animation.name !== undefined &&
      (typeof animation.name !== "string" || animation.name.length > 256)
    )
      limit("GLB animation name is excessive");
    const samplers = array(animation.samplers),
      channels = array(animation.channels);
    for (const sampler of samplers) {
      object(sampler);
      const input = json.accessors[ref(sampler.input, json.accessors)];
      ref(sampler.output, json.accessors);
      if (
        input.type !== "SCALAR" ||
        input.componentType !== 5126 ||
        (sampler.interpolation !== undefined &&
          !["LINEAR", "STEP", "CUBICSPLINE"].includes(sampler.interpolation))
      )
        fail("Invalid GLB animation sampler");
    }
    for (const channel of channels) {
      object(channel);
      const sampler = samplers[ref(channel.sampler, samplers)],
        target = object(channel.target),
        node = json.nodes[ref(target.node, json.nodes)],
        output = json.accessors[sampler.output],
        input = json.accessors[sampler.input];
      if (
        !["translation", "rotation", "scale", "weights"].includes(target.path)
      )
        unsupported("Unsupported GLB animation target");
      const multiplier = sampler.interpolation === "CUBICSPLINE" ? 3 : 1;
      const morphs =
        target.path === "weights"
          ? (json.meshes[ref(node.mesh, json.meshes)].primitives[0]?.targets
              ?.length ?? 0)
          : 1;
      if (
        output.componentType !== 5126 ||
        output.count !==
          glbProduct(glbProduct(input.count, multiplier), morphs) ||
        output.type !==
          (target.path === "rotation"
            ? "VEC4"
            : target.path === "weights"
              ? "SCALAR"
              : "VEC3")
      )
        fail("Invalid GLB animation output shape");
    }
  }
  return {
    json,
    bin,
    summary: {
      version: 1,
      sha256: createHash("sha256").update(input).digest("hex"),
      encodedBytes: bytes.length,
      jsonBytes,
      binBytes: bin.byteLength,
      accessorAllocationBytes,
      sparseAllocationBytes,
      imageAllocationBytes,
      readerAllocationBytes: glbSum(
        accessorAllocationBytes,
        sparseAllocationBytes,
        imageAllocationBytes,
      ),
      accessorCount: json.accessors.length,
      imageCount: json.images.length,
      textureDecoding: "not-performed",
    },
  };
}

/** Dense packing is limited by the caller's already admitted output budget. */
export function packedGlbAccessor(checked: CheckedGlb, index: number): Buffer {
  const accessor = checked.json.accessors[ref(index, checked.json.accessors)],
    layout = accessorLayout(accessor);
  const output = Buffer.alloc(layout.bytes);
  if (accessor.bufferView !== undefined) {
    const range = viewRange(
      checked.json,
      checked.bin,
      accessor.bufferView,
      accessor.byteOffset,
      layout.count,
      layout.elementBytes,
      layout.width,
    );
    for (let row = 0; row < layout.count; row++)
      output.set(
        checked.bin.subarray(
          range.offset + row * range.stride,
          range.offset + row * range.stride + layout.elementBytes,
        ),
        row * layout.elementBytes,
      );
  }
  if (accessor.sparse) {
    const sparse = accessor.sparse,
      width = widths[sparse.indices.componentType]!,
      indices = viewRange(
        checked.json,
        checked.bin,
        sparse.indices.bufferView,
        sparse.indices.byteOffset,
        sparse.count,
        width,
        width,
        true,
      ),
      values = viewRange(
        checked.json,
        checked.bin,
        sparse.values.bufferView,
        sparse.values.byteOffset,
        sparse.count,
        layout.elementBytes,
        layout.width,
        true,
      ),
      data = new DataView(
        checked.bin.buffer,
        checked.bin.byteOffset,
        checked.bin.byteLength,
      );
    for (let row = 0; row < sparse.count; row++) {
      const destination =
        component(
          data,
          indices.offset + row * indices.stride,
          sparse.indices.componentType,
        ) * layout.elementBytes;
      output.set(
        checked.bin.subarray(
          values.offset + row * values.stride,
          values.offset + row * values.stride + layout.elementBytes,
        ),
        destination,
      );
    }
  }
  return output;
}
