# Optimize a game asset

Keep the high-resolution source and any high-poly deliverable the brief requests. For an assessment-only brief, report opportunities. When preparing a game copy, optimize for the target device, closest gameplay view and expected number of visible instances. Start with the likely largest cost. If the device or budget is unknown, compare reversible changes at the intended camera distance and record that assumption. Use the `inspect` report for triangle, material, texture and bone counts and clip names. A headless `custom` script can read image dimensions, vertex weights and key counts when needed.

Use `checks.previewRoundtrip.glb` or the final `checks.roundtrip.glb` for exported bytes, mesh primitives and image bindings. Follow each entry in `materialTextureSlots` through `textureSources` to see which maps share an image. Older reports may lack this inventory. Inspect their retained GLB when a figure matters.

## Geometry

Keep the silhouette, facial landmarks, garment outlines and joint loops. Dissolve flat interior edges while preserving UV seams, sharp normals and material borders. Remove enclosed faces only if animation, detachable parts and viewing angles can never expose them. Model broad cloth folds and bake finer creases. For a plain static asset, `clean` can reduce toward `triangleBudget` with `decimate:true`. For skins, shape keys or shared meshes, use `custom` to retopologize a copy and preserve or transfer UVs, weights and morphs. Check deformed poses and shared instances after topology changes.

## Textures

For textured assets, check the pixel dimensions of each unique image and what it drives. In a clean GLB reimport, `[(im.name, tuple(im.size)) for im in bpy.data.images if im.source == "FILE"]` lists the imported images and sizes. For a 4096² input, try a 2048² copy at the same aspect ratio and compare the face, lettering, alpha edges and normals at the closest required view. Halving each dimension quarters the texel count. Let visible detail and screen coverage determine each map's resolution.

Keep base color and emissive textures in sRGB and data maps in Non-Color. For compatible UVs, transforms and sampling, pack occlusion in R, roughness in G and metallic in B. Connect the glTF occlusion and metallic-roughness inputs and pack the saved image into the working `.blend`. Inspect UV seams and the actual exported bindings. OhMyGame accepts embedded PNG, JPEG and WebP. Their encoded sizes measure storage. GPU memory depends on format, mip levels and resource sharing in the engine.

## Materials and draw calls

First reuse equivalent materials and consolidate redundant slots within each mesh, keeping its UVs. Preserve tiling, shared instances, swappable parts, pivots, alpha modes and independently controlled emission.

For static parts drawn together, try an atlas on a copy when it could reduce exported primitives or rendering cost. Start with simple UV layouts and compatible maps. Use Blender's UV packing and bake tools from `custom`, extending edge texels into the gutters around UV islands. Inspect the reimported GLB up close and at the farthest gameplay distance. Check for dark seams, bleeding and shading changes with the game's filtering and mip settings. Compare exported primitives and, when the game is available, draw calls in the same scene and render passes. For complex layouts, keep the original mapping unless a proven atlas workflow is available. If a trial loses detail or offers no worthwhile saving, keep the original and note why.

## Baking surface detail and lighting

Use a `custom` Cycles bake to transfer high-poly detail onto the game mesh's UVs as tangent-space normals and ambient occlusion. Bake unsupported procedural materials into the PBR maps they drive, then connect the images to an exportable material. Check bake projection, seams and normal orientation under neutral light. Keep movable characters and props free of baked directional shadows so they can turn under game lights. Bake scene lighting for fixed geometry in the target engine when the scene calls for it.

## Skeleton and animation

Bake IK and constraints into runtime actions before removing unused controls from the export copy in `custom`. Check each `deform:false` bone for attachments, parenting or animation dependencies. Preserve weighted joints, necessary parents, sockets, root motion, morphs and clip bindings. Bundled `rig` prunes and renormalizes to at most four deform influences per vertex. Inspect an imported rig before applying that target. Simplify redundant baked keys within a tolerance that preserves extreme poses, timing, loop seams and relevant foot contacts. Compare the reimported clips, including attached props, with the source in motion.

Record the relevant before/after counts and compare reimported candidates with the same camera, lighting and pose. Inspect distinctive details as well as the whole silhouette. Keep the higher-quality version where savings do not justify visible damage. If the original meets the target, record the evidence and keep it. For frame time, draw calls or GPU memory, compare the same game scene, instance count and render settings on the target device.
