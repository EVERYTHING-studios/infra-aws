"""Blender-side conversion script (runs inside `blender --background --python`).

Reads a JSON spec (path passed after `--`):
    { "input": "/tmp/model.glb", "out_dir": "/tmp/out", "name": "<job_id>",
      "formats": ["glb", "fbx", "obj", "usdz"], "thumbnail": true }

Imports the GLB, exports the requested formats, and renders a 512x512
thumbnail with a neutral three-point-ish light rig.
"""

import json
import math
import sys

import bpy
from mathutils import Vector

spec_path = sys.argv[sys.argv.index("--") + 1]
with open(spec_path) as f:
    spec = json.load(f)

out_dir = spec["out_dir"].rstrip("/")
name = spec["name"]

# Clean scene, then import the model.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=spec["input"])

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("imported GLB contains no meshes")

for fmt in spec.get("formats", []):
    out = f"{out_dir}/{name}.{fmt}"
    if fmt == "glb":
        continue  # authoritative GLB comes straight from inference
    if fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=out, path_mode="COPY", embed_textures=True)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=out, export_materials=True)
    elif fmt == "usdz":
        # Blender's USD exporter packages .usdz when the extension asks for it.
        bpy.ops.wm.usd_export(filepath=out, export_textures=True)
    else:
        print(f"warning: unknown format {fmt}", file=sys.stderr)

if spec.get("thumbnail"):
    # Frame the model with a camera on a diagonal, light it, render.
    center = sum((o.matrix_world.translation for o in meshes), Vector()) / len(meshes)
    radius = max(
        max(o.dimensions) if max(o.dimensions) > 0 else 1.0 for o in meshes
    )

    cam_data = bpy.data.cameras.new("ThumbCam")
    cam = bpy.data.objects.new("ThumbCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center + Vector((radius * 2.2, -radius * 2.2, radius * 1.6))
    direction = center - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    key = bpy.data.lights.new("Key", type="SUN")
    key.energy = 3.0
    key_obj = bpy.data.objects.new("Key", key)
    key_obj.rotation_euler = (math.radians(45), 0, math.radians(45))
    bpy.context.scene.collection.objects.link(key_obj)

    fill = bpy.data.lights.new("Fill", type="SUN")
    fill.energy = 1.0
    fill_obj = bpy.data.objects.new("Fill", fill)
    fill_obj.rotation_euler = (math.radians(60), 0, math.radians(-120))
    bpy.context.scene.collection.objects.link(fill_obj)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 85
    scene.render.filepath = f"{out_dir}/{name}-thumbnail.jpg"
    bpy.ops.render.render(write_still=True)
