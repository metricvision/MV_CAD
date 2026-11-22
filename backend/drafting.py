"""Orthographic workshop views, in model millimetres."""
import json
import math

import cadquery as cq
from OCP.BRepLib import BRepLib
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
    # Only complete straight edges and true circles can own dimensions.
    if kind == 'LINE':
        return ('line', *sorted(tuple(round(v, 4) for v in p) for p in points))
    return ('circle', *(round(v, 4) for v in center), round(radius, 4))


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
        for ref, edge in refs:
            kind = edge.geomType()
            if kind == 'LINE':
                pts = [point(edge.startPoint()), point(edge.endPoint())]
                if math.dist(*pts) < 1e-6:
                    continue
                sig = signature(pts, kind)
            elif kind == 'CIRCLE' and edge.IsClosed() and abs(edge.normal().dot(cq.Vector(normal))) > .999999:
                sig = signature([], kind, point(edge.arcCenter()), edge.radius())
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
                if sig in lookup:
                    item['ref'] = lookup[sig][1]
                lines.append(item)
        for group in (hlr.HCompound(), hlr.OutLineHCompound(), hlr.Rg1LineHCompound()):
            for edge in edges_in(group):
                points = outline(edge)
                if len(points) >= 2:
                    lines.append({'points': points, 'hidden': True})
        result[name] = lines
    return result
