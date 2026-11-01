"""Deterministic dimension placement shared by MCP layout and PNG previews.

Only presentation coordinates are changed. Existing/manual positions are kept
unless force=True. This module never invents dimensional design intent.
"""
from __future__ import annotations

import copy
import math
import numpy as np
from PIL import ImageFont
import sketches


def font(size=14):
    for name in ("DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def label_text(d):
    prefix = {"diameter": "Ø ", "radius": "R "}.get(d["kind"], "")
    return prefix + f'{d["value"]:.3f}'.rstrip("0").rstrip(".") + ("°" if d["kind"] == "angle" else "")


def geometries(f):
    if f.get("shape") == "multi":
        return f["geometry"]
    return [{"id": "legacy", "type": f["shape"], **{k: f[k] for k in ("x", "y", "a", "b") if k in f}, "angle": 0}]


def reference(ref, f, support):
    ref = copy.deepcopy(ref)
    if f.get("shape") != "multi" and ref.get("kind") in ("point", "edge", "circle") and not ref.get("external"):
        ref.setdefault("element", "legacy")
    return sketches.geometry_ref(ref, geometries(f), support)


def midpoint(ref, f, support):
    kind, value = reference(ref, f, support)
    if kind == "point":
        return np.array(value, dtype=float)
    if kind == "line":
        return (np.array(value[0]) + np.array(value[1])) / 2
    return np.array([value["x"], value["y"]])


def profile_segments(f):
    result = []
    for g in geometries(f):
        typ = g["type"]
        if typ in ("rect", "polyline"):
            pairs = sketches.segments(g).values()
        else:
            count = 96
            if typ in ("circle", "arc"):
                start, sweep = (0, 2 * math.pi) if typ == "circle" else (g["start"], g["sweep"])
                points = [sketches.arc_point(g, start + sweep * i / count) for i in range(count + 1)]
            elif typ == "ellipse":
                points = [sketches.ellipse_point(g, g["start"] + g["sweep"] * i / count) for i in range(count + 1)]
            else:
                points = [sketches.bezier_point(g, i / count) for i in range(count + 1)]
            pairs = zip(points, points[1:])
        result.extend((np.array(a), np.array(b), bool(g.get("construction"))) for a, b in pairs)
    return result


def bounds_for(f, support):
    points = [p for a, b, _ in profile_segments(f) for p in (a, b)]
    # Include the support outline for edge-based dimensions, but not the default
    # +/-50 bounds of an empty origin plane.
    points.extend(np.array(p) for edge in support.get("edges", []) for p in edge)
    if not points:
        return [-20, 20, -20, 20]
    return [float(min(p[0] for p in points)), float(max(p[0] for p in points)),
            float(min(p[1] for p in points)), float(max(p[1] for p in points))]


def dimension_geometry(d, f, support, position=None):
    """Return world-space label, line segments and arrow endpoints.

    Matches the existing browser's choice of label anchor (e.g. linear labels
    stay centred between measured points even when position.x is different).
    """
    p = np.array(position if position is not None else d["position"], dtype=float)
    kind = d["kind"]
    segments, arrows = [], []
    if kind in ("diameter", "radius"):
        g = next(g for g in geometries(f) if g["id"] == d.get("element", "legacy"))
        c = np.array([g["x"], g["y"]]); v = p - c
        angle = math.atan2(v[1], v[0])
        if kind == "radius" and g["type"] == "arc" and not sketches.arc_contains(g, angle):
            angle = g["start"] + g["sweep"] / 2
        u = np.array([math.cos(angle), math.sin(angle)])
        b = c + u * g["a"] / 2
        a = c if kind == "radius" else c - u * g["a"] / 2
        segments = [(a, b), (b, p)]
        arrows = [(b, a)] if kind == "radius" else [(a, b), (b, a)]
        return {"label": p, "segments": segments, "arrows": arrows}
    if kind == "angle":
        _, first = reference(d["first"], f, support)
        _, second = reference(d["second"], f, support)
        a, b = map(np.array, first); c, e = map(np.array, second)
        u = sketches.direction(first) * d.get("flipFirst", 1)
        v = sketches.direction(second) * d.get("flipSecond", 1)
        matrix = np.column_stack((b-a, -(e-c)))
        center = a + (b-a)*np.linalg.solve(matrix, c-a)[0] if abs(np.linalg.det(matrix)) > 1e-9 else (a+c)/2
        radius = max(3., float(np.linalg.norm(p-center)))
        angle = math.atan2(u[0]*v[1]-u[1]*v[0], float(u@v))
        start = math.atan2(u[1], u[0])
        points = [center + radius*np.array([math.cos(start+angle*i/32), math.sin(start+angle*i/32)]) for i in range(33)]
        segments = list(zip(points, points[1:])) + [(center, points[0]), (center, points[-1])]
        return {"label": center + radius*np.array([math.cos(start+angle/2), math.sin(start+angle/2)]),
                "segments": segments, "arrows": [(points[0], points[2]), (points[-1], points[-3])]}
    if kind == "length":
        _, line = reference(d["first"], f, support)
        a, b = map(np.array, line)
    else:
        a = midpoint(d["first"], f, support); b = midpoint(d["second"], f, support)
    if kind == "linear":
        for ref, this, other in [(d["first"], a, b), (d["second"], b, a)]:
            if ref["kind"] == "axis":
                this[1 if ref["role"] == "vertical" else 0] = other[1 if ref["role"] == "vertical" else 0]
        if d["axis"] == "x":
            aa, bb = np.array([a[0], p[1]]), np.array([b[0], p[1]])
        else:
            aa, bb = np.array([p[0], a[1]]), np.array([p[0], b[1]])
    else:
        if kind == "distance":
            ta, va = reference(d["first"], f, support)
            tb, vb = reference(d["second"], f, support)
            if ta == "line" or tb == "line":
                line = vb if tb == "line" else va
                a = midpoint(d["first"] if tb == "line" else d["second"], f, support)
                x, y = map(np.array, line); v = y-x
                b = x + v*float((a-x)@v)/float(v@v)
        v = b-a; normal = np.array([-v[1], v[0]]) / max(float(np.linalg.norm(v)), 1e-12)
        offset = float((p-a)@normal); aa, bb = a+normal*offset, b+normal*offset
    segments = [(a, aa), (b, bb), (aa, bb)]
    return {"label": (aa+bb)/2, "segments": segments, "arrows": [(aa, bb), (bb, aa)]}


def rectangle(label, text, scale):
    box = font().getbbox(text)
    w, h = (box[2]-box[0]+20)/scale, 28/scale
    return (float(label[0]-w/2), float(label[1]-h/2), float(label[0]+w/2), float(label[1]+h/2))


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def segment_hits_box(a, b, box):
    # Liang-Barsky clipping, including short segments and boundary contacts.
    d = b-a; low, high = 0., 1.
    for axis in (0, 1):
        if abs(d[axis]) < 1e-12:
            if a[axis] < box[axis] or a[axis] > box[axis+2]: return False
        else:
            x, y = sorted(((box[axis]-a[axis])/d[axis], (box[axis+2]-a[axis])/d[axis]))
            low, high = max(low, x), min(high, y)
            if low > high: return False
    return True


def arrange(f, support, force=False):
    ds = f.get("dimensions", [])
    box = bounds_for(f, support)
    cx, cy = (box[0]+box[1])/2, (box[2]+box[3])/2
    span = max(10., box[1]-box[0], box[3]-box[2])
    gap = max(3., span*.075)
    scale = min(800/max(10., box[1]-box[0]+8*gap), 520/max(10., box[3]-box[2]+8*gap))
    geometry = [(a,b) for a,b,_ in profile_segments(f)]
    geometry += [(np.array(a),np.array(b)) for edge in support.get("edges", []) for a,b in zip(edge,edge[1:])]
    occupied, placed_lines, changed = [], [], []
    def manual(d):
        info = d.get("layout", {})
        # Also detect hand edits made by older versions of the browser.
        moved = info.get("last_position") is not None and info["last_position"] != d.get("position")
        return not force and (info.get("mode") != "auto" or moved)
    fixed = [d for d in ds if manual(d)]
    automatic = [d for d in ds if not manual(d)]
    for d in fixed:
        g = dimension_geometry(d, f, support)
        occupied.append(rectangle(g["label"], label_text(d), scale)); placed_lines.extend(g["segments"])
    # Smaller dimensions sit near the profile, overall dimensions farther out.
    automatic.sort(key=lambda d: (d["kind"] in ("diameter", "radius", "angle"), d["value"], d["id"]))
    for d in automatic:
        candidates = []
        if d["kind"] == "linear":
            a = midpoint(d["first"],f,support); b = midpoint(d["second"],f,support)
            mid = (a+b)/2
            for layer in range(1,25):
                if d["axis"] == "x":
                    sides = [box[2]-layer*gap,box[3]+layer*gap]
                    if mid[1] > cy: sides.reverse()
                    candidates.extend([[float(mid[0]),float(y)] for y in sides])
                else:
                    sides = [box[0]-layer*gap,box[1]+layer*gap]
                    if mid[0] > cx: sides.reverse()
                    candidates.extend([[float(x),float(mid[1])] for x in sides])
        else:
            if d["kind"] in ("diameter","radius"):
                elem = next(g for g in geometries(f) if g["id"] == d.get("element","legacy"))
                center = np.array([elem["x"],elem["y"]]); radius = elem["a"]/2
            else:
                center = midpoint(d["first"],f,support); radius = gap
            for layer in range(1,16):
                for angle in (math.pi/4,-math.pi/4,3*math.pi/4,-3*math.pi/4,0,math.pi/2,math.pi,-math.pi/2):
                    candidates.append((center+(radius+gap*layer)*np.array([math.cos(angle),math.sin(angle)])).tolist())
        best = None
        for index, p in enumerate(candidates):
            if any(abs(x)>9999 for x in p): continue
            g = dimension_geometry(d,f,support,p); rect = rectangle(g["label"],label_text(d),scale)
            collisions = sum(overlaps(rect,r) for r in occupied)
            shape_hits = sum(segment_hits_box(a,b,rect) for a,b in geometry)
            line_hits = sum(segment_hits_box(a,b,rect) for a,b in placed_lines)
            score = collisions*100000 + shape_hits*1000 + line_hits*100 + index
            if best is None or score < best[0]: best = (score,p,g,rect)
            if collisions == shape_hits == line_hits == 0: break
        if best is None: continue
        _,p,g,rect = best
        d["position"] = [round(float(x),8) for x in p]
        d["layout"] = {"mode":"auto","last_position":list(d["position"])}
        occupied.append(rect); placed_lines.extend(g["segments"]); changed.append(d["id"])
    collisions = sum(overlaps(a,b) for i,a in enumerate(occupied) for b in occupied[i+1:])
    return {"arranged":changed,"preserved_manual":len(fixed),"label_overlaps":collisions,
            "reference_viewport":[1000,700],"note":"Positionen sind Skizzenkoordinaten. Sehr kleine Fenster können weitere Anpassungen erfordern."}
