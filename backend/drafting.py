"""Orthographic workshop views, in model millimetres."""
import json
import math

import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepLib import BRepLib
from OCP.GeomAbs import GeomAbs_Torus
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf

from .assembly.assembly import prepare
from .geometry.engine import build_state, edge_catalog, face_info

def edges_in(shape):
    if not shape.IsNull():
        BRepLib.BuildCurves3d_s(shape)
        yield from cq.Shape.cast(shape).Edges()


def xy(point):
    return [round(point.x, 6), round(-point.y, 6)]


def outline(edge):
    if edge.geomType() == 'LINE':
        return [xy(edge.startPoint()), xy(edge.endPoint())]
    pts, _ = edge.sample(0.04)
    if edge.IsClosed() and pts:
        pts.append(pts[0])
    return [xy(p) for p in pts]


def signature(points, kind, center=None, radius=None):
    # Rounded geometry matches projected strokes; it is never saved as a dimension ID.
    if kind == 'LINE':
        return ('line', *sorted(tuple(round(v, 4) for v in p) for p in points))
    return ('circle', *(round(v, 4) for v in center), round(radius, 4))


def rotational_faces(registry, location):
    # Follow the model's persistent face names, including assembly placement.
    named = {entry['faces'][0]: key for key, entry in registry.items() if len(entry['faces']) == 1}
    for face, key in named.items():
        if face.geomType() not in ('CYLINDER','TORUS'):
            continue
        face = face.moved(location)
        u0, u1, v0, v1 = face.uvBounds()
        if u1-u0 < 2*math.pi-1e-7:  # A corner round is not a shaft section.
            continue
        yield key, BRepAdaptor_Surface(face.wrapped), v0, v1


def cylinder_section(instance, key, cylinder, v0, v1):
    origin = cq.Vector(cylinder.Location())
    axis = cq.Vector(cylinder.Axis().Direction())
    ends = [origin + axis*t for t in (v0, v1)]
    # A common orientation groups coaxial faces even when their UV axes oppose.
    if max(axis.toTuple(), key=abs) < 0:
        axis = axis.multiply(-1)
    foot = origin-axis*origin.dot(axis)
    group = (instance, *(round(x, 6) for x in (*axis.toTuple(), *foot.toTuple())))
    return instance, key, group, ends, axis, cylinder.Radius()


def project(payload):
    model = payload['model']
    assembly = model.get('format') == 'MetricCAD-assembly'
    target = payload.get('part')
    if assembly and target is None:
        solved = prepare(model)
        parts = {p['id']: p['document'] for p in model['parts']}
        instances = [(i['id'], i['part'], solved['transforms'][i['id']]) for i in model['instances']]
    else:
        part = next(p['document'] for p in model['parts'] if p['id'] == target) if assembly else model
        parts = {'part': part}
        instances = [('', 'part', None)]
    built = {}
    objects = []
    refs = []
    cylinders = []
    rounds = []
    projection = payload.get('projection') or {}
    face_key = projection.get('face')
    normal, right = cq.Vector(0,-1,0), cq.Vector(1,0,0)
    found = False
    for instance, key, matrix in instances:
        if key not in built:
            body, registry, _, _ = build_state(parts[key])
            if body is None:
                raise ValueError('Teil enthält keinen Volumenkörper.')
            built[key] = body, edge_catalog(body, registry), registry
        body, catalog, registry = built[key]
        location = cq.Location()
        if matrix:
            tr = gp_Trsf()
            tr.SetValues(*(v for row in matrix[:3] for v in row))
            location = cq.Location(tr)
        if face_key and instance == projection.get('instance', ''):
            entry = registry.get(face_key)
            faces = entry['faces'] if entry else []
            if len(faces) == 1 and faces[0].geomType() == 'PLANE':
                frame = face_info(faces[0], entry)['frame']
                def direction(v):
                    if matrix:
                        v = [sum(row[i]*v[i] for i in range(3)) for row in matrix[:3]]
                    return cq.Vector(v).normalized()
                normal, right = direction(frame['n']), direction(frame['u'])
                found = True
        objects.append(body.moved(location))
        for key, surface, v0, v1 in rotational_faces(registry, location):
            if surface.GetType() == GeomAbs_Torus:
                rounds.append((instance, key, surface, v0, v1))
            else:
                cylinders.append(cylinder_section(instance, key, surface.Cylinder(), v0, v1))
        for item in catalog:
            if item['ref'] and not item['ref'].get('chain'):
                ref = json.dumps([instance,item['ref']], sort_keys=True, separators=(',', ':'))
                refs.append((ref, item['edge'].moved(location)))
    if not objects:
        raise ValueError('Baugruppe enthält keine Teile.')
    compound = cq.Compound.makeCompound(objects)
    result = {}
    if face_key and not found:
        raise ValueError('Projektionsfläche fehlt oder ist nicht mehr eindeutig.')
    up = normal.cross(right).normalized()
    for _ in range(int(projection.get('turns', 0)) % 4):
        right, up = up, right.multiply(-1)
    axes = {'front': (normal,right,up), 'top': (up,right,normal.multiply(-1)),
            'right': (right,normal.multiply(-1),up)}
    if payload.get('includeIso') or payload.get('isoOnly'):
        diagonal = (normal + right + up).normalized()
        horizontal = (right - normal).normalized()
        iso = (diagonal, horizontal, diagonal.cross(horizontal).normalized())
        if payload.get('isoOnly'):
            axes = {}
        axes['iso'] = iso
    for name, vectors in axes.items():
        normal, right, up = (v.toTuple() for v in vectors)
        def point(v):
            return [round(v.dot(cq.Vector(right)), 6), round(-v.dot(cq.Vector(up)), 6)]
        lookup = {}
        sight = cq.Vector(normal)
        # In an axial view each meridian of a shoulder fillet is a true radius.
        arcs = {}
        def add_arc(ref, ends, center, tip, radius, depth):
            key = signature(ends, 'LINE')
            arcs.setdefault(key, []).append((depth, dict(ref=ref, arcCenter=center,
                                                         radiusPoint=tip, radius=radius)))
        for instance, key, surface, v0, v1 in rounds:
            torus = surface.Torus()
            axis = cq.Vector(torus.Axis().Direction())
            if abs(axis.dot(sight)) > 1e-7:
                continue
            for side in (-1, 1):
                radial = sight.cross(axis).normalized()*side
                u = math.atan2(radial.dot(cq.Vector(torus.YAxis().Direction())),
                               radial.dot(cq.Vector(torus.XAxis().Direction())))
                ends = [point(cq.Vector(surface.Value(u,v))) for v in (v0,v1)]
                tip = cq.Vector(surface.Value(u,(v0+v1)/2))
                center = cq.Vector(torus.Location()) + radial*torus.MajorRadius()
                add_arc(json.dumps([instance,'round',key,side]), ends, point(center),
                        point(tip), torus.MinorRadius(), tip.dot(sight))
        sections = {}
        axis_ends = {}
        for instance, key, group, ends, axis, radius in cylinders:
            if abs(axis.dot(sight)) > 1e-7:
                continue
            axis_ends.setdefault(group, []).extend(point(p) for p in ends)
            radial = sight.cross(axis).normalized()*radius
            for side in (-1, 1):
                span = [point(p+radial*side) for p in ends]
                sig = signature(span, 'LINE')
                depth = ends[0].dot(sight)
                if sig not in sections or depth > sections[sig][0]:
                    ref = json.dumps([instance, 'cylinder', key, side])
                    mid = (ends[0]+ends[1])*0.5
                    cross_section = [point(mid-radial), point(mid+radial)]
                    sections[sig] = depth, ref, group, cross_section, 2*radius
        for ref, edge in refs:
            kind = edge.geomType()
            if kind == 'LINE':
                pts = [point(edge.startPoint()), point(edge.endPoint())]
                if math.dist(*pts) < 1e-6:
                    continue
                sig = signature(pts, kind)
            elif kind == 'CIRCLE' and not edge.IsClosed() and abs(edge.normal().dot(sight)) > .999999:
                tip = edge.positionAt(.5)
                add_arc(ref, [point(edge.startPoint()), point(edge.endPoint())],
                        point(edge.arcCenter()), point(tip), edge.radius(), tip.dot(sight))
                continue
            elif kind == 'CIRCLE' and edge.IsClosed() and abs(edge.normal().dot(cq.Vector(normal))) > .999999:
                sig = signature([], kind, point(edge.arcCenter()), edge.radius())
            elif kind == 'CIRCLE' and edge.IsClosed() and abs(edge.normal().dot(sight)) < 1e-7:
                center = edge.arcCenter()
                radial = sight.cross(edge.normal()).normalized()*edge.radius()
                sig = signature([point(center-radial), point(center+radial)], 'LINE')
                ref = json.dumps(['edge-on', ref])
            else:
                continue
            # The frontmost coincident projection owns the visible reference.
            depth = edge.Center().dot(cq.Vector(normal))
            if sig not in lookup or depth > lookup[sig][0]:
                lookup[sig] = depth, ref
        algo = HLRBRep_Algo()
        algo.Add(compound.wrapped)
        algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(), gp_Dir(*normal), gp_Dir(*right))))
        algo.Update()
        algo.Hide()
        hlr = HLRBRep_HLRToShape(algo)
        lines = []
        visible_axes = set()
        for group in (hlr.VCompound(), hlr.OutLineVCompound(), hlr.Rg1LineVCompound()):
            for edge in edges_in(group):
                pts = outline(edge)
                if len(pts) < 2:
                    continue
                bb = edge.BoundingBox()
                item = {'points': pts, 'box': [bb.xmin, -bb.ymax, bb.xmax, -bb.ymin]}
                sig = None
                if edge.geomType() == 'LINE':
                    sig = signature(pts, 'LINE')
                    item['ends'] = sorted([pts[0], pts[-1]])
                elif edge.geomType() == 'CIRCLE' and edge.IsClosed():
                    item.update(center=xy(edge.arcCenter()), diameter=2*edge.radius())
                    sig = signature([], 'CIRCLE', item['center'], edge.radius())
                elif len(pts) > 2:
                    # HLR can return an edge-on ring as a sampled, degenerate ellipse.
                    span = [min(pts), max(pts)]
                    sig = signature(span, 'LINE')
                    (x,y),(u,v) = span
                    length = math.dist(*span)
                    if sig in lookup and length > 1e-7 and all(
                        abs((u-x)*(b-y)-(v-y)*(a-x)) <= 2e-6*length for a,b in pts
                    ):
                        item['ends'] = span
                    else:
                        sig = None
                if sig in lookup:
                    item['ref'] = lookup[sig][1]
                if sig in sections:
                    depth, ref, axis_group, cross_section, diameter = sections[sig]
                    if depth >= lookup.get(sig, (-math.inf,))[0]-1e-7:
                        if sig not in lookup or depth > lookup[sig][0]+1e-7:
                            item['ref'] = ref
                        item.update(diameter=diameter, diameterEnds=cross_section)
                        visible_axes.add(axis_group)
                if arcs and not edge.IsClosed() and edge.geomType() != 'LINE':
                    candidates = arcs.get(signature([pts[0],pts[-1]], 'LINE'), ())
                    if candidates:
                        mid = xy(edge.positionAt(.5))
                        matches = sorted(((depth, arc) for depth, arc in candidates
                                          if math.dist(arc['radiusPoint'], mid) <= max(1e-5, 5e-4*arc['radius'])),
                                         key=lambda match:match[0], reverse=True)
                        if matches and (len(matches)==1 or matches[0][0]-matches[1][0]>1e-7):
                            item.update(matches[0][1])
                lines.append(item)
        for group in (hlr.HCompound(), hlr.OutLineHCompound(), hlr.Rg1LineHCompound()):
            for edge in edges_in(group):
                points = outline(edge)
                if len(points) >= 2:
                    lines.append({'points': points, 'hidden': True})
        for group in sorted(visible_axes):
            ends = axis_ends[group]
            # Sort on the dominant coordinate to handle vertical and rotated shafts.
            dim = max((0, 1), key=lambda i: max(p[i] for p in ends)-min(p[i] for p in ends))
            ordered = sorted(ends, key=lambda p: p[dim])
            lines.append({'axis': True, 'points': [ordered[0], ordered[-1]]})
        result[name] = lines
    return result
