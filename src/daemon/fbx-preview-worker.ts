import { parentPort, workerData } from "node:worker_threads";
import { Document, NodeIO } from "@gltf-transform/core";

// Three's JS loader has no bundled TypeScript declarations. The installed, locked MIT package is used without plugins.
const threeModule = "three", loaderModule = "three/examples/jsm/loaders/FBXLoader.js";
try {
  const { inspectFbx } = await import(new URL(import.meta.url.endsWith(".ts") ? "./fbx-preview.ts" : "./fbx-preview.js", import.meta.url).href);
  const bytes = Buffer.from(workerData as Uint8Array), inspected = inspectFbx(bytes);
  const three = await import(threeModule), { FBXLoader } = await import(loaderModule);
  const blobs = new Map<string, Blob>();
  let imageBytes = 0;
  Object.assign(globalThis, { window: { URL: { createObjectURL(blob: Blob) {
    if ((imageBytes += blob.size) > 64 * 1024 * 1024) throw new Error();
    const uri = `blob:embedded-${blobs.size}`; blobs.set(uri, blob); return uri;
  } } }, fetch: async () => { throw new Error("External resources are unavailable in FBX previews"); } });
  three.TextureLoader.prototype.load = function (uri: string) {
    if (uri?.startsWith("data:image/") && uri.length < 32 * 1024 * 1024) {
      const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(uri);
      if (match) blobs.set(uri, new Blob([Buffer.from(match[2]!, "base64")], { type: match[1] }));
    }
    if (!blobs.has(uri)) throw new Error("External or unsupported FBX textures");
    const texture = new three.Texture(); texture.userData.embedded = uri; return texture;
  };
  const model = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  if (model.animations.length) throw new Error("Animated FBX is outside the static preview contract");
  model.updateMatrixWorld(true);
  const document = new Document(), buffer = document.createBuffer(), scene = document.createScene("Triangulated FBX preview");
  document.getRoot().setDefaultScene(scene);
  Object.assign(document.getRoot().getAsset(), { generator: "OhMyGame static FBX preview v1 (Three.js/glTF Transform)" });
  const meshes: any[] = [], materials = new Map<any, ReturnType<Document["createMaterial"]>>();
  model.traverse((node: any) => { if (node.isMesh) meshes.push(node); });
  let vertices = 0;
  for (const mesh of meshes) {
    if (mesh.isSkinnedMesh || Object.keys(mesh.geometry.morphAttributes).length || (vertices += mesh.geometry.attributes.position.count) > 2_000_000) throw new Error();
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    if (!geometry.attributes.position || geometry.attributes.position.count % 3) throw new Error();
    const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.attributes.position.count, materialIndex: 0 }];
    const outputMesh = document.createMesh();
    for (const group of groups) {
      if (group.start % 3 || group.count % 3 || group.start + group.count > geometry.attributes.position.count) throw new Error();
      const original = originalMaterials[group.materialIndex ?? 0]; if (!original) throw new Error();
      let material = materials.get(original);
      if (!material) {
        material = document.createMaterial().setBaseColorFactor([original.color.r, original.color.g, original.color.b, original.opacity])
          .setMetallicFactor(0).setRoughnessFactor(Math.sqrt(2 / (Math.max(0, original.shininess ?? 1) + 2)))
          .setDoubleSided(original.side === three.DoubleSide);
        if (original.opacity < 1 || original.transparent) material.setAlphaMode("BLEND");
        for (const [field, target] of [["map", "base"], ["normalMap", "normal"], ["emissiveMap", "emissive"]]) {
          const map = original[field!]; if (!map) continue;
          if (map.offset.x || map.offset.y || map.repeat.x !== 1 || map.repeat.y !== 1 || map.rotation) throw new Error();
          const blob = blobs.get(map.userData.embedded); if (!blob || !["image/png", "image/jpeg"].includes(blob.type)) throw new Error();
          const texture = document.createTexture().setImage(new Uint8Array(await blob.arrayBuffer())).setMimeType(blob.type);
          if (target === "base") material.setBaseColorTexture(texture);
          if (target === "normal") material.setNormalTexture(texture);
          if (target === "emissive") material.setEmissiveFactor(original.emissive.toArray()).setEmissiveTexture(texture);
        }
        materials.set(original, material);
      }
      const primitive = document.createPrimitive().setMode(4).setMaterial(material);
      for (const [key, semantic] of [["position", "POSITION"], ["normal", "NORMAL"], ["uv", "TEXCOORD_0"]]) {
        const input = geometry.attributes[key!]; if (!input) continue;
        if (input.itemSize !== (key === "uv" ? 2 : 3) || input.count !== geometry.attributes.position.count) throw new Error();
        const data = new Float32Array(group.count * input.itemSize);
        for (let i = 0; i < group.count; i++) for (let j = 0; j < input.itemSize; j++) {
          let value = input.array[(group.start + i) * input.itemSize + j];
          if (!Number.isFinite(value)) throw new Error();
          if (key === "uv" && j === 1) value = 1 - value;
          data[i * input.itemSize + j] = value;
        }
        primitive.setAttribute(semantic!, document.createAccessor().setType(input.itemSize === 2 ? "VEC2" : "VEC3").setArray(data).setBuffer(buffer));
      }
      outputMesh.addPrimitive(primitive);
    }
    const matrix = new three.Matrix4().makeScale(inspected.centimeters / 100, inspected.centimeters / 100, inspected.centimeters / 100).multiply(mesh.matrixWorld);
    if (matrix.elements.some((value: number) => !Number.isFinite(value))) throw new Error();
    const outputNode = document.createNode().setMatrix(matrix.toArray()).setMesh(outputMesh);
    // glTF stores TRS transforms. Reject shear rather than silently changing the shape.
    if (outputNode.getMatrix().some((value, index) => Math.abs(value - matrix.elements[index]) > 1e-5 * Math.max(1, Math.abs(value)))) throw new Error();
    scene.addChild(outputNode);
  }
  if (!meshes.length) throw new Error();
  document.getRoot().setExtras({ originalFormat: "fbx", triangulatedPreview: true, quadTopologyPreserved: false, materialApproximation: true });
  const output = await new NodeIO().writeBinary(document);
  if (output.length > 100 * 1024 * 1024) throw new Error();
  parentPort!.postMessage({ bytes: output }, [output.buffer]);
} catch { parentPort!.postMessage({ error: "preview-unavailable" }); }
