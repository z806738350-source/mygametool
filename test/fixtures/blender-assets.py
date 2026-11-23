"""Editable textured, hierarchical and animated assets for real Blender export tests."""

from math import pi
from pathlib import Path
import sys

import bpy


bpy.ops.wm.read_factory_settings(use_empty=True)
source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def move_to(obj, target):
    for parent in list(obj.users_collection):
        parent.objects.unlink(obj)
    target.objects.link(obj)


static = collection("StaticAsset")
geometry = bpy.data.collections.new("Geometry")
static.children.link(geometry)
root = bpy.data.objects.new("AssetRoot", None)
static.objects.link(root)
root.location = (3, -2, 1)
root.rotation_euler.z = pi / 2
root.scale = (0.5, 1.5, 2)
bpy.ops.mesh.primitive_cube_add()
prop = bpy.context.object
prop.name = "TexturedProp"
move_to(prop, geometry)
prop.parent = root
prop.location = (1, 0, 0)

image = bpy.data.images.new("Checker", width=4, height=4)
image.pixels = [
    channel
    for y in range(4)
    for x in range(4)
    for channel in ((0.9, 0.2, 0.1, 1) if (x + y) % 2 else (0.1, 0.6, 0.9, 1))
]
image.pack()
material = bpy.data.materials.new("CheckerMaterial")
material.use_nodes = True
shader = next(
    node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"
)
shader.inputs["Metallic"].default_value = 0.2
shader.inputs["Roughness"].default_value = 0.35
shader.inputs["Alpha"].default_value = 0.5
material.surface_render_method = "DITHERED"
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
prop.data.materials.append(material)

bpy.ops.mesh.primitive_cube_add(location=(100, 0, 0))
hidden = bpy.context.object
hidden.name = "HiddenProp"
move_to(hidden, static)
hidden.hide_render = True
# Render-disabled nested backup, still visible in the viewport. A naive export
# would include its three open edges or count them against a watertight brief.
backups = bpy.data.collections.new("Backups")
geometry.children.link(backups)
backups.hide_render = True
backup_mesh = bpy.data.meshes.new("BackupTriangle")
backup_mesh.from_pydata([(40, 0, 0), (41, 0, 0), (40, 1, 0)], [], [(0, 1, 2)])
backups.objects.link(bpy.data.objects.new("HiddenCollectionHelper", backup_mesh))
# The same object remains eligible through its visible Geometry collection.
backups.objects.link(prop)
static.objects.link(bpy.data.objects.new(
    "PresentationCamera", bpy.data.cameras.new("PresentationCamera")
))
static.objects.link(bpy.data.objects.new(
    "PresentationLight", bpy.data.lights.new("PresentationLight", "AREA")
))

animated = collection("AnimatedAsset")
armature = bpy.data.armatures.new("PropSkeleton")
rig = bpy.data.objects.new("PropRig", armature)
animated.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
base = armature.edit_bones.new("Base")
base.head, base.tail = (0, 0, 0), (0, 0, 1)
tip = armature.edit_bones.new("Tip")
tip.head, tip.tail, tip.parent = (0, 0, 1), (0, 0, 2), base
bpy.ops.object.mode_set(mode="OBJECT")

bpy.ops.mesh.primitive_cube_add()
skinned = bpy.context.object
skinned.name = "AnimatedProp"
move_to(skinned, animated)
skinned.parent = rig
for name, upper in [("Base", False), ("Tip", True)]:
    group = skinned.vertex_groups.new(name=name)
    group.add(
        [vertex.index for vertex in skinned.data.vertices if (vertex.co.z > 0) == upper],
        1,
        "REPLACE",
    )
modifier = skinned.modifiers.new("Skin", "ARMATURE")
modifier.object = rig
skinned.shape_key_add(name="Basis")
stretch = skinned.shape_key_add(name="Stretch")
for vertex in stretch.data:
    vertex.co.z *= 1.25
bone = rig.pose.bones["Tip"]
bone.rotation_mode = "XYZ"
for frame, amount in [(1, 0), (12, 1), (24, 0)]:
    bone.rotation_euler.y = amount * 0.6
    bone.keyframe_insert(data_path="rotation_euler", frame=frame)
    stretch.value = amount
    stretch.keyframe_insert(data_path="value", frame=frame)
rig.animation_data.action.name = "Sway"
skinned.data.shape_keys.animation_data.action.name = "Stretch"
mechanical = collection("Mechanism")
hinge = bpy.data.objects.new("Hinge", None)
mechanical.objects.link(hinge)
# Clear the other props in the three-quarter camera so the silhouette exposes playback.
hinge.location = (9, 0, 4)
bpy.ops.mesh.primitive_cube_add(size=0.5, location=(1.5, 0, 0))
lever = bpy.context.object
lever.name = "Lever"
move_to(lever, mechanical)
lever.parent = hinge
# A short excursion between regular QA samples. Only the non-mesh parent is keyed.
for frame, angle in [(1, 0), (2, 0), (3, .7), (4, 0), (81, 0)]:
    hinge.rotation_euler.y = -angle
    hinge.keyframe_insert(data_path="rotation_euler", frame=frame)
hinge.animation_data.action.name = "Trigger"
bpy.context.scene.frame_end = 24
bpy.context.scene.render.fps = 24
bpy.context.scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(source))
if "--stalled" in sys.argv:
    for frame in (1, 10, 24):
        lever.keyframe_insert(data_path="location", frame=frame)
    lever.animation_data.action.name = "Jammed"
    bpy.ops.wm.save_as_mainfile(filepath=str(source.with_name("stalled.blend")))
