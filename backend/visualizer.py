"""Prepare a solved assembly for an isolated, optional Blender process."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading

from backend.assembly.assembly import prepare
from backend.cad_service import atomic_write
from backend.geometry.engine import build_progress

_render_slot = threading.Lock()


def finite(value, low, high):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Szenenparameter außerhalb des gültigen Bereichs")
    return value


def vector(value):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("Drei Koordinaten erwartet")
    return [finite(v, -1e9, 1e9) for v in value]


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("Ungültige Material- oder Lichtfarbe")
    return value


def prepare_scene(doc, lock):
    camera = next((c for c in doc["cameras"] if c["id"] == doc["activeCamera"]), None)
    if not camera:
        raise ValueError("Aktive Kamera fehlt")
    view = dict(center=vector(camera["center"]), yaw=finite(camera["yaw"], -1e6, 1e6),
                pitch=finite(camera["pitch"], -1.57, 1.57), width=finite(camera["width"], .01, 1e9))
    if len(doc["lights"]) > 8:
        raise ValueError("Maximal acht Flächenlichter")
    settings = doc.get("renderSettings", {})
    samples = settings.get("samples", 24)
    width = settings.get("width", 1280)
    mat_enabled = settings.get("mat", True)
    if type(samples) is not int or not 1 <= samples <= 1024:
        raise ValueError("Sampleanzahl muss zwischen 1 und 1024 liegen.")
    if type(width) is not int or width not in (640, 1280, 1920, 3840) or type(mat_enabled) is not bool:
        raise ValueError("Ungültige Rendereinstellungen.")
    lights = []
    for light in doc["lights"]:
        kind = light.get("type", "area")
        if kind not in ("area", "point"):
            raise ValueError("Unbekannter Lichttyp")
        entry = dict(type=kind, position=vector(light["position"]), color=color(light["color"]),
                     power=finite(light["power"], 0, 1e7), size=finite(light["size"], .1, 1e7))
        if kind == "area":
            entry["target"] = vector(light["target"])
        lights.append(entry)
    with lock:
        result = prepare(doc["model"], include_mesh=True)
    objects = []
    meshes = {}
    for item in result["document"]["instances"]:
        key = item["part"]
        if key not in meshes:
            mesh = result["parts"][key]["mesh"]
            meshes[key] = {k: mesh[k] for k in ("vertices", "triangles")}
        mat = doc["overrides"].get(item["id"], doc["materials"].get(key))
        if mat is None:
            mat = dict(color=item.get("color") or "#bfc9ce", roughness=.5, metallic=0)
        objects.append(dict(part=key, transform=result["transforms"][item["id"]],
                            color=color(mat["color"]), roughness=finite(mat["roughness"], 0, 1),
                            metallic=finite(mat["metallic"], 0, 1),
                            transmission=finite(mat.get("transmission", 0), 0, 1)))
    if not objects:
        raise ValueError("Baugruppe ist leer")
    return dict(camera=view, lights=lights, meshes=meshes, objects=objects,
                settings=dict(samples=samples, width=width, mat=mat_enabled))


def blender_path(directory):
    try:
        return (Path(directory) / "blender-path.txt").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def checked_blender(value):
    path = Path(value)
    expected = "blender.exe" if os.name == "nt" else "blender"
    if not path.is_absolute() or path.name.lower() != expected or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Bitte den vollständigen Pfad zur ausführbaren Datei " + expected + " angeben.")
    return str(path)


def configure_blender(directory, payload):
    if payload == {}:
        return {"path": blender_path(directory)}
    if payload == {"browse": True}:
        # Tk owns its event loop on the main thread of a separate process.
        picker = """import json, tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
print(json.dumps(filedialog.askopenfilename(parent=root, title="Blender auswählen",
    filetypes=[("Blender", "blender.exe" if root.tk.call("tk", "windowingsystem") == "win32" else "blender")])) )
root.destroy()
"""
        try:
            result = subprocess.run([sys.executable, "-I", "-c", picker], capture_output=True,
                                    check=True, timeout=300)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError("Dateiauswahl nicht verfügbar. Bitte den Pfad direkt eingeben.") from exc
        return {"selection": json.loads(result.stdout)}
    if not isinstance(payload, dict) or set(payload) != {"path"} or not isinstance(payload["path"], str):
        raise ValueError("Ungültige Pfadangabe.")
    value = payload["path"].strip().strip('"')
    if value:
        value = checked_blender(value)
    atomic_write(Path(directory) / "blender-path.txt", value.encode("utf-8"))
    return {"path": value}


_sample_status = re.compile(r"\bsamples?\s+(\d+)\s*/\s*(\d+)", re.I)
_remaining_time = re.compile(r"\bRemaining:\s*([\d:.]+)", re.I)


def render_status(line):
    match = _sample_status.search(line)
    if match:
        sample, total = map(int, match.groups())
        if 0 <= sample <= total and total:
            remaining = _remaining_time.search(line)
            return {"stage": "sampling", "sample": sample, "total": total,
                    "remaining": remaining[1] if remaining else None}
    if " | Finished" in line or "Saved:" in line:
        return {"stage": "saving"}
    return None


def run_blender(command, report):
    tail = ""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace") as process:
        def read_output():
            nonlocal tail
            for line in process.stdout:
                tail = (tail + line)[-1000:]
                if report and (stage := render_status(line)):
                    report(stage)

        reader = threading.Thread(target=read_output)
        reader.start()
        try:
            process.wait(timeout=600)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            reader.join()
        if process.returncode:
            raise ValueError("Cycles-Render fehlgeschlagen. " + tail.strip()[-400:])


def render_png(doc, lock, directory=None):
    configured = blender_path(directory) if directory is not None else ""
    blender = checked_blender(configured) if configured else shutil.which(os.environ.get("METRICCAD_BLENDER") or "blender")
    if not blender:
        raise ValueError("Blender fehlt. Unter Rendern → Blender-Pfad die Programmdatei auswählen.")
    if not _render_slot.acquire(blocking=False):
        raise ValueError("Ein Renderauftrag läuft bereits.")
    try:
        scene = prepare_scene(doc, lock)
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder, "scene.json")
            output = Path(folder, "render.png")
            source.write_text(json.dumps(scene, allow_nan=False), encoding="utf-8")
            script = Path(__file__).with_name("visualizer_blender.py")
            command = [blender, "-b", "--factory-startup", "--disable-autoexec", "-t", "4",
                       "--python-exit-code", "1", "--python", str(script), "--", str(source), str(output)]
            report = build_progress.get()
            if report:
                report({"stage": "starting"})
            run_blender(command, report)
            if not output.is_file():
                raise ValueError("Blender hat kein PNG erzeugt.")
            return output.read_bytes()
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Renderzeit von zehn Minuten überschritten.") from exc
    finally:
        _render_slot.release()
