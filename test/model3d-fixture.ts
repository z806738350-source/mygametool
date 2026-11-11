import { Document, NodeIO } from "@gltf-transform/core";
import { deflateSync } from "node:zlib";

/** A real triangle GLB, optionally textured/skinned/animated, for geometry and recovery tests. */
export async function model3DFixture(options: { textured?: boolean; rigged?: boolean; clips?: string[] } = {}): Promise<Buffer> {
  const document = new Document(), buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  if (options.textured !== false) {
    const texture = document.createTexture().setMimeType("image/png").setImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB84AAAAASUVORK5CYII=", "base64"));
    primitive.setMaterial(document.createMaterial().setBaseColorTexture(texture));
    primitive.setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer));
  }
  const mesh = document.createMesh().addPrimitive(primitive), node = document.createNode("Character").setMesh(mesh);
  const joint = document.createNode("Root");
  document.createScene().addChild(node).addChild(joint);
  if (options.rigged) {
    node.setSkin(document.createSkin().addJoint(joint));
    primitive.setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint16Array(12)).setBuffer(buffer));
    primitive.setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])).setBuffer(buffer));
  }
  for (const name of options.clips ?? []) {
    const times = document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const values = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0])).setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(times).setOutput(values);
    document.createAnimation(name).addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath("translation").setSampler(sampler));
  }
  return Buffer.from(await new NodeIO().writeBinary(document));
}
export const TEST_GLB = await model3DFixture();

/** Synthetic binary FBX: one quad, one embedded PNG, no user-provided artwork. */
export function fbxFixture(options: { externalTexture?: boolean; wide?: boolean } = {}): Buffer {
  type Tree = { name: string; values?: Array<string | number | Buffer | number[]>; children?: Tree[] };
  const text = (name: string, value: string): Tree => ({ name, values: [value] });
  const p = (name: string, kind: string, ...values: number[]): Tree => ({ name: "P", values: [name, kind, "", "", ...values] });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB84AAAAASUVORK5CYII=", "base64");
  const trees: Tree[] = [
    { name: "GlobalSettings", children: [{ name: "Properties70", children: [p("UnitScaleFactor", "double", 100)] }] },
    { name: "Objects", children: [
      { name: "Geometry", values: [1, "Geometry::Quad", "Mesh"], children: [
        { name: "Vertices", values: [[0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]] },
        { name: "PolygonVertexIndex", values: [[0, 1, 2, -4]] },
        { name: "LayerElementUV", values: [0], children: [text("MappingInformationType", "ByPolygonVertex"), text("ReferenceInformationType", "Direct"), { name: "UV", values: [[0, 0, 1, 0, 1, 1, 0, 1]] }] },
      ] },
      { name: "Model", values: [2, "Model::Quad", "Mesh"], children: [{ name: "Properties70", children: [p("Lcl Scaling", "Lcl Scaling", 1, 1, 1)] }] },
      { name: "Material", values: [3, "Material::Mat", ""], children: [text("ShadingModel", "phong"), { name: "Properties70", children: [p("DiffuseColor", "Color", 1, 1, 1)] }] },
      { name: "Texture", values: [4, "Texture::Color", ""], children: [text("FileName", "embedded.png"), text("RelativeFilename", "embedded.png")] },
      { name: "Video", values: [5, "Video::Color", "Clip"], children: [text("RelativeFilename", "embedded.png"), ...(options.externalTexture ? [] : [{ name: "Content", values: [png] }])] },
    ] },
    { name: "Connections", children: [
      { name: "C", values: ["OO", 1, 2] }, { name: "C", values: ["OO", 3, 2] },
      { name: "C", values: ["OP", 4, 3, "DiffuseColor"] }, { name: "C", values: ["OO", 5, 4] },
    ] },
  ];
  const scalar = (value: NonNullable<Tree["values"]>[number], name: string): Buffer => {
    if (typeof value === "number") { const out = Buffer.alloc(9); out[0] = "D".charCodeAt(0); out.writeDoubleLE(value, 1); return out; }
    let payload: Buffer, type: string;
    if (Array.isArray(value)) {
      const integer = name === "PolygonVertexIndex", raw = Buffer.alloc(value.length * (integer ? 4 : 8));
      value.forEach((entry, index) => integer ? raw.writeInt32LE(entry, index * 4) : raw.writeDoubleLE(entry, index * 8));
      payload = deflateSync(raw); const header = Buffer.alloc(13); header[0] = (integer ? "i" : "d").charCodeAt(0);
      header.writeUInt32LE(value.length, 1); header.writeUInt32LE(1, 5); header.writeUInt32LE(payload.length, 9); return Buffer.concat([header, payload]);
    }
    if (typeof value === "string") { payload = Buffer.from(value); type = "S"; } else { payload = value; type = "R"; }
    const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32LE(payload.length, 1); return Buffer.concat([header, payload]);
  };
  const headerLength = options.wide ? 25 : 13;
  const encode = (tree: Tree, start: number): Buffer => {
    const name = Buffer.from(tree.name), properties = Buffer.concat((tree.values ?? []).map(value => scalar(value, tree.name)));
    let offset = start + headerLength + name.length + properties.length;
    const children = (tree.children ?? []).map(child => { const encoded = encode(child, offset); offset += encoded.length; return encoded; });
    const end = offset + (children.length ? headerLength : 0), header = Buffer.alloc(headerLength);
    if (options.wide) { header.writeBigUInt64LE(BigInt(end)); header.writeBigUInt64LE(BigInt(tree.values?.length ?? 0), 8); header.writeBigUInt64LE(BigInt(properties.length), 16); }
    else { header.writeUInt32LE(end); header.writeUInt32LE(tree.values?.length ?? 0, 4); header.writeUInt32LE(properties.length, 8); }
    header[headerLength - 1] = name.length;
    return Buffer.concat([header, name, properties, ...children, ...(children.length ? [Buffer.alloc(headerLength)] : [])]);
  };
  const header = Buffer.alloc(27); header.write("Kaydara FBX Binary  \0\x1a\0", "binary"); header.writeUInt32LE(options.wide ? 7500 : 7400, 23);
  let offset = 27;
  return Buffer.concat([header, ...trees.map(tree => { const bytes = encode(tree, offset); offset += bytes.length; return bytes; }), Buffer.alloc(headerLength)]);
}
