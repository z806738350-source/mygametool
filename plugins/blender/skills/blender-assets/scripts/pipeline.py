"""Repeatable Blender asset stages. Run inside Blender, never ordinary Python.

Inputs stay unchanged. Every stage writes a fresh output directory. The report
separates measured technical checks from the human review still required.
"""

import argparse
import colorsys
import json
import math
from pathlib import Path
import runpy
import struct
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector


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
    shapes = {bone.custom_shape for arm in bpy.context.scene.objects if arm.type == "ARMATURE" for bone in arm.pose.bones if bone.custom_shape}
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not obj.get("workflow_review") and obj not in shapes]


def bounds(objects=None):
    points = [obj.matrix_world @ vertex.co for obj in (objects if objects is not None else meshes()) for vertex in obj.data.vertices]
    if not points:
        raise ValueError("The scene has no mesh vertices")
    return Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)])


def geometry_report():
    low, high = bounds()
    entries = []
    for obj in meshes():
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
    return {
        "meshes": entries, "triangles": sum(obj["triangles"] for obj in entries),
        "vertices": sum(obj["vertices"] for obj in entries),
        "bounds": {"min": list(low), "max": list(high), "size": list(high - low)},
        "materials": len({slot.material.name for obj in meshes() for slot in obj.material_slots if slot.material}),
        "textures": len([image for image in bpy.data.images if image.type == "IMAGE"]),
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
    else:
        raise ValueError("Input must be an existing .blend or self-contained .glb")
    if bpy.data.libraries:
        raise ValueError("Linked Blender libraries must be made local before processing")
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file and image.filepath:
            image_path = Path(bpy.path.abspath(image.filepath)).resolve()
            if not image_path.is_relative_to(input_root):
                raise ValueError("Unpacked textures must be inside the task inputs")
    if not meshes():
        raise ValueError("Input contains no meshes")


def clean(config):
    if any(obj.type == "ARMATURE" or obj.animation_data for obj in bpy.context.scene.objects):
        raise ValueError("Clean accepts static sources; preserve an existing rig in a separate workflow")
    objects = meshes()
    if any(obj.data.shape_keys or obj.modifiers for obj in objects):
        raise ValueError("Clean requires plain static meshes; preserve shape keys or apply modifiers explicitly in a separate copy")
    # Apply world matrices before discarding imported empty parents; UVs stay on loops.
    for obj in objects:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        transform = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(transform)
    angle = math.radians(number(config.get("yawDegrees", 0), "yawDegrees", -360, 360))
    for obj in objects:
        obj.data.transform(Matrix.Rotation(angle, 4, "Z"))
    low, high = bounds(objects)
    height = number(config.get("height", high.z - low.z), "height", .001, 10000)
    if high.z - low.z < 1e-8:
        raise ValueError("Cannot normalize a mesh with zero height")
    scale = height / (high.z - low.z)
    offset = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    for obj in objects:
        obj.data.transform(Matrix.Scale(scale, 4) @ Matrix.Translation(offset))
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        distance = number(config.get("mergeDistance", .00001), "mergeDistance", 0, height / 100)
        if distance:
            bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=distance)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(obj.data)
        bm.free()
    triangles = geometry_report()["triangles"]
    target = int(number(config.get("triangleBudget", triangles), "triangleBudget", 4, 2000000))
    if config.get("decimate", False) and triangles > target:
        for obj in objects:
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new("Budget reduction", "DECIMATE")
            modifier.ratio = target / triangles
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    for obj in list(bpy.context.scene.objects):
        if obj.type == "EMPTY":
            bpy.data.objects.remove(obj, do_unlink=True)


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


def stress_check(arm, config, output):
    poses = config.get("stressPoses", [])
    baselines = {obj.name: [(edge.vertices[:], (obj.data.vertices[edge.vertices[0]].co - obj.data.vertices[edge.vertices[1]].co).length) for edge in obj.data.edges] for obj in meshes()}
    results = []
    for pose in poses:
        reset_pose(arm)
        for name, degrees in pose["rotations"].items():
            bone = arm.pose.bones.get(name)
            if not bone:
                raise ValueError(f"Unknown stress-pose bone: {name}")
            bone.rotation_mode = "XYZ"
            bone.rotation_euler = [math.radians(value) for value in vector(degrees, "stress rotation")]
        bpy.context.view_layer.update()
        worst = {"ratio": 1.0, "mesh": None, "vertices": None}
        graph = bpy.context.evaluated_depsgraph_get()
        for obj in meshes():
            evaluated = obj.evaluated_get(graph)
            for indices, original in baselines[obj.name]:
                if original < 1e-8:
                    continue
                ratio = (evaluated.data.vertices[indices[0]].co - evaluated.data.vertices[indices[1]].co).length / original
                if ratio > worst["ratio"]:
                    worst = {"ratio": ratio, "mesh": obj.name, "vertices": list(indices)}
        entry = {"name": pose["name"], "worstEdgeStretch": worst}
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
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO" if mode == "automatic" else "ARMATURE_NAME")
    deform = {bone.name for bone in arm.data.bones if bone.use_deform}
    region_counts = []
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
    report["stressPoses"] = stress_check(arm, config, output)
    report["passed"] = bool(report["stressPoses"]) and report["unweightedVertices"] == 0 and report["nonNormalizedVertices"] == 0 and all(pose["worstEdgeStretch"]["ratio"] <= config.get("maximumEdgeStretch", 2) for pose in report["stressPoses"])
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
            for name in {*pose_rotations, *swing_rotations}:
                bone = arm.pose.bones[name]
                angles = pose_rotations.get(name, Vector((0, 0, 0))) + swing_rotations.get(name, Vector((0, 0, 0))) * (math.sin(t * math.tau) if clip_name == "Walk" else 0)
                bone.rotation_mode = "XYZ"
                bone.rotation_euler = [math.radians(angle) for angle in angles]
                bone.keyframe_insert(data_path="rotation_euler", frame=frame)
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
        for index, factor in enumerate((0, .25, .5, .75), 1):
            scene.frame_set(1 + round(frames * factor))
            previews.extend(render_reviews(output, config, prefix=f"walk-{index}"))
        arm.animation_data.action = None
        reset_pose(arm)
        scene.frame_set(1)
    return {"clips": clips, "previews": previews, "passed": all(clip["passed"] for clip in clips), "note": "Two-leg -Y-forward baseline. Contact checks do not establish natural motion or clothing quality."}


def render_reviews(output, config, prefix="review"):
    low, high = bounds()
    center = (low + high) / 2
    extent = max(high - low)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.render.resolution_x = scene.render.resolution_y = int(number(config.get("previewSize", 384), "previewSize", 64, 1024))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    camera = bpy.data.objects.new("ReviewCamera", bpy.data.cameras.new("ReviewCamera"))
    bpy.context.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = extent * 1.25
    scene.camera = camera
    light = bpy.data.objects.new("ReviewLight", bpy.data.lights.new("ReviewLight", "AREA"))
    bpy.context.collection.objects.link(light)
    light.data.energy = 800
    light.data.shape = "DISK"
    light.data.size = extent * 3
    scene.world = scene.world or bpy.data.worlds.new("ReviewWorld")
    scene.world.use_nodes = True
    next(node for node in scene.world.node_tree.nodes if node.type == "BACKGROUND").inputs["Strength"].default_value = .5
    names = []
    for name, direction in (("front", Vector((0, -1, 0))), ("side", Vector((1, 0, 0)))):
        # Project landmarks in front of the silhouette; points inside opaque skin
        # would otherwise disappear exactly when reviewers need to check them.
        for obj in bpy.context.scene.objects:
            if "joint_position" in obj:
                point = Vector(obj["joint_position"])
                if name == "front":
                    point.y = low.y - extent * .05
                else:
                    point.x = high.x + extent * .05
                obj.location = point
        camera.location = center + direction * extent * 3
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        light.location = center + direction * extent * 2 + Vector((extent, 0, extent * 2))
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
        filename = prefix + "-" + name + ".png"
        scene.render.filepath = str(output / filename)
        bpy.ops.render.render(write_still=True)
        names.append(filename)
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.objects.remove(light, do_unlink=True)
    return names


def region_review(config, output):
    rules = config.get("regions", [])
    if not rules:
        return {"passed": False, "incomplete": "No explicit regions supplied; body/clothing segmentation remains unreviewed"}
    originals = [(obj, list(obj.data.materials), [poly.material_index for poly in obj.data.polygons]) for obj in meshes()]
    counts = []
    try:
        unmatched = material("Unclassified", [.25, .25, .25, 1])
        assignments = {}
        for obj in meshes():
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
        return {"regions": counts, "unclassifiedVertices": unclassified, "previews": previews, "passed": all(entry["vertices"] > 0 for entry in counts), "humanReview": "pending: colors show supplied rules, not inferred semantic correctness"}
    finally:
        for obj, materials, indices in originals:
            obj.data.materials.clear()
            for item in materials:
                obj.data.materials.append(item)
            for poly, index in zip(obj.data.polygons, indices):
                poly.material_index = index


def playback_samples():
    """Measure exported animation after importing it into an empty scene."""
    results = []
    for arm in [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]:
        if not arm.animation_data:
            continue
        entries = [(track.name, strip.action, strip.action_slot) for track in arm.animation_data.nla_tracks for strip in track.strips if strip.action]
        for track in arm.animation_data.nla_tracks:
            track.mute = True
        for name, action, slot in entries:
            arm.animation_data.action = action
            if slot:
                arm.animation_data.action_slot = slot
            start, end = action.frame_range
            samples = []
            for factor in (0, .25, .5, .75, 1):
                bpy.context.scene.frame_set(int(start + (end - start) * factor))
                graph = bpy.context.evaluated_depsgraph_get()
                points = []
                for obj in meshes():
                    evaluated = obj.evaluated_get(graph)
                    vertices = evaluated.data.vertices
                    step = max(1, len(vertices) // 128)
                    points.extend(evaluated.matrix_world @ vertices[index].co for index in range(0, len(vertices), step))
                samples.append(points)
            displacement = max(((point - samples[0][index]).length for sample in samples[1:] for index, point in enumerate(sample)), default=0)
            results.append({"name": name, "sampledVertexDisplacement": displacement, "passed": displacement > 1e-6})
        arm.animation_data.action = None
    return results


def export_roundtrip(output):
    before = geometry_report()
    arms = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    expected_bones = {bone.name for arm in arms for bone in arm.data.bones if bone.use_deform}
    expected_clips = {strip.action.name for arm in arms if arm.animation_data for track in arm.animation_data.nla_tracks for strip in track.strips if strip.action}
    for arm in arms:
        if arm.animation_data and arm.animation_data.action:
            expected_clips.add(arm.animation_data.action.name)
        for track in arm.animation_data.nla_tracks if arm.animation_data else []:
            track.mute = False
    original_argv = sys.argv
    try:
        sys.argv = ["export_glb.py", "--", "--output", str(output / "model.glb")]
        runpy.run_path(str(Path(__file__).with_name("export_glb.py")), run_name="__main__")
    finally:
        sys.argv = original_argv
    raw = (output / "model.glb").read_bytes()
    json_length, json_type = struct.unpack_from("<II", raw, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("Export has no glTF JSON chunk")
    document = json.loads(raw[20:20 + json_length])
    clip_names = {animation.get("name", "") for animation in document.get("animations", [])}
    joint_names = {document["nodes"][index].get("name", "") for skin in document.get("skins", []) for index in skin["joints"]}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output / "model.glb"))
    after = geometry_report()
    playback = playback_samples()
    height_error = abs(before["bounds"]["size"][2] - after["bounds"]["size"][2])
    return {"trianglesBefore": before["triangles"], "trianglesAfter": after["triangles"], "heightError": height_error, "expectedBones": sorted(expected_bones), "exportedJoints": sorted(joint_names), "expectedClips": sorted(expected_clips), "exportedClips": sorted(clip_names), "playback": playback, "passed": before["triangles"] == after["triangles"] and height_error < .001 and expected_bones.issubset(joint_names) and expected_clips == clip_names and (not expected_clips or len(playback) == len(expected_clips) and all(clip["passed"] for clip in playback)), "runtimeReview": "pending: load model.glb and play every clip in the target project"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, choices=("parts", "clean", "joints", "rig", "animate", "export"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--input")
    parser.add_argument("--input-dir", default=".")
    parser.add_argument("--output-dir", "--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    output = Path(args.output_dir).resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError("A stage needs a new or empty output directory")
    output.mkdir(parents=True, exist_ok=True)
    input_root = Path(args.input_dir).resolve()
    config_path = Path(args.config).resolve()
    if not config_path.is_relative_to(input_root):
        raise ValueError("Config must be inside the task inputs")
    config = json.loads(config_path.read_text())
    report = {"stage": args.stage, "blenderVersion": bpy.app.version_string, "humanReview": "pending", "checks": {}, "previews": [], "technicalChecksPassed": False}
    try:
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
        if args.stage == "parts":
            build_parts(config)
        elif args.stage == "clean":
            clean(config)
        elif args.stage == "joints":
            report["checks"]["skeleton"] = {"joints": len(skeleton(config)[0]), "bones": len(skeleton(config)[1])}
            report["checks"]["regions"] = region_review(config, output)
        elif args.stage == "rig":
            report["checks"]["rig"] = rig(config, output)
        elif args.stage == "animate":
            report["checks"]["animation"] = animate(config, output)
        report["geometry"] = geometry_report()
        topology = {key: sum(mesh[key] for mesh in report["geometry"]["meshes"]) for key in ("boundaryEdges", "nonManifoldInteriorEdges", "degenerateFaces")}
        topology["passed"] = topology["nonManifoldInteriorEdges"] <= config.get("allowedNonManifoldInteriorEdges", 0) and topology["degenerateFaces"] <= config.get("allowedDegenerateFaces", 0)
        if topology["boundaryEdges"]:
            topology["review"] = "Open borders or split shading/UV seams need visual review; they are not automatically holes"
        report["checks"]["topology"] = topology
        if "triangleBudget" in config:
            report["checks"]["triangleBudget"] = {"limit": config["triangleBudget"], "actual": report["geometry"]["triangles"], "passed": report["geometry"]["triangles"] <= config["triangleBudget"]}
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), compress=False)
        if args.stage == "joints":
            joint_markers(config)
        if config.get("previews", True) and args.stage in ("parts", "clean", "joints", "rig"):
            report["previews"] = render_reviews(output, config)
        if args.stage == "export":
            report["checks"]["roundtrip"] = export_roundtrip(output)
        report["technicalChecksPassed"] = all(check.get("passed", True) for check in report["checks"].values())
        report["outputs"] = ["report.json"] + [file.name for file in output.iterdir() if file.is_file() and file.name != "report.json"]
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report, allow_nan=False))


if __name__ == "__main__":
    main()
