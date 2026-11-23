"""Export visible Blender objects as GLB without modifying the source file."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

import bpy


def export_objects(collection=None, *, include_review=False):
    """Select objects on a visible path inside the requested collection in the active view layer."""
    visible = set()
    pending = [(bpy.context.view_layer.layer_collection, collection is None)]
    while pending:
        branch, within_scope = pending.pop()
        if branch.exclude or branch.hide_viewport or branch.collection.hide_viewport or branch.collection.hide_render:
            continue
        within_scope = within_scope or branch.collection == collection
        if within_scope:
            visible.update(branch.collection.objects)
        pending.extend((child, within_scope) for child in branch.children)
    shapes = {bone.custom_shape for arm in bpy.context.scene.objects if arm.type == "ARMATURE"
              for bone in arm.pose.bones if bone.custom_shape}
    return [obj for obj in bpy.context.scene.objects if obj in visible and obj.visible_get() and not obj.hide_render
            and obj.type not in {"LIGHT", "CAMERA"} and obj not in shapes and (include_review or not obj.get("workflow_review"))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--collection")
    parser.add_argument("--apply-modifiers", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    options = parser.parse_args(arguments)
    output = Path(options.output).expanduser().resolve()
    if output.suffix.lower() != ".glb":
        raise ValueError("Output must have a .glb extension")
    if output.exists() and not options.overwrite:
        raise FileExistsError(f"Output exists; pass --overwrite to replace it: {output}")

    collection = None
    if options.collection:
        collection = bpy.data.collections.get(options.collection)
        if collection is None:
            raise ValueError(f"Collection not found: {options.collection}")
    objects = export_objects(collection)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    geometry = [
        obj.evaluated_get(depsgraph) if options.apply_modifiers else obj
        for obj in meshes
    ]
    if not any(len(obj.data.polygons) for obj in geometry):
        raise ValueError("Export scope contains no visible mesh faces")

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".blender-export-", dir=output.parent) as directory:
        temporary = Path(directory) / "asset.glb"
        result = bpy.ops.export_scene.gltf(
            filepath=str(temporary),
            export_format="GLB",
            use_selection=True,
            export_cameras=False,
            export_lights=False,
            export_apply=options.apply_modifiers,
            export_anim_slide_to_zero=True,
        )
        if "FINISHED" not in result or not temporary.is_file():
            raise RuntimeError("Blender did not finish the GLB export")
        # A concurrent export must not replace a file without explicit overwrite.
        if options.overwrite:
            os.replace(temporary, output)
        else:
            os.link(temporary, output)

    print(json.dumps({
        "output": str(output),
        "bytes": output.stat().st_size,
        "meshes": [obj.name for obj in meshes],
        "collection": options.collection,
        "blender_version": bpy.app.version_string,
    }))


if __name__ == "__main__":
    main()
