import unittest

from backend.drafting import project


def shaft(radius=4):
    profile = [(0,0),(0,8),(12,8),(12,radius),(40,radius),(40,8),(52,8),(52,0)]
    points = [dict(id=f'p{i}', x=x, y=y) for i,(x,y) in enumerate(profile)]
    return {'version':2,'features':[dict(id='shaft', shape='multi', op='revolve', depth=1,
        support={'plane':'XY'}, revolveAxis={'kind':'axis','role':'horizontal'},
        revolveAngle=360, geometry=[dict(id='outline', type='polyline', closed=True, points=points)],
        dimensions=[], relations=[])]}


def rounded_shaft(radius):
    model = shaft(radius)
    model['features'].append(dict(id='round', op='fillet', amount=1, edges=[
        dict(curve='CIRCLE', faces=['shaft/g-outline/p2','shaft/g-outline/p3']),
        dict(curve='CIRCLE', faces=['shaft/g-outline/p3','shaft/g-outline/p4'])]))
    return model


class CylinderDrawingTests(unittest.TestCase):
    def test_rounded_shoulders_and_stable_dimensions(self):
        old = project({'model':rounded_shaft(4)})['front']
        new = project({'model':rounded_shaft(5)})['front']
        self.assertEqual([e['points'] for e in new if e.get('axis')], [[[0,0],[52,0]]])
        updated = {e['ref']:e for e in new if 'ref' in e}
        middle = [e for e in old if e.get('diameter') == 8]
        self.assertEqual(len(middle), 2)
        self.assertNotEqual(middle[0]['ref'], middle[1]['ref'])
        for e in middle:
            self.assertEqual(updated[e['ref']]['diameter'], 10)
            self.assertEqual([p[0] for p in e['ends']], [13,39])
        for x in (0,12,40,52):
            shoulder = next(e for e in old if e.get('ends') == [[x,-8],[x,8]])
            self.assertEqual(updated[shoulder['ref']]['ends'], shoulder['ends'])

    def test_shoulder_radius_follows_fillet_edit(self):
        model = rounded_shaft(4)
        first = project({'model':model})
        arcs = {e['ref']:e for e in first['front'] if 'radiusPoint' in e}
        self.assertEqual(len(arcs), 4)
        self.assertEqual({e['radius'] for e in arcs.values()}, {1})
        self.assertFalse(any('radiusPoint' in e for e in first['right']))
        model['features'][-1]['amount'] = 2
        updated = {e['ref']:e for e in project({'model':model})['front'] if 'radiusPoint' in e}
        self.assertEqual(updated.keys(), arcs.keys())
        self.assertEqual({e['radius'] for e in updated.values()}, {2})

    def test_extruded_pin_uses_the_same_dimension_tool(self):
        model = {'version':2,'features':[dict(id='pin', shape='circle', op='pad',
            support={'plane':'XY'}, x=0, y=0, a=10, b=10, depth=30)]}
        front = project({'model':model})['front']
        self.assertEqual([e['diameter'] for e in front if 'diameterEnds' in e], [10,10])
        self.assertEqual([e['points'] for e in front if e.get('axis')], [[[0,-30],[0,0]]])

    def test_end_view_and_rotated_instances(self):
        model = shaft()
        end = project({'model':model})['right']
        self.assertFalse(any(e.get('axis') for e in end))
        self.assertTrue(any(e.get('center') == [0,0] and e.get('ref') for e in end))
        instances = [dict(id=str(i),part='p',fixed=True,
                          pose=dict(position=[0,0,i*80],rotation=[0,35,0])) for i in range(2)]
        assembly = dict(format='MetricCAD-assembly',version=1,parts=[dict(id='p',document=model)],
                        instances=instances,joints=[])
        front = project({'model':assembly})['front']
        self.assertEqual(sum(bool(e.get('axis')) for e in front), 2)
        self.assertEqual(len({e['ref'] for e in front if 'diameterEnds' in e}), 12)
        iso = project({'model':model, 'isoOnly':True})['iso']
        self.assertFalse(any(e.get('diameterEnds') or e.get('axis') for e in iso))
