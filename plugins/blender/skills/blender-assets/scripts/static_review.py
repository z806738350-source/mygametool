"""Compare the original and a reimported GLB in neutral pose."""

import json
import math
from pathlib import Path
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector


VIEWS = ("front", "side", "back", "three-quarter")
CHANNELS = ("Base Color", "Normal", "Metallic", "Roughness", "Alpha", "Emission Color")


def settings(config, number):
    values = config.get("staticReview", {})
    if not isinstance(values, dict) or set(values) - {"sourceYawDegrees", "candidateYawDegrees", "excludeCandidateMeshes"}:
        raise ValueError("staticReview supports sourceYawDegrees, candidateYawDegrees, and excludeCandidateMeshes")
    source_yaw = number(values.get("sourceYawDegrees", 0), "staticReview.sourceYawDegrees", -360, 360)
    candidate_yaw = number(values.get("candidateYawDegrees", 0), "staticReview.candidateYawDegrees", -360, 360)
    names = values.get("excludeCandidateMeshes", [])
    if (not isinstance(names, list) or len(names) > 32
            or any(not isinstance(name, str) or not name.strip() or len(name) > 255 for name in names)
            or len(names) != len(set(names))):
        raise ValueError("staticReview.excludeCandidateMeshes must list distinct mesh names for props")
    return source_yaw, candidate_yaw, names


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def body_meshes(meshes, exclude):
    objects = [obj for obj in meshes() if obj.data.polygons]
    missing = set(exclude) - {obj.name for obj in objects}
    if missing:
        raise ValueError(f"Unknown static review exclusion: {', '.join(sorted(missing))}")
    kept = [obj for obj in objects if obj.name not in exclude]
    if not kept:
        raise ValueError("Static review must retain at least one character mesh")
    return kept


def audit_edges(objects):
    return {
        "meshes": [obj.name for obj in objects],
        "triangles": sum(map(triangle_count, objects)),
        "customNormalMeshes": sum(obj.data.has_custom_normals for obj in objects),
        "sharpEdges": sum(edge.use_edge_sharp for obj in objects for edge in obj.data.edges),
        "smoothFaces": sum(face.use_smooth for obj in objects for face in obj.data.polygons),
        "uvLayers": sum(len(obj.data.uv_layers) for obj in objects),
    }


def upstream_nodes(sockets):
    pending = [link.from_node for socket in sockets for link in socket.links]
    visited = set()
    while pending:
        node = pending.pop()
        if node in visited:
            continue
        visited.add(node)
        yield node
        pending.extend(link.from_node for inlet in node.inputs for link in inlet.links)


def audit_materials(objects, used_materials):
    rows = {}
    for material in sorted(used_materials(objects), key=lambda item: item.name):
        tree = material.node_tree
        channels = {}
        if tree:
            surfaces = [node.inputs["Surface"] for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
            for shader in (node for node in upstream_nodes(surfaces) if node.type == "BSDF_PRINCIPLED"):
                for name in CHANNELS:
                    images = {node.image for node in upstream_nodes([shader.inputs[name]]) if node.type == "TEX_IMAGE" and node.image}
                    if images:
                        channels.setdefault(name, set()).update(images)
        rows[material.name] = {name: [{"image": image.name, "size": list(image.size)} for image in sorted(images, key=lambda image: image.name)]
                               for name, images in channels.items()}
    return rows


def audit_normal_maps(objects, material_report):
    mapped_materials = {name for name, channels in material_report.items() if "Normal" in channels}
    triangles = 0
    for obj in objects:
        indices = {index for index, slot in enumerate(obj.material_slots) if slot.material and slot.material.name in mapped_materials}
        if indices:
            obj.data.calc_loop_triangles()
            triangles += sum(triangle.material_index in indices for triangle in obj.data.loop_triangles)
    return {
        "normalMaps": len({image["image"] for name in mapped_materials for image in material_report[name]["Normal"]}),
        "normalMappedTriangles": triangles,
    }


def place_at_rest(objects, yaw, world_positions):
    scene_objects = list(bpy.context.scene.objects)
    for obj in scene_objects:
        if obj.animation_data:
            obj.animation_data_clear()
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    rotation = Matrix.Rotation(math.radians(yaw), 4, "Z")
    graph = bpy.context.evaluated_depsgraph_get()
    points = np.concatenate([world_positions(obj.evaluated_get(graph)) for obj in objects])
    points = points @ np.asarray(rotation.to_3x3()).T
    lo, hi = points.min(axis=0), points.max(axis=0)
    dimensions = hi - lo
    height = dimensions[2]
    if not math.isfinite(height) or height <= 0:
        raise ValueError("Static review needs a mesh with a vertical extent")
    center = (lo + hi) / 2
    # Align the center in XY and the ground in Z, preserving all proportions.
    transform = Matrix.Scale(1 / height, 4) @ Matrix.Translation(-Vector((center[0], center[1], lo[2]))) @ rotation
    for obj in scene_objects:
        if obj.parent is None:
            obj.matrix_world = transform @ obj.matrix_world
    bpy.context.view_layer.update()
    return Vector(dimensions / height)


def pixels(filename):
    image = bpy.data.images.load(str(filename), check_existing=False)
    try:
        width, height = image.size
        values = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(values)
        return values.reshape((height, width, 4))
    finally:
        bpy.data.images.remove(image)


def comparison_image(work, output, view):
    source_clay = pixels(work / f"source-clay-{view}.png")
    candidate_clay = pixels(work / f"candidate-clay-{view}.png")
    src_mask = source_clay[:, :, 3] > .5
    cand_mask = candidate_clay[:, :, 3] > .5
    union = np.count_nonzero(src_mask | cand_mask)
    if not union or not np.any(src_mask) or not np.any(cand_mask):
        raise ValueError(f"Static review rendered an empty model in the {view} view")
    # Blender's pixels are bottom-up. The textured comparison is the top row.
    clay = np.concatenate((source_clay, candidate_clay), axis=1)
    color = np.concatenate((pixels(work / f"source-color-{view}.png"), pixels(work / f"candidate-color-{view}.png")), axis=1)
    image = bpy.data.images.new("Static comparison", width=clay.shape[1], height=clay.shape[0] * 2, alpha=True)
    try:
        image.pixels.foreach_set(np.concatenate((clay, color), axis=0).ravel())
        image.filepath_raw = str(output / f"static-review-{view}.png")
        image.file_format = "PNG"
        image.save()
    finally:
        bpy.data.images.remove(image)
    return round(np.count_nonzero(src_mask & cand_mask) / union, 4)


def compare(source, candidate_path, output, config, candidate_edges, *,
            meshes, number, world_positions, load_source, used_materials, render_reviews, material, file_digest):
    source_yaw, candidate_yaw, excluded = settings(config, number)
    candidate = body_meshes(meshes, excluded)
    candidate_dimensions = place_at_rest(candidate, candidate_yaw, world_positions)
    materials_key = "exportedMaterials" if candidate_path.suffix == ".glb" else "materials"
    candidate_edges[materials_key] = audit_materials(candidate, used_materials)
    candidate_edges.update(audit_normal_maps(candidate, candidate_edges[materials_key]))

    # Fit both models into one frame and render sequentially to bound texture memory.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    load_source(source, source.parent)
    original = body_meshes(meshes, ())
    original_audit = audit_edges(original)
    original_audit["materials"] = audit_materials(original, used_materials)
    original_audit.update(audit_normal_maps(original, original_audit["materials"]))
    original_dimensions = place_at_rest(original, source_yaw, world_positions)
    frame = Vector((0, 0, .5)), Vector(tuple(max(a, b) for a, b in zip(original_dimensions, candidate_dimensions)))
    render_config = {"previewSize": min(int(number(config.get("previewSize", 384), "previewSize", 64, 1024)), 384)}

    def render_pair(work, label, objects):
        render_reviews(work, render_config, f"{label}-color", frame=frame, views=VIEWS, objects=objects)
        clay = material("Neutral surface", [.55, .55, .55])
        try:
            render_reviews(work, render_config, f"{label}-clay", frame=frame, views=VIEWS, objects=objects, material_override=clay)
        finally:
            bpy.data.materials.remove(clay)

    # The silhouette overlap is observational. Pose differences and intended
    # edits can change it, so the agent reviews the paired renders.
    with tempfile.TemporaryDirectory(prefix=".static-review-", dir=output) as directory:
        work = Path(directory)
        render_pair(work, "source", original)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        load_source(candidate_path, output)
        candidate = body_meshes(meshes, excluded)
        place_at_rest(candidate, candidate_yaw, world_positions)
        render_pair(work, "candidate", candidate)
        silhouette = {view: comparison_image(work, output, view) for view in VIEWS}

    issues = []
    if (original_audit["customNormalMeshes"] and original_audit["sharpEdges"]
            and not candidate_edges["customNormalMeshes"] and not candidate_edges["sharpEdges"]
            and not candidate_edges["normalMappedTriangles"]):
        issues.append("The editable character lost all authored normals and sharp-edge marks. Restore or transfer that shading data, then re-export.")
    if (any("Base Color" in maps for maps in original_audit["materials"].values())
            and not any("Base Color" in maps for maps in candidate_edges[materials_key].values())):
        issues.append("The original character has base-color textures and the candidate lost them. Restore the texture binding and repeat the check.")
    views = [f"static-review-{view}.png" for view in VIEWS]
    report = {
        "sourceSha256": file_digest(source),
        "candidateArtifact": candidate_path.name,
        "pose": "Neutral rest pose with animation disabled",
        "layout": "Original at left, candidate at right. Materials above, neutral clay below. Same camera, lights, framing and height.",
        "sourceYawDegrees": source_yaw,
        "candidateYawDegrees": candidate_yaw,
        "excludedCandidateMeshes": excluded,
        "views": views,
        "silhouetteOverlap": silhouette,
        "source": original_audit,
        "candidate": candidate_edges,
        "repairIssues": issues,
    }
    (output / "static-review.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    return {"report": "static-review.json", "views": views, "repairIssues": issues}
