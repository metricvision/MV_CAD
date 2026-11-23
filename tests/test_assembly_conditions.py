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
    def test_shared_offset_parameter(self):
        doc = assembly('offset', parameterId='spacing', parameterSign=1)
        mate = doc['constraints'][0]
        mate['childFace'] = 'base/end'
        doc['parameters'] = [dict(id='spacing', name='Fachhöhe', value=25)]
        doc['instances'].append(dict(id='c', part='plate'))
        doc['constraints'].append(dict(mate, id='second', child='c', parameterSign=-1))
        for spacing in (25, 40, 0):
            doc['parameters'][0].update(name='Abstand', value=spacing)
            result = prepare(json.loads(json.dumps(doc)))
            self.assertAlmostEqual(result['transforms']['b'][2][3], spacing, places=5)
            self.assertAlmostEqual(result['transforms']['c'][2][3], -spacing, places=5)
            doc = result['document']
        # Unlinking holds the last numeric value. The other face pair still follows.
        del doc['constraints'][1]['parameterId'], doc['constraints'][1]['parameterSign']
        doc['parameters'][0]['value'] = 12
        result = prepare(doc)
        self.assertEqual([c['offset'] for c in result['document']['constraints']], [12, 0])

    def test_invalid_or_conflicting_offset_parameter(self):
        doc = assembly('offset', parameterId='p')
        doc['constraints'][0]['childFace'] = 'base/end'
        with self.assertRaises(AssemblyError):
            prepare(doc)
        doc['parameters'] = [dict(id='p', name='Abstand', value=18)]
        doc['instances'][1]['fixed'] = True
        accepted = prepare(doc)['document']
        candidate = json.loads(json.dumps(accepted))
        candidate['parameters'][0]['value'] = 50
        with self.assertRaises(AssemblyError):
            prepare(candidate)
        self.assertEqual(prepare(accepted)['document']['constraints'][0]['offset'], 18)
        doc['parameters'].append(dict(id='other', name=' abstand ', value=18))
        with self.assertRaises(AssemblyError):
            prepare(doc)

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
