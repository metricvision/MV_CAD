"""Assembly conditions through the same build and solve entry point as the UI."""
import json
import math
import unittest

import numpy as np

from backend.assembly.assembly import AssemblyError, prepare


def assembly(kind, **options):
    def part(name, shape):
        feature = dict(id='base', shape=shape, op='pad', support={'plane':'XY'},
                       x=0, y=0, a=10, b=20, depth=8)
        return {'id':name, 'document':{'version':2, 'features':[feature]}}

    return {
        'format':'MetricCAD-assembly', 'version':1,
        'parts':[part('plate','rect'), part('roller','circle')],
        'instances':[{'id':'a','part':'plate','fixed':True},
                     {'id':'b','part':'roller','pose':{'position':[0,0,18]}}],
        'joints':[],
        'constraints':[dict(id='mate', type=kind, parent='a', child='b',
                            parentFace='base/end', childFace='base/wall', **options)]
    }


class AssemblyConditions(unittest.TestCase):
    def test_tangent_sides_drag_and_reload(self):
        for opposed in (False, True):
            result = prepare(assembly('tangent', opposed=opposed))
            for step in ('drag', 'reload'):
                doc = json.loads(json.dumps(result['document']))
                if step == 'drag':
                    doc['_drag'] = {'instance':'b', 'position':[4,2,18]}
                result = prepare(doc)
                matrix = np.array(result['transforms']['b'])
                self.assertAlmostEqual(matrix[2,2], 0, places=6)
                self.assertAlmostEqual(matrix[2,3], 8 + (-5 if opposed else 5), places=5)
                self.assertEqual(result['dof'], 4)

    def test_angle_parallel_perpendicular_and_oblique(self):
        for angle in (0, 35, 90, 180):
            model = assembly('angle', angle=angle)
            first = prepare(model, include_mesh=True)
            axis_local = first['parts']['roller']['datums']['base/wall']['frame']['n']
            doc = first['document']
            result = prepare(json.loads(json.dumps(doc)))
            axis = np.array(result['transforms']['b'])[:3,:3] @ axis_local
            self.assertAlmostEqual(axis[2], math.cos(math.radians(angle)), places=6)
            self.assertEqual(result['dof'], 4 if angle in (0,180) else 5)

    def test_invalid_selections_and_locked_parts(self):
        doc = assembly('tangent')
        doc['constraints'][0]['childFace'] = 'base/end'
        with self.assertRaises(AssemblyError):
            prepare(doc)
        for doc in (assembly('angle', angle=181), assembly('angle', angle=90), assembly('tangent')):
            doc['instances'][1]['fixed'] = True
            with self.assertRaises(AssemblyError):
                prepare(doc)
