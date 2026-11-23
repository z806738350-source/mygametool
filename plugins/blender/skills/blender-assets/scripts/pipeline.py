"""Repeatable Blender asset stages. Run inside Blender, never ordinary Python.

Inputs stay unchanged. Every stage writes a fresh output directory. The report
records measured technical checks for the Agent's review. The user reviews the final candidate.
"""

import argparse
import colorsys
import hashlib
import json
import math
from pathlib import Path
import runpy
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, str(Path(__file__).parent))
from export_glb import export_objects


def vector(value, label):
    if not isinstance(value, list) or len(value) != 3 or any(
        isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
        for x in value
    ):
        raise ValueError(f"{label} must contain three finite numbers")
    return Vector(value)


def number(value, label, minimum=0, maximum=1000000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return value


def meshes():
    return [obj for obj in export_objects() if obj.type == "MESH"]


def bounds(objects=None):
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    objects = meshes() if objects is None else objects
    for obj in objects:
        if not obj.data.vertices:
            continue
        points = world_positions(obj)
        low = np.minimum(low, points.min(axis=0))
        high = np.maximum(high, points.max(axis=0))
    if not np.all(np.isfinite(high)):
        raise ValueError("The scene has no mesh vertices")
    return Vector(low), Vector(high)


def geometry_report(objects=None):
    objects = meshes() if objects is None else objects
    low, high = bounds(objects)
    entries = []
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        bm = bmesh.new()
        bm.from_mesh(mesh)
        entries.append({
            "name": obj.name, "vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
            "boundaryEdges": sum(edge.is_boundary for edge in bm.edges),
            "nonManifoldInteriorEdges": sum(not edge.is_manifold and not edge.is_boundary for edge in bm.edges),
            "degenerateFaces": sum(face.calc_area() < 1e-12 for face in bm.faces),
            "uvLayers": len(mesh.uv_layers),
        })
        bm.free()
    materials = used_materials(objects)
    return {
        "meshes": entries, "triangles": sum(obj["triangles"] for obj in entries),
        "vertices": sum(obj["vertices"] for obj in entries),
        "bounds": {"min": list(low), "max": list(high), "size": list(high - low)},
        "materials": len(materials),
        "textures": len({image for mat in materials for image in material_images(mat)}),
    }


def source_inventory():
    objects = export_objects()
    materials = sorted(used_materials(objects), key=lambda mat: mat.name)
    actions = set()
    for owner in animation_owners(objects):
        data = owner.animation_data
        if data.action:
            actions.add(data.action.name)
        actions.update(strip.action.name for track in data.nla_tracks for strip in track.strips if strip.action)
    return {
        "parts": [{"name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None,
                   "worldPivot": list(obj.matrix_world.translation)} for obj in objects if obj.type in {"MESH", "EMPTY", "ARMATURE"}],
        "materials": [{"name": mat.name, "usesImageTexture": uses_image_texture(mat)} for mat in materials],
        "armatures": [{"name": obj.name, "bones": len(obj.data.bones)} for obj in objects if obj.type == "ARMATURE"],
        "actions": sorted(actions),
    }


def material(name, color):
    if not isinstance(color, list) or len(color) not in (3, 4):
        raise ValueError("Material color must contain RGB or RGBA values")
    rgba = [number(value, "color", 0, 1) for value in color]
    if len(rgba) == 3:
        rgba.append(1)
    result = bpy.data.materials.new(name)
    result.diffuse_color = rgba
    result.use_nodes = True
    node = next(node for node in result.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = rgba
    node.inputs["Roughness"].default_value = .7
    return result


def build_parts(config):
    parts = config.get("parts", [])
    if not isinstance(parts, list) or not 1 <= len(parts) <= 512:
        raise ValueError("parts must contain 1–512 explicit primitives")
    names = set()
    for part in parts:
        name = part["name"]
        if not isinstance(name, str) or not name or name in names:
            raise ValueError("Part names must be nonempty and unique")
        names.add(name)
        size = vector(part["size"], "part size")
        if any(value <= 0 for value in size):
            raise ValueError("Part dimensions must be positive")
        kind = part.get("type", "box")
        if kind == "box":
            bpy.ops.mesh.primitive_cube_add(size=1)
        elif kind == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=.5, depth=1)
        elif kind == "sphere":
            bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=.5)
        else:
            raise ValueError(f"Unsupported primitive: {kind}")
        obj = bpy.context.object
        obj.name = name
        obj.dimensions = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.location = vector(part.get("position", [0, 0, 0]), "part position")
        obj.rotation_euler = [math.radians(value) for value in vector(part.get("rotationDegrees", [0, 0, 0]), "part rotation")]
        obj.data.materials.append(material(name + "Material", part.get("color", [.5, .5, .5, 1])))
        bevel = number(part.get("bevel", 0), "bevel", 0, min(size) / 2)
        if bevel:
            modifier = obj.modifiers.new("Edge bevel", "BEVEL")
            modifier.width = bevel
            modifier.segments = 2
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.context.view_layer.update()


def load_source(source, input_root):
    if source.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    elif source.suffix.lower() == ".glb":
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif source.suffix.lower() == ".fbx":
        bpy.ops.wm.fbx_import(filepath=str(source))
    else:
        raise ValueError("Input must be an existing .blend, self-contained .glb or original .fbx")
    if bpy.data.libraries:
        raise ValueError("Linked Blender libraries must be made local before processing")
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file and image.filepath:
            image_path = Path(bpy.path.abspath(image.filepath)).resolve()
            if not image_path.is_relative_to(input_root):
                raise ValueError("Unpacked textures must be inside the task inputs")
            if not image_path.is_file():
                raise ValueError(f"Missing source texture {image.name}; supply its image in the declared inputs or pack it into the original model")
    if not meshes():
        raise ValueError("Input contains no meshes")


def clean(config):
    if any(obj.type == "ARMATURE" or obj.animation_data for obj in bpy.context.scene.objects):
        raise ValueError("Clean accepts static sources; preserve an existing rig in a separate workflow")
    objects = meshes()
    if any(obj.data.shape_keys or obj.modifiers for obj in objects):
        raise ValueError("Clean requires plain static meshes; preserve shape keys or apply modifiers explicitly in a separate copy")
    # Static kit pieces and vehicles can have meaningful origins, hierarchy and linked geometry.
    # Transform top-level roots together only when a normalization setting was supplied.
    normalization = Matrix.Identity(4)
    if "height" in config or "yawDegrees" in config:
        roots = set()
        for obj in objects:
            root = obj
            while root.parent:
                root = root.parent
            roots.add(root)
        angle = math.radians(number(config.get("yawDegrees", 0), "yawDegrees", -360, 360))
        rotation = Matrix.Rotation(angle, 4, "Z")
        for root in roots:
            root.matrix_world = rotation @ root.matrix_world
        bpy.context.view_layer.update()
        low, high = bounds(objects)
        scale = 1.0
        if "height" in config:
            height = number(config["height"], "height", .001, 10000)
            if high.z - low.z < 1e-8:
                raise ValueError("Cannot scale a zero-height mesh to a requested height")
            scale = height / (high.z - low.z)
        offset = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
        transform = Matrix.Scale(scale, 4) @ Matrix.Translation(offset)
        normalization = transform @ rotation
        for root in roots:
            root.matrix_world = transform @ root.matrix_world
        bpy.context.view_layer.update()

    distance = 0
    if "mergeDistance" in config:
        low, high = bounds(objects)
        # Use the longest dimension for flat or thin assets.
        distance = number(config["mergeDistance"], "mergeDistance", 0, max(high - low) / 100)
    recalculate = config.get("recalculateNormals", False)
    if not isinstance(recalculate, bool):
        raise ValueError("recalculateNormals must be true or false")
    if distance or recalculate:
        for obj in objects:
            bm = bmesh.new()
            try:
                bm.from_mesh(obj.data)
                if distance:
                    # Find welds in world units, then apply them to the original local coordinates.
                    linear = obj.matrix_world.to_3x3()
                    for vert in bm.verts:
                        vert.co = linear @ vert.co
                    targets = bmesh.ops.find_doubles(bm, verts=list(bm.verts), dist=distance)["targetmap"]
                    if not targets and not recalculate:
                        continue
                    for vert in bm.verts:
                        vert.co = obj.data.vertices[vert.index].co
                    bmesh.ops.weld_verts(bm, targetmap=targets)
                if recalculate:
                    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
                if obj.data.users > 1:
                    obj.data = obj.data.copy()
                bm.to_mesh(obj.data)
            finally:
                bm.free()

    if "triangleBudget" in config:
        target = number(config["triangleBudget"], "triangleBudget", 1, 2000000)
        if config.get("decimate", False):
            triangles = 0
            for obj in objects:
                obj.data.calc_loop_triangles()
                triangles += len(obj.data.loop_triangles)
            if triangles <= target:
                return normalization
            for obj in objects:
                if obj.data.users > 1:
                    obj.data = obj.data.copy()
                bpy.context.view_layer.objects.active = obj
                modifier = obj.modifiers.new("Budget reduction", "DECIMATE")
                modifier.ratio = target / triangles
                modifier.use_collapse_triangulate = True
                bpy.ops.object.modifier_apply(modifier=modifier.name)
    return normalization


def skeleton(config):
    joints = {name: vector(position, "joint " + name) for name, position in config["joints"].items()}
    bones = config["bones"]
    if not isinstance(bones, list) or not 1 <= len(bones) <= 256:
        raise ValueError("bones must contain 1–256 bones")
    names = set()
    for bone in bones:
        if not isinstance(bone["name"], str) or not bone["name"] or bone["name"] in names:
            raise ValueError("Bone names must be unique")
        names.add(bone["name"])
        if bone["head"] not in joints or bone["tail"] not in joints:
            raise ValueError("Every bone endpoint must name an explicit joint")
        if (joints[bone["head"]] - joints[bone["tail"]]).length < 1e-6:
            raise ValueError("Bone endpoints must differ")
    by_name = {bone["name"]: bone for bone in bones}
    for bone in bones:
        chain = {bone["name"]}
        parent = bone.get("parent")
        while parent:
            if parent not in by_name or parent in chain:
                raise ValueError("Bone parents must form an acyclic hierarchy")
            chain.add(parent)
            parent = by_name[parent].get("parent")
    return joints, bones


def skeleton_placement(config):
    joints, bones = skeleton(config)
    low, high = bounds()
    padding = (high - low).length * .05
    outside = []
    for bone in bones:
        if not bone.get("deform", True):
            continue
        # Clip the segment to the padded mesh AABB. Either endpoint may lie outside.
        head, tail = joints[bone["head"]], joints[bone["tail"]]
        start, end = 0.0, 1.0
        for axis in range(3):
            lo, hi = low[axis] - padding, high[axis] + padding
            delta = tail[axis] - head[axis]
            if abs(delta) < 1e-12:
                if not lo <= head[axis] <= hi:
                    end = -1
                    break
            else:
                near, far = sorted(((lo - head[axis]) / delta, (hi - head[axis]) / delta))
                start, end = max(start, near), min(end, far)
        if start > end:
            outside.append(bone["name"])
    return {"joints": len(joints), "bones": len(bones), "boundsPadding": padding,
            "outsideDeformBones": outside, "passed": not outside}


def joint_markers(config):
    joints, bones = skeleton(config)
    low, high = bounds()
    radius = (high - low).length * .008
    marker_material = material("Joint review", [1, .06, .02, 1])
    for name, point in joints.items():
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=radius, location=point)
        obj = bpy.context.object
        obj.name = "JointReview_" + name
        obj["workflow_review"] = True
        obj["joint_position"] = list(point)
        obj.data.materials.append(marker_material)
    return {"joints": {name: list(point) for name, point in joints.items()}, "bones": bones}


def assign_weights(obj, index, weights):
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("A region must assign a positive weight")
    for group in obj.vertex_groups:
        group.remove([index])
    for name, weight in weights.items():
        group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
        group.add([index], weight / total, "REPLACE")


def region_coverage(config, unclassified):
    policy = config.get("regionCoverage", "complete")
    if policy not in ("complete", "automatic-remainder") or policy == "automatic-remainder" and config.get("weighting") != "automatic":
        raise ValueError("regionCoverage must be complete, or automatic-remainder with automatic weighting")
    return {"coverage": policy, "unclassifiedVertices": unclassified,
            "passed": unclassified == 0 or policy == "automatic-remainder"}


def weight_report(arm):
    deform = {bone.name for bone in arm.data.bones if bone.use_deform}
    unweighted = 0
    non_normalized = 0
    maximum = 0
    for obj in meshes():
        groups = {group.index: group.name for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            weights = [entry.weight for entry in vertex.groups if groups[entry.group] in deform and entry.weight > 0]
            if not weights:
                unweighted += 1
            elif not math.isfinite(sum(weights)) or abs(sum(weights) - 1) > 1e-4:
                non_normalized += 1
            maximum = max(maximum, len(weights))
    return {"unweightedVertices": unweighted, "nonNormalizedVertices": non_normalized, "maximumInfluences": maximum}


def reset_pose(arm):
    arm.location = (0, 0, 0)
    for bone in arm.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
        bone.rotation_mode = "QUATERNION"
    bpy.context.view_layer.update()


def world_positions(evaluated):
    # foreach_get and Blender's bundled NumPy avoid allocating a Python Vector per vertex.
    coordinates = np.empty(len(evaluated.data.vertices) * 3, dtype=np.float32)
    evaluated.data.vertices.foreach_get("co", coordinates)
    transform = np.asarray(evaluated.matrix_world, dtype=np.float64)
    return coordinates.reshape(-1, 3) @ transform[:3, :3].T + transform[:3, 3]


def stress_check(arm, config, output):
    poses = config.get("stressPoses", [])
    objects = meshes()
    reset_pose(arm)
    graph = bpy.context.evaluated_depsgraph_get()
    rest = {obj.name: world_positions(obj.evaluated_get(graph)) for obj in objects}
    low, high = bounds(objects)
    epsilon = max(1e-8, (high - low).length * 1e-5)
    baselines = {obj.name: [(edge.vertices[:], (obj.data.vertices[edge.vertices[0]].co - obj.data.vertices[edge.vertices[1]].co).length) for edge in obj.data.edges] for obj in objects}

    def moved_vertices():
        bpy.context.view_layer.update()
        count = 0
        for obj in objects:
            delta = world_positions(obj.evaluated_get(graph)) - rest[obj.name]
            count += int(np.count_nonzero(np.einsum("ij,ij->i", delta, delta) > epsilon ** 2))
        return count

    results = []
    for pose in poses:
        reset_pose(arm)
        rotations = {}
        moved_by_bone = {}
        for name, degrees in pose["rotations"].items():
            bone = arm.pose.bones.get(name)
            if not bone:
                raise ValueError(f"Unknown stress-pose bone: {name}")
            bone.rotation_mode = "XYZ"
            rotation = [math.radians(value) for value in vector(degrees, "stress rotation")]
            if any(rotation):
                rotations[name] = rotation
                if bone.bone.use_deform:
                    # A working joint in the same pose must not hide a disconnected one.
                    bone.rotation_euler = rotation
                    moved_by_bone[name] = moved_vertices()
                    bone.rotation_euler = (0, 0, 0)
        for name, rotation in rotations.items():
            arm.pose.bones[name].rotation_euler = rotation
        moved = moved_vertices()
        worst = {"ratio": 1.0, "mesh": None, "vertices": None}
        for obj in objects:
            evaluated = obj.evaluated_get(graph)
            for indices, original in baselines[obj.name]:
                if original < 1e-8:
                    continue
                ratio = (evaluated.data.vertices[indices[0]].co - evaluated.data.vertices[indices[1]].co).length / original
                if ratio > worst["ratio"]:
                    worst = {"ratio": ratio, "mesh": obj.name, "vertices": list(indices)}
        entry = {"name": pose["name"], "worstEdgeStretch": worst, "movedVertices": moved,
                 "movementTolerance": epsilon, "movedVerticesByBone": moved_by_bone,
                 "passed": moved > 0 and all(moved_by_bone.values()) and worst["ratio"] <= config.get("maximumEdgeStretch", 2)}
        if config.get("previews", True):
            entry["previews"] = render_reviews(output, config, prefix=f"stress-{len(results) + 1}")
        results.append(entry)
    reset_pose(arm)
    return results


def rig(config, output):
    if any(obj.type == "ARMATURE" for obj in bpy.context.scene.objects):
        raise ValueError("Rig requires an unrigged source; it never replaces an existing armature")
    joints, definitions = skeleton(config)
    arm = bpy.data.objects.new("GameRig", bpy.data.armatures.new("GameSkeleton"))
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for definition in definitions:
        bone = arm.data.edit_bones.new(definition["name"])
        bone.head = joints[definition["head"]]
        bone.tail = joints[definition["tail"]]
        bone.roll = math.radians(number(definition.get("rollDegrees", 0), "bone roll", -360, 360))
    for definition in definitions:
        if definition.get("parent"):
            arm.data.edit_bones[definition["name"]].parent = arm.data.edit_bones[definition["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    for definition in definitions:
        arm.data.bones[definition["name"]].use_deform = definition.get("deform", True)
    objects = meshes()
    mode = config.get("weighting", "regions")
    if mode not in ("regions", "automatic"):
        raise ValueError("weighting must be regions or automatic")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        # Deform weights belong to the mesh data; each bound instance needs its own weights.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO" if mode == "automatic" else "ARMATURE_NAME", keep_transform=True)
    deform = {bone.name for bone in arm.data.bones if bone.use_deform}
    region_counts = []
    classified = {obj.name: bytearray(len(obj.data.vertices)) for obj in objects}
    for rule in config.get("regions", []):
        selected = [obj for obj in objects if obj.name == rule["object"]]
        if not selected:
            raise ValueError(f"Region object does not exist: {rule['object']}")
        weights = rule["weights"]
        if not weights or len(weights) > 4 or any(name not in deform for name in weights):
            raise ValueError("Region weights must name 1–4 deform bones")
        weights = {name: number(value, "weight", 0, 1) for name, value in weights.items()}
        limits = rule.get("bounds")
        low, high = (vector(limits[0], "region min"), vector(limits[1], "region max")) if limits else (None, None)
        if limits and any(low[i] > high[i] for i in range(3)):
            raise ValueError("Region minimum must not exceed maximum")
        indices = rule.get("vertices")
        if indices is not None and (not isinstance(indices, list) or any(type(index) is not int or index < 0 or index >= len(selected[0].data.vertices) for index in indices)):
            raise ValueError("Region vertex indices must exist in the current mesh")
        indices = set(indices) if indices is not None else None
        count = 0
        for obj in selected:
            for vertex in obj.data.vertices:
                point = obj.matrix_world @ vertex.co
                if indices is not None and vertex.index not in indices:
                    continue
                if limits and any(point[i] < low[i] or point[i] > high[i] for i in range(3)):
                    continue
                assign_weights(obj, vertex.index, weights)
                classified[obj.name][vertex.index] = 1
                count += 1
        if not count:
            raise ValueError("A region matched no vertices; check the normalized coordinates")
        region_counts.append({"name": rule.get("name", rule["object"]), "vertices": count})
    # The game export has four influences. Prune and normalize actual deform groups.
    for obj in objects:
        names = {group.index: group.name for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            weights = sorted(((names[entry.group], entry.weight) for entry in vertex.groups if names[entry.group] in deform and entry.weight > 0), key=lambda entry: -entry[1])[:4]
            if weights:
                assign_weights(obj, vertex.index, dict(weights))
    report = weight_report(arm)
    report["regions"] = region_counts
    report["regionCoverage"] = region_coverage(config, sum(flags.count(0) for flags in classified.values()))
    report["stressPoses"] = stress_check(arm, config, output)
    report["passed"] = report["regionCoverage"]["passed"] and bool(report["stressPoses"]) and report["unweightedVertices"] == 0 and report["nonNormalizedVertices"] == 0 and all(pose["passed"] for pose in report["stressPoses"])
    if not report["stressPoses"]:
        report["incomplete"] = "Supply stressPoses to measure and review deformation before animation"
    return report


def armature():
    arms = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(arms) != 1:
        raise ValueError("This stage requires exactly one armature")
    return arms[0]


def animate(config, output):
    arm = armature()
    if arm.animation_data and (arm.animation_data.action or arm.animation_data.nla_tracks):
        raise ValueError("Animate requires the unanimated rig stage; it does not replace existing clips")
    settings = config["locomotion"]
    frames = int(number(settings.get("frames", 32), "frames", 16, 240))
    fps = int(number(settings.get("fps", 24), "fps", 12, 60))
    stride = number(settings.get("stride", .24), "stride", .001, 2)
    lift = number(settings.get("lift", .07), "lift", .001, 1)
    floor_z = number(settings.get("floorZ", 0), "floorZ", -10000, 10000)
    hips = arm.pose.bones[settings["hips"]]
    pose_rotations = {name: vector(value, "pose rotation") for name, value in settings.get("poseRotations", {}).items()}
    swing_rotations = {name: vector(value, "swing rotation") for name, value in settings.get("swingRotations", {}).items()}
    if any(name not in arm.pose.bones for name in {*pose_rotations, *swing_rotations}):
        raise ValueError("Pose and swing rotations must name existing bones")
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.frame_start, scene.frame_end = 1, frames + 1
    feet = []
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for side in ("left", "right"):
        leg = settings[side]
        if "contactPoint" not in leg:
            raise ValueError(f"{side}.contactPoint must identify a sole point in normalized rest-space; contact checks are incomplete")
        contact = vector(leg["contactPoint"], side + " sole contactPoint")
        upper, lower, foot = [arm.data.edit_bones[leg[key]] for key in ("upper", "lower", "foot")]
        if lower.parent != upper or foot.parent != lower:
            raise ValueError("Each leg must be an upper → lower → foot chain")
        target = arm.data.edit_bones.new("IK_" + side)
        target.head, target.tail = foot.head, foot.tail
        target.roll, target.use_deform = foot.roll, False
        pole = arm.data.edit_bones.new("Pole_" + side)
        pole.head = lower.head + Vector((0, -(upper.length + lower.length), 0))
        pole.tail = pole.head + Vector((0, 0, .1))
        pole.use_deform = False
        feet.append({"side": side, "leg": leg, "target": target.name, "pole": pole.name, "rest": foot.head.copy(), "contact": contact})
    bpy.ops.object.mode_set(mode="OBJECT")
    for entry in feet:
        lower = arm.pose.bones[entry["leg"]["lower"]]
        constraint = lower.constraints.new("IK")
        constraint.target, constraint.subtarget = arm, entry["target"]
        constraint.pole_target, constraint.pole_subtarget = arm, entry["pole"]
        constraint.pole_angle = math.radians(number(entry["leg"].get("poleAngleDegrees", -90), "pole angle", -360, 360))
        constraint.chain_count, constraint.use_stretch = 2, False
        constraint = arm.pose.bones[entry["leg"]["foot"]].constraints.new("COPY_ROTATION")
        constraint.target, constraint.subtarget = arm, entry["target"]
        constraint.target_space, constraint.owner_space = "WORLD", "WORLD"
    arm.animation_data_create()
    clips = []
    actions = []
    for clip_name in ("Idle", "Walk"):
        reset_pose(arm)
        action = bpy.data.actions.new(clip_name)
        arm.animation_data.action = action
        contact_samples = {entry["side"]: [] for entry in feet}
        sampled_poses = []
        minimum_foot = 0.0
        minimum_mesh = 0.0
        travel = stride / .6 if clip_name == "Walk" else 0
        for frame in range(1, frames + 2):
            t = (frame - 1) / frames
            scene.frame_set(frame)
            arm.location = (0, -travel * t if settings.get("rootMotion", False) else 0, 0)
            arm.keyframe_insert(data_path="location", frame=frame)
            bob = -.04 + (.008 * math.sin(t * math.tau) if clip_name == "Idle" else .015 * math.cos(t * math.tau * 2))
            hips.location = hips.bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, bob))
            hips.keyframe_insert(data_path="location", frame=frame)
            # Left and right foot contact start at t=0 and t=0.5 respectively.
            swing = math.cos(t * math.tau) if clip_name == "Walk" else 0
            for name in {*pose_rotations, *swing_rotations}:
                bone = arm.pose.bones[name]
                angles = pose_rotations.get(name, Vector((0, 0, 0))) + swing_rotations.get(name, Vector((0, 0, 0))) * swing
                bone.rotation_quaternion = Euler(tuple(math.radians(angle) for angle in angles), "XYZ").to_quaternion()
                bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            for entry in feet:
                phase = (t + (0 if entry["side"] == "left" else .5)) % 1
                stance = clip_name == "Idle" or phase < .6
                y, z = 0, 0
                if clip_name == "Walk":
                    if stance:
                        y = -stride / 2 + stride * phase / .6
                    else:
                        u = (phase - .6) / .4
                        y = stride / 2 - stride * (u * u * (3 - 2 * u))
                        z = lift * math.sin(math.pi * u)
                target = arm.pose.bones[entry["target"]]
                target.location = target.bone.matrix_local.to_3x3().inverted() @ Vector((0, y, z))
                target.keyframe_insert(data_path="location", frame=frame)
                target.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            bpy.context.view_layer.update()
            graph = bpy.context.evaluated_depsgraph_get()
            minimum_mesh = min(minimum_mesh, min((obj.evaluated_get(graph).matrix_world @ vertex.co).z - floor_z for obj in meshes() for vertex in obj.evaluated_get(graph).data.vertices))
            sampled_poses.append({bone.name: bone.matrix.copy() for bone in arm.pose.bones if bone.bone.use_deform})
            for entry in feet:
                phase = (t + (0 if entry["side"] == "left" else .5)) % 1
                bone = arm.pose.bones[entry["leg"]["foot"]]
                point = arm.matrix_world @ bone.matrix @ bone.bone.matrix_local.inverted() @ entry["contact"]
                minimum_foot = min(minimum_foot, point.z - floor_z)
                if not settings.get("rootMotion", False):
                    point += Vector((0, -travel * t, 0))
                contact_samples[entry["side"]].append((frame, clip_name == "Idle" or phase < .6, point.copy()))
        # Bake the evaluated IK result into ordinary pose channels before delivery.
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        bpy.ops.nla.bake(frame_start=1, frame_end=frames + 1, step=1, only_selected=False, visual_keying=True, clear_constraints=False, clear_parents=False, use_current_action=True, bake_types={"POSE", "OBJECT"})
        actions.append(action)
        slip = 0.0
        for samples in contact_samples.values():
            anchor = None
            for frame, contact, point in samples:
                if not contact:
                    anchor = None
                elif anchor is None or frame == frames + 1:
                    anchor = point
                else:
                    slip = max(slip, Vector((point.x - anchor.x, point.y - anchor.y)).length)
        loop_error = max((sampled_poses[0][name].translation - sampled_poses[-1][name].translation).length for name in sampled_poses[0])
        loop_angle = max(sampled_poses[0][name].to_quaternion().rotation_difference(sampled_poses[-1][name].to_quaternion()).angle for name in sampled_poses[0])
        clips.append({"name": clip_name, "frames": [1, frames + 1], "fps": fps, "durationSeconds": frames / fps, "rootMotion": bool(settings.get("rootMotion", False)), "travelDistance": travel, "contactSlip": slip, "maximumFootPenetration": -minimum_foot, "maximumMeshPenetration": -minimum_mesh, "loopPositionError": loop_error, "loopAngleErrorRadians": loop_angle, "contactMeasurement": "world" if settings.get("rootMotion", False) else "world with declared virtual root travel", "passed": slip <= settings.get("maximumSlip", .015) and -minimum_foot <= settings.get("maximumPenetration", .01) and -minimum_mesh <= settings.get("maximumPenetration", .01) and loop_error <= .005 and loop_angle <= .01})
    for bone in arm.pose.bones:
        for constraint in list(bone.constraints):
            bone.constraints.remove(constraint)
    arm.animation_data.action = None
    for action in actions:
        track = arm.animation_data.nla_tracks.new()
        track.name = action.name
        strip = track.strips.new(action.name, 1, action)
        strip.action_frame_start, strip.action_frame_end = 1, frames + 1
        track.mute = True
    reset_pose(arm)
    scene.frame_set(1)
    previews = []
    if config.get("previews", True):
        arm.animation_data.action = actions[1]
        sample_frames = [1 + round(frames * factor) for factor in (0, .25, .5, .75)]
        # A fixed camera across the walk shows root travel and planted-foot drift.
        corners = []
        for frame in sample_frames:
            scene.frame_set(frame)
            center, size = review_frame()
            corners.extend((center - size / 2, center + size / 2))
        low, high = Vector(np.min(corners, axis=0)), Vector(np.max(corners, axis=0))
        walk_frame = (high + low) / 2, high - low
        for index, frame in enumerate(sample_frames, 1):
            scene.frame_set(frame)
            previews.extend(render_reviews(output, config, prefix=f"walk-{index}", frame=walk_frame))
        arm.animation_data.action = None
        reset_pose(arm)
        scene.frame_set(1)
    return {
        "clips": clips, "previews": previews, "passed": all(clip["passed"] for clip in clips),
        "contactFootBones": [entry["leg"]["foot"] for entry in feet],
        "note": "Two-leg -Y-forward baseline. Foot contact checks cover only the listed bones. Inspect motion and clothing in playback.",
    }


def review_frame(yaw=0):
    """Measure the evaluated geometry in the canonical review axes, including posed limbs."""
    rotation = Matrix.Rotation(yaw, 3, "Z")
    graph = bpy.context.evaluated_depsgraph_get()
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    for obj in meshes():
        points = world_positions(obj.evaluated_get(graph))
        if not len(points):
            continue
        if yaw:
            points = points @ np.asarray(rotation).T
        low = np.minimum(low, points.min(axis=0))
        high = np.maximum(high, points.max(axis=0))
    if not np.all(np.isfinite(high)) or max(high - low) <= 0:
        raise ValueError("No visible mesh with a measurable extent for review")
    return rotation.inverted() @ Vector((high + low) / 2), Vector(high - low)


def render_reviews(output, config, prefix="review", *, frame=None, yaw=0, views=None, objects=None, material_override=None):
    center, dimensions = frame or review_frame(yaw)
    extent = max(dimensions)
    directions = {"front": (0, -1, 0), "side": (1, 0, 0), "back": (0, 1, 0), "three-quarter": (1, -1.65, .65)}
    if views is None:
        views = directions if prefix in ("source", "review") else ("front", "side")
    original = bpy.context.scene
    # Use a temporary scene so inspecting a source never alters its own cameras,
    # lights, compositor, render settings, or world material in the saved .blend.
    scene = bpy.data.scenes.new("Asset review")
    world = bpy.data.worlds.new("ReviewWorld")
    camera_data = bpy.data.cameras.new("ReviewCamera")
    light_data = bpy.data.lights.new("ReviewLight", "AREA")
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    light = bpy.data.objects.new("ReviewLight", light_data)
    markers = {obj: obj.location.copy() for obj in original.objects if obj.get("workflow_review") and "joint_position" in obj}
    names = []
    try:
        for obj in export_objects(include_review=True) if objects is None else objects:
            scene.collection.objects.link(obj)
        scene.frame_set(original.frame_current, subframe=original.frame_subframe)
        scene.view_layers[0].material_override = material_override
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 8
        scene.render.resolution_x = scene.render.resolution_y = int(number(config.get("previewSize", 384), "previewSize", 64, 1024))
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.film_transparent = True
        scene.world = world
        world.color = (.35, .35, .35)
        scene.collection.objects.link(camera)
        scene.collection.objects.link(light)
        scene.camera = camera
        camera_data.type = "ORTHO"
        camera_data.clip_start = max(1e-6, extent * .0001)
        camera_data.clip_end = extent * 12
        light_data.shape = "DISK"
        light_data.size = extent * 2
        light_data.energy = 100 * extent ** 2
        undo_yaw = Matrix.Rotation(-yaw, 3, "Z")
        for name in views:
            direction = Vector(directions[name]).normalized()
            canonical = (-direction).to_track_quat("-Z", "Y")
            # Fit the projected width/height, including diagonals in the oblique view.
            projected = [sum(abs(value) * size for value, size in zip(canonical @ axis, dimensions))
                         for axis in (Vector((1, 0, 0)), Vector((0, 1, 0)))]
            camera_data.ortho_scale = max(projected) * 1.15
            direction = undo_yaw @ direction
            for marker in markers:
                point = Vector(marker["joint_position"])
                marker.location = point + direction * (extent - (point - center).dot(direction))
            camera.location = center + direction * extent * 3
            camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
            light.location = center + direction * extent * 2 + undo_yaw @ Vector((extent, 0, extent * 2))
            light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
            filename = f"{prefix}-{name}.png"
            scene.render.filepath = str(output / filename)
            bpy.ops.render.render(scene=scene.name, write_still=True)
            names.append(filename)
    finally:
        for marker, original_location in markers.items():
            marker.location = original_location
        bpy.data.scenes.remove(scene)
        bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.objects.remove(light, do_unlink=True)
        bpy.data.cameras.remove(camera_data)
        bpy.data.lights.remove(light_data)
        bpy.data.worlds.remove(world)
    return names


def region_review(config, output):
    rules = config.get("regions", [])
    if not rules:
        coverage = region_coverage(config, sum(len(obj.data.vertices) for obj in meshes()))
        if not coverage["passed"]:
            coverage["incomplete"] = "No explicit regions supplied; body/clothing segmentation remains unreviewed"
        return coverage
    originals = [(obj, list(obj.data.materials), [poly.material_index for poly in obj.data.polygons]) for obj in meshes()]
    inspection_copies = []
    counts = []
    try:
        unmatched = material("Unclassified", [.25, .25, .25, 1])
        assignments = {}
        for obj in meshes():
            if obj.data.users > 1:
                # Linked instances can have different anatomical labels in world coordinates.
                source = obj.data
                obj.data = source.copy()
                inspection_copies.append((obj, source, obj.data))
            obj.data.materials.clear()
            obj.data.materials.append(unmatched)
            assignments[obj.name] = [0] * len(obj.data.vertices)
        for index, rule in enumerate(rules, 1):
            obj = bpy.data.objects.get(rule["object"])
            if obj is None or obj.name not in assignments:
                raise ValueError("Region object is absent from the current mesh")
            color = list(colorsys.hsv_to_rgb((index * .61803398875) % 1, .8, .85))
            obj.data.materials.append(material("Region_" + str(index), color))
            slot = len(obj.data.materials) - 1
            vertices = set(rule["vertices"]) if "vertices" in rule else None
            box = rule.get("bounds")
            count = 0
            for vertex in obj.data.vertices:
                point = obj.matrix_world @ vertex.co
                if vertices is not None and vertex.index not in vertices:
                    continue
                if box and any(point[i] < box[0][i] or point[i] > box[1][i] for i in range(3)):
                    continue
                assignments[obj.name][vertex.index] = slot
                count += 1
            counts.append({"name": rule.get("name", rule["object"]), "vertices": count, "color": color})
        for obj in meshes():
            for poly in obj.data.polygons:
                slots = [assignments[obj.name][index] for index in poly.vertices]
                poly.material_index = max(set(slots), key=slots.count)
        previews = render_reviews(output, config, prefix="regions") if config.get("previews", True) else []
        unclassified = sum(value == 0 for values in assignments.values() for value in values)
        coverage = region_coverage(config, unclassified)
        return {**coverage, "regions": counts, "previews": previews,
                "passed": coverage["passed"] and all(entry["vertices"] > 0 for entry in counts),
                "humanReview": "pending: colors show supplied rules, not inferred semantic correctness"}
    finally:
        for obj, materials, indices in originals:
            obj.data.materials.clear()
            for item in materials:
                obj.data.materials.append(item)
            for poly, index in zip(obj.data.polygons, indices):
                poly.material_index = index
        for obj, source, copy in inspection_copies:
            obj.data = source
            bpy.data.meshes.remove(copy)


def animation_owners(objects):
    """glTF animations can drive objects, an armature's pose or mesh morph keys."""
    owners = set(objects)
    owners.update(obj.data.shape_keys for obj in objects if obj.type == "MESH" and obj.data.shape_keys)
    return sorted((owner for owner in owners if owner.animation_data), key=lambda owner: (owner.id_type, owner.name))


def excursion_frames(action, slot):
    """Sample an actual keyed excursion, even when it falls between evenly spaced frames."""
    for layer in action.layers:
        for strip in layer.strips:
            bag = strip.channelbag(slot)
            if bag:
                for curve in bag.fcurves:
                    keys = curve.keyframe_points
                    if len(keys) > 1:
                        low = min(keys, key=lambda point: point.co.y)
                        high = max(keys, key=lambda point: point.co.y)
                        if high.co.y - low.co.y > 1e-6:
                            return (low.co.x, high.co.x)
    return ()


def motion_phases(distances):
    frames = sorted(distances)
    if len(frames) <= 3:
        return frames
    start, end = frames[0], frames[-1]
    peak = max(frames, key=distances.get)
    amplitude = distances[peak]
    if amplitude <= 1e-6:
        return [start, frames[len(frames) // 2], end]
    # For a loop, show a distinct intermediate pose instead of a duplicate of the start.
    phases = {start, peak, end}
    middle = [frame for frame in frames[1:-1] if frame != peak]
    half = min(middle, key=lambda frame: abs(distances[frame] - amplitude / 2))
    if peak == end:
        phases.add(half)
    elif distances[end] < amplitude * .05 and amplitude * .05 < distances[half] < amplitude * .95:
        phases = {start, half, peak}
    return sorted(phases)


def playback_samples(output, config, review_clips):
    """Activate all imported slots of each glTF clip together; isolate other clips."""
    objects = list(bpy.context.scene.objects)
    grouped = {}
    for owner in animation_owners(objects):
        data = owner.animation_data
        data.action = None
        for track in data.nla_tracks:
            track.mute = True
            for strip in track.strips:
                if strip.action:
                    grouped.setdefault(track.name, []).append((data, strip.action, strip.action_slot))
    scene = bpy.context.scene
    visible_meshes = meshes()
    results = []
    for name, bindings in sorted(grouped.items()):
        start = min(action.frame_range[0] for _, action, _ in bindings)
        end = max(action.frame_range[1] for _, action, _ in bindings)
        frames = {start + (end - start) * factor / 8 for factor in range(9)}
        for data, action, slot in bindings:
            data.action = action
            if slot:
                data.action_slot = slot
                if len(frames) < 32:
                    frames.update(excursion_frames(action, slot))
        baseline = {}
        distances = {}
        record_views = name in review_clips
        low, high = np.full(3, np.inf), np.full(3, -np.inf)
        for frame in sorted(frames):
            scene.frame_set(math.floor(frame), subframe=frame % 1)
            graph = bpy.context.evaluated_depsgraph_get()
            displacement = 0
            for obj in visible_meshes:
                world = world_positions(obj.evaluated_get(graph))
                if not len(world):
                    continue
                # Bulk reads also catch movement confined to a small morph or a few weighted vertices.
                if record_views:
                    low, high = np.minimum(low, world.min(axis=0)), np.maximum(high, world.max(axis=0))
                if obj not in baseline:
                    baseline[obj] = world
                else:
                    world -= baseline[obj]
                    displacement = max(displacement, math.sqrt(float(np.einsum("ij,ij->i", world, world).max())))
            distances[frame] = displacement
        displacement = max(distances.values())
        result = {"name": name, "sampledFrames": len(frames), "sampledVertexDisplacement": displacement, "passed": end > start and displacement > 1e-6}
        if record_views:
            clip_index = review_clips.index(name) + 1
            result["motionReview"] = []
            camera_frame = Vector((low + high) / 2), Vector(high - low)
            for index, frame in enumerate(motion_phases(distances), 1):
                scene.frame_set(math.floor(frame), subframe=frame % 1)
                prefix = f"motion-{clip_index:02d}-{index:02d}"
                file, = render_reviews(output, config, prefix, frame=camera_frame, views=("three-quarter",))
                result["motionReview"].append({"frame": frame, "file": file})
        results.append(result)
        for data, _, _ in bindings:
            data.action = None
    return results


def used_materials(objects):
    return {obj.material_slots[index].material for obj in objects if obj.type == "MESH"
            for index in {polygon.material_index for polygon in obj.data.polygons}
            if index < len(obj.material_slots) and obj.material_slots[index].material}


def material_images(mat):
    tree = mat.node_tree
    images = set()
    if not tree:
        return images
    pending = [node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
    visited = set()
    while pending:
        node = pending.pop()
        if node in visited:
            continue
        visited.add(node)
        if node.type == "TEX_IMAGE" and node.image:
            images.add(node.image)
        pending.extend(link.from_node for socket in node.inputs for link in socket.links)
    return images


def uses_image_texture(mat):
    return bool(material_images(mat))


def write_export(output, filename, required_clips, review_config, *, geometry=None):
    required_clips = [] if required_clips is None else required_clips
    if not isinstance(required_clips, list) or any(not isinstance(name, str) or not name.strip() for name in required_clips):
        raise ValueError("requiredClips must be a list of nonempty animation names")
    review_clips = (review_config or {}).get("motionReviewClips", [])
    if (not isinstance(review_clips, list) or len(review_clips) > 4
            or any(not isinstance(name, str) or not name.strip() for name in review_clips)
            or len(set(review_clips)) != len(review_clips)):
        raise ValueError("motionReviewClips must list up to four distinct animation names")
    if review_clips and not review_config.get("previews", True):
        raise ValueError("motionReviewClips needs previews enabled")
    objects = export_objects()
    before = geometry if geometry is not None else geometry_report([obj for obj in objects if obj.type == "MESH"])
    materials = used_materials(objects)
    expected_materials = {mat.name for mat in materials}
    expected_textured = {mat.name for mat in materials if uses_image_texture(mat)}
    expected_bones = {bone.name for arm in objects if arm.type == "ARMATURE" for bone in arm.data.bones if bone.use_deform}
    expected_clips = set()
    for owner in animation_owners(objects):
        data = owner.animation_data
        if data.action:
            expected_clips.add(data.action.name)
        for track in data.nla_tracks:
            expected_clips.update(strip.action.name for strip in track.strips if strip.action)
    original_argv = sys.argv
    try:
        sys.argv = ["export_glb.py", "--", "--output", str(output / filename)]
        runpy.run_path(str(Path(__file__).with_name("export_glb.py")), run_name="__main__")
    finally:
        sys.argv = original_argv
    return {"bounds": before["bounds"], "triangles": before["triangles"], "materials": sorted(expected_materials),
            "textured": sorted(expected_textured), "bones": sorted(expected_bones), "clips": sorted(expected_clips),
            "requiredClips": required_clips, "reviewClips": review_clips}


def _read_glb_inventory(file):
    # Keep embedded textures and geometry out of Python memory while Blender imports the same file.
    with file.open("rb") as stream:
        header = stream.read(20)
        if len(header) != 20:
            raise ValueError("Export has an incomplete GLB header")
        magic, version, size, json_length, json_type = struct.unpack("<4sIIII", header)
        if (magic != b"glTF" or version != 2 or size != file.stat().st_size
                or json_type != 0x4E4F534A or json_length > size - len(header)):
            raise ValueError("Export has an invalid GLB header or JSON chunk")
        document = json.loads(stream.read(json_length))
    clips = {animation.get("name", "") for animation in document.get("animations", [])}
    joints = {document["nodes"][index].get("name", "") for skin in document.get("skins", []) for index in skin["joints"]}
    material_slots = []
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        slots = {key: pbr[key]["index"] for key in ("baseColorTexture", "metallicRoughnessTexture") if key in pbr}
        slots.update({key: material[key]["index"] for key in ("normalTexture", "occlusionTexture", "emissiveTexture") if key in material})
        material_slots.append({"name": material.get("name", ""), "slots": slots})
    texture_sources = []
    for texture in document.get("textures", []):
        sources = {"source": texture["source"]} if "source" in texture else {}
        sources.update({name: extension["source"] for name, extension in texture.get("extensions", {}).items()
                        if isinstance(extension, dict) and "source" in extension})
        texture_sources.append(sources)
    return clips, joints, {
        "bytes": size, "meshPrimitives": sum(len(mesh["primitives"]) for mesh in document.get("meshes", [])),
        "embeddedImages": sum("bufferView" in image for image in document.get("images", [])),
        "textures": len(texture_sources), "textureSources": texture_sources, "materialTextureSlots": material_slots,
    }


def glb_inventory(file):
    return _read_glb_inventory(file)[:2]


def verify_export(output, filename, before, review_config):
    clip_names, joint_names, glb = _read_glb_inventory(output / filename)
    expected_bones = set(before["bones"])
    expected_clips = set(before["clips"])
    required_clips = before["requiredClips"]
    review_clips = before["reviewClips"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output / filename))
    after = geometry_report()
    imported_materials = used_materials(bpy.context.scene.objects)
    missing_materials = set(before["materials"]) - {mat.name for mat in imported_materials}
    missing_textures = set(before["textured"]) - {mat.name for mat in imported_materials if uses_image_texture(mat)}
    previews = render_reviews(output, review_config) if review_config is not None and review_config.get("previews", True) else []
    playback = playback_samples(output, review_config or {}, review_clips)
    size_error = [abs(a - b) for a, b in zip(before["bounds"]["size"], after["bounds"]["size"])]
    bounds_error = max(abs(a - b) for bound in ("min", "max")
                       for a, b in zip(before["bounds"][bound], after["bounds"][bound]))
    tolerance = max(.001, max(before["bounds"]["size"]) * 1e-6)
    missing_required = set(required_clips) - clip_names
    missing_reviews = set(review_clips) - {clip["name"] for clip in playback if clip.get("motionReview")}
    passed = (before["triangles"] == after["triangles"] and max(size_error) < tolerance and bounds_error < tolerance
              and expected_bones.issubset(joint_names) and not missing_materials and not missing_textures
              and not missing_required and not missing_reviews and expected_clips == clip_names
              and {clip["name"] for clip in playback} == clip_names and all(clip["passed"] for clip in playback))
    return {"glb": glb, "trianglesBefore": before["triangles"], "trianglesAfter": after["triangles"], "heightError": size_error[2],
            "sizeError": size_error, "boundsError": bounds_error, "boundsTolerance": tolerance,
            "expectedBones": sorted(expected_bones), "exportedJoints": sorted(joint_names),
            "requiredClips": sorted(set(required_clips)), "missingRequiredClips": sorted(missing_required),
            "missingMotionReviewClips": sorted(missing_reviews), "previews": previews,
            "expectedClips": sorted(expected_clips), "exportedClips": sorted(clip_names), "playback": playback,
            "missingMaterials": sorted(missing_materials), "missingTexturedMaterials": sorted(missing_textures),
            "passed": passed, "runtimeReview": f"pending: load {filename} and play every clip in the target project"}


def export_roundtrip(output, filename="model.glb", required_clips=None, review_config=None):
    before = write_export(output, filename, required_clips, review_config)
    return verify_export(output, filename, before, review_config)


def prepare_scene(args, output, input_root, config, report):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.context.scene.unit_settings.system = "METRIC"
    if args.stage != "parts":
        if not args.input:
            raise ValueError("This stage requires --input")
        source = Path(args.input).resolve()
        if not source.is_relative_to(input_root) or source.is_relative_to(output):
            raise ValueError("Source must be a separate file inside the task inputs")
        load_source(source, input_root)
        if args.stage == "inspect":
            report["sourceInventory"] = source_inventory()
    if args.stage in ("joints", "rig"):
        report["checks"]["skeleton"] = skeleton_placement(config)
    if args.stage == "parts":
        build_parts(config)
    elif args.stage == "clean":
        report["sourceGeometry"] = geometry_report()
        source_frame = None
        clean_frame = None
        if config.get("previews", True):
            yaw = math.radians(number(config.get("yawDegrees", 0), "yawDegrees", -360, 360))
            source_frame = review_frame(yaw)
            report["sourcePreviews"] = render_reviews(output, config, "source", frame=source_frame, yaw=yaw)
        normalization = clean(config)
        if source_frame:
            # Keep the source framing even if cleanup removes a prominent feature.
            center, size = source_frame
            clean_frame = normalization @ center, size * normalization.to_scale().x
    elif args.stage == "joints":
        report["checks"]["regions"] = region_review(config, output)
    elif args.stage == "rig":
        report["checks"]["rig"] = rig(config, output)
    elif args.stage == "animate":
        report["checks"]["animation"] = animate(config, output)
    report["geometry"] = geometry_report()
    topology = {key: sum(mesh[key] for mesh in report["geometry"]["meshes"]) for key in ("boundaryEdges", "nonManifoldInteriorEdges", "degenerateFaces")}
    policy = config.get("topologyPolicy", "inspect")
    if policy not in ("inspect", "allow-open", "watertight"):
        raise ValueError("topologyPolicy must be inspect, allow-open or watertight")
    topology["policy"] = policy
    topology["passed"] = (policy != "watertight" or topology["boundaryEdges"] == 0) and topology["nonManifoldInteriorEdges"] <= config.get("allowedNonManifoldInteriorEdges", 0) and topology["degenerateFaces"] <= config.get("allowedDegenerateFaces", 0)
    if topology["boundaryEdges"]:
        topology["review"] = "Open borders or split shading/UV seams need visual review; they are not automatically holes"
    report["checks"]["topology"] = topology
    if "triangleBudget" in config:
        report["checks"]["triangleBudget"] = {"limit": config["triangleBudget"], "actual": report["geometry"]["triangles"], "passed": report["geometry"]["triangles"] <= config["triangleBudget"]}
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), compress=False)
    if args.stage == "joints":
        joint_markers(config)
    if config.get("previews", True) and args.stage in ("inspect", "parts", "clean", "joints", "rig"):
        report["previews"] = render_reviews(output, config, frame=clean_frame if args.stage == "clean" else None, views=("front", "side") if args.stage == "joints" else None)


def file_digest(file):
    with file.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, choices=("inspect", "parts", "clean", "joints", "rig", "animate", "static-review", "export"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--input")
    parser.add_argument("--input-dir", default=".")
    parser.add_argument("--output-dir", "--output", required=True)
    parser.add_argument("--export-phase", choices=("prepare", "verify"))
    parser.add_argument("--export-state", type=Path)
    parser.add_argument("--static-review-source")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = Path(args.output_dir).resolve()
    state = args.export_state.resolve() if args.export_state else None
    if bool(state) != bool(args.export_phase) or (state and args.stage != "export"):
        raise ValueError("Export phases require the bundled export stage and its private state file")
    if state and (state.parent != output.parent / "tmp" or state.suffix != ".json" or state.is_relative_to(output)):
        raise ValueError("Export state must be a JSON file in the job's private tmp directory")
    if args.export_phase != "verify" and output.exists() and any(output.iterdir()):
        raise FileExistsError("A stage needs a new or empty output directory")
    output.mkdir(parents=True, exist_ok=True)
    input_root = Path(args.input_dir).resolve()
    config_path = Path(args.config).resolve()
    if not config_path.is_relative_to(input_root):
        raise ValueError("Config must be inside the task inputs")
    config = json.loads(config_path.read_text())
    static_source = (input_root / args.static_review_source).resolve() if args.static_review_source else None
    if ((args.stage == "static-review" and not static_source)
            or (static_source and (args.stage not in ("static-review", "export") or not static_source.is_relative_to(input_root)
                                   or static_source.suffix.lower() not in (".fbx", ".glb") or not static_source.is_file()))):
        raise ValueError("Static comparison needs the retained original FBX or GLB in the task inputs")
    if static_source:
        import static_review
    report = {"stage": args.stage, "blenderVersion": bpy.app.version_string, "humanReview": "pending", "checks": {}, "previews": [], "technicalChecksPassed": False}
    try:
        if args.export_phase == "verify":
            if {file.name for file in output.iterdir()} != {"scene.blend", "model.glb"}:
                raise ValueError("Verification requires the prepared editable scene and GLB in their original output directory")
            saved = json.loads(state.read_text())
            if saved["config"] != config or saved["glbSha256"] != file_digest(output / "model.glb"):
                raise ValueError("The prepared export changed before verification")
            report = saved["report"]
            before = saved["baseline"]
        else:
            prepare_scene(args, output, input_root, config, report)
        if args.stage == "export":
            if args.export_phase != "verify":
                before = write_export(output, "model.glb", config.get("requiredClips"), config, geometry=report["geometry"])
                if static_source:
                    _, _, excluded = static_review.settings(config, number)
                    before["staticReviewMesh"] = static_review.audit_edges(static_review.body_meshes(meshes, excluded))
            if args.export_phase == "prepare":
                with state.open("x") as stream:
                    json.dump({"baseline": before, "report": report, "config": config,
                               "glbSha256": file_digest(output / "model.glb")}, stream, allow_nan=False)
                print("Prepared model.glb and scene.blend for verification")
                return
            report["checks"]["roundtrip"] = verify_export(output, "model.glb", before, config)
            report["previews"] = report["checks"]["roundtrip"]["previews"]
        elif args.stage != "static-review":
            # Render-only joint markers must not become geometry in the review model.
            bpy.ops.wm.open_mainfile(filepath=str(output / "scene.blend"), load_ui=False, use_scripts=False)
            report["checks"]["previewRoundtrip"] = export_roundtrip(output, "review.glb")
            report["previewModel"] = "review.glb"
        if static_source:
            if args.stage == "export":
                candidate_path = output / "model.glb"
                candidate_edges = before["staticReviewMesh"]
            else:
                candidate_path = output / "scene.blend"
                _, _, excluded = static_review.settings(config, number)
                candidate_edges = static_review.audit_edges(static_review.body_meshes(meshes, excluded))
            report["staticReview"] = static_review.compare(
                static_source, candidate_path, output, config, candidate_edges,
                meshes=meshes, number=number, world_positions=world_positions, load_source=load_source,
                used_materials=used_materials, render_reviews=render_reviews, material=material, file_digest=file_digest,
            )
        report["technicalChecksPassed"] = all(check.get("passed", True) for check in report["checks"].values())
        report["outputs"] = ["report.json"] + [file.name for file in output.iterdir() if file.is_file() and file.name != "report.json"]
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        if args.export_phase != "prepare" or "error" in report:
            (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    # Large rigs and multipart imports can fill the worker's bounded diagnostic log.
    # The full measured report is retained alongside the scene.
    print(json.dumps({"stage": args.stage, "technicalChecksPassed": report["technicalChecksPassed"], "report": "report.json"}))


if __name__ == "__main__":
    main()
