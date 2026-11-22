"""Runs inside Blender. CAD coordinates are in mm, Blender coordinates in m."""
import json
from math import cos, pi, sin
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector


def linear_color(hex_color):
    srgb = [int(hex_color[k:k+2], 16) / 255 for k in (1, 3, 5)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in srgb) + (1,)


def point_at(obj, target):
    direction = target - obj.location
    if direction.length:
        obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


source, output = sys.argv[-2:]
data = json.loads(Path(source).read_text(encoding="utf-8"))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
settings = data["settings"]
scene.cycles.samples = settings["samples"]
scene.cycles.use_denoising = False
scene.world = bpy.data.worlds.new("Studio")
scene.world.color = (.18, .18, .18)
meshes = {}
for key, geometry in data["meshes"].items():
    mesh = bpy.data.meshes.new(key)
    mesh.from_pydata([Vector(p) * .001 for p in geometry["vertices"]], [], geometry["triangles"])
    mesh.update()
    mesh.materials.append(None)
    meshes[key] = mesh
materials = {}
for item in data["objects"]:
    obj = bpy.data.objects.new(item["part"], meshes[item["part"]])
    scene.collection.objects.link(obj)
    transform = Matrix(item["transform"])
    transform.translation *= .001
    obj.matrix_world = transform
    key = (item["color"], item["roughness"], item["metallic"], item["transmission"])
    if key not in materials:
        material = bpy.data.materials.new(key[0])
        material.use_nodes = True
        inputs = material.node_tree.nodes.get("Principled BSDF").inputs
        inputs["Base Color"].default_value = linear_color(key[0])
        inputs["Roughness"].default_value = key[1]
        inputs["Metallic"].default_value = key[2]
        inputs["Transmission Weight"].default_value = key[3]
        materials[key] = material
    obj.material_slots[0].link = 'OBJECT'
    obj.material_slots[0].material = materials[key]
for light in data["lights"]:
    point = light["type"] == "point"
    lamp = bpy.data.lights.new("Punktlicht" if point else "Flächenlicht", 'POINT' if point else 'AREA')
    lamp.energy = light["power"]
    if point:
        lamp.shadow_soft_size = light["size"] * .001
    else:
        lamp.size = light["size"] * .001
    lamp.color = linear_color(light["color"])[:3]
    obj = bpy.data.objects.new(lamp.name, lamp)
    scene.collection.objects.link(obj)
    obj.location = Vector(light["position"]) * .001
    if not point:
        point_at(obj, Vector(light["target"]) * .001)
view = data["camera"]
cam = bpy.data.cameras.new("Kamera")
cam.type = 'ORTHO'
cam.ortho_scale = view["width"] * .001
target = Vector(view["center"]) * .001
yaw, pitch = view["yaw"], view["pitch"]
direction = Vector((cos(yaw)*cos(pitch), sin(yaw)*cos(pitch), sin(pitch)))
# Update transforms and bounds after linking objects.
bpy.context.view_layer.update()
if data["environment"]:
    # Use transformed vertices so a rotated part touches the floor at its actual lowest point.
    low = Vector((float("inf"),) * 3)
    high = -low
    for part in scene.objects:
        if part.type == 'MESH':
            for vertex in part.data.vertices:
                pos = part.matrix_world @ vertex.co
                for axis in range(3):
                    low[axis] = min(low[axis], pos[axis])
                    high[axis] = max(high[axis], pos[axis])
    diameter = max(.0001, (high - low).length)
    center = (low + high) / 2
    floor_z = low.z - diameter * .00002
    if settings["environment"] == "room":
        # A wide window on the open side fills the shadow cast by the side wall.
        window = bpy.data.lights.new("Weiches Fensterlicht · Raumecke", 'AREA')
        window.shape = 'DISK'
        window.size = 2.1 * diameter
        window.energy = 48 * diameter**2
        window.color = (.96, .98, 1.0)
        source_light = bpy.data.objects.new(window.name, window)
        scene.collection.objects.link(source_light)
        source_light.location = center + Vector((.8, -1.35, .9))*diameter
        point_at(source_light, center)
    for surface in data["environment"]:
        key = surface["anchor"]
        if (key == "left" and cos(yaw) < 0) or (key == "back" and sin(yaw) > 0):
            continue
        mesh = bpy.data.meshes.new(key)
        mesh.from_pydata(surface["vertices"], [], surface["faces"])
        layer = mesh.color_attributes.new(name="Farbe", type='FLOAT_COLOR', domain='POINT')
        for entry, rgb in zip(layer.data, surface["colors"]):
            entry.color = linear_color("#%02x%02x%02x" % tuple(rgb))
        obj = bpy.data.objects.new(key, mesh)
        scene.collection.objects.link(obj)
        obj.location = (low.x - .14*diameter if key == "left" else center.x,
                        high.y + .09*diameter if key in ("left", "back") else center.y, floor_z)
        obj.scale = (diameter,) * 3
        obj.rotation_euler.z = yaw + pi/2 if key == "studio" else 0
        mat = bpy.data.materials.new(key)
        mat.use_nodes = True
        mesh.materials.append(mat)
        nodes, link = mat.node_tree.nodes, mat.node_tree.links.new
        bsdf = nodes.get("Principled BSDF")
        bsdf.inputs["Roughness"].default_value = .82
        colors = nodes.new("ShaderNodeVertexColor")
        colors.layer_name = "Farbe"
        if key != "oak":
            link(colors.outputs["Color"], bsdf.inputs["Base Color"])
            continue
        # Object coordinates stay in assembly-diagonal units, matching the viewport.
        coords = nodes.new("ShaderNodeTexCoord").outputs["Object"]
        brick = nodes.new("ShaderNodeTexBrick")
        link(coords, brick.inputs["Vector"])
        for name, value in [("Scale",1),("Brick Width",.5),("Row Height",.0625),
                            ("Mortar Size",.00045),("Mortar Smooth",.8)]:
            brick.inputs[name].default_value = value
        for name, value in [("Color1","#ceb28b"),("Color2","#ba976e"),("Mortar","#927953")]:
            brick.inputs[name].default_value = linear_color(value)
        stretch = nodes.new("ShaderNodeVectorMath")
        stretch.operation = 'MULTIPLY'
        link(coords, stretch.inputs[0])
        stretch.inputs[1].default_value = (5,240,1)
        grain = nodes.new("ShaderNodeTexNoise")
        link(stretch.outputs[0], grain.inputs["Vector"])
        grain.inputs["Scale"].default_value = 1
        mix = nodes.new("ShaderNodeMixRGB")
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = .22
        link(brick.outputs["Color"], mix.inputs[1])
        link(grain.outputs["Fac"], mix.inputs[2])
        link(mix.outputs[0], bsdf.inputs["Base Color"])
    bpy.context.view_layer.update()
depth = max((obj.matrix_world @ Vector(corner) - target).length for obj in scene.objects
            if obj.type == 'MESH' for corner in obj.bound_box) + .1
obj = bpy.data.objects.new("Kamera", cam)
scene.collection.objects.link(obj)
obj.location = target + direction * (depth * 2)
point_at(obj, target)
cam.clip_start, cam.clip_end = .00001, depth * 4
scene.camera = obj
scene.render.resolution_x, scene.render.resolution_y = settings["width"], settings["width"] * 9 // 16
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = output
bpy.ops.render.render(write_still=True)
