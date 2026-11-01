"""Only adapter between assembly and Part Design. Geometry is immutable/cached."""
import hashlib,json
from collections import OrderedDict
import numpy as np
from assembly_solver import AssemblyError,pose_matrix
_CACHE=OrderedDict()

def part_asset(document):
    key=hashlib.sha256(json.dumps(document,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    if key in _CACHE:
        _CACHE.move_to_end(key);return _CACHE[key]
    import engine
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    body,registry,_,normalized=engine.build_state(document)
    if body is None:raise AssemblyError('Teil enthält keinen Volumenkörper')
    preview=engine.preview(normalized);datums={}
    for name,entry in registry.items():
        if len(entry['faces'])!=1:continue
        face=entry['faces'][0];kind=face.geomType()
        if kind=='PLANE':frame=engine.face_info(face,entry)['frame']
        elif kind=='CYLINDER':
            cylinder=BRepAdaptor_Surface(face.wrapped,True).Cylinder();axis=cylinder.Axis();origin=axis.Location();direction=axis.Direction();x=cylinder.Position().XDirection();u=np.array([x.X(),x.Y(),x.Z()]);n=np.array([direction.X(),direction.Y(),direction.Z()]);o=np.array([origin.X(),origin.Y(),origin.Z()]);center=np.array(face.Center().toTuple());o=o+n*np.dot(center-o,n)
            frame={'o':o.tolist(),'u':u.tolist(),'v':np.cross(n,u).tolist(),'n':n.tolist()}
        else:continue
        datums[name]={'type':kind,'label':entry.get('label',name),'frame':frame}
    asset={'key':key,'body':body,'document':normalized,'mesh':{k:preview[k] for k in ['vertices','triangles','triangleFaces','faces','edges','bounds']},'datums':datums}
    _CACHE[key]=asset
    while len(_CACHE)>30:_CACHE.popitem(last=False)
    return asset

def frame_matrix(spec,asset):
    if 'face' in spec:
        datum=asset['datums'].get(spec['face'])
        if not datum:raise AssemblyError('Gelenkreferenz fehlt oder ist mehrdeutig: '+spec['face']+'. Bitte Auflage neu wählen.')
        frame=datum['frame'];t=np.eye(4);t[:3,:3]=np.array([frame['u'],frame['v'],frame['n']]).T;t[:3,3]=frame['o']
        return t@pose_matrix({'position':spec.get('offset',[0,0,0]),'rotation':spec.get('rotation',[0,0,0])})
    return pose_matrix({'position':spec.get('origin',[0,0,0]),'rotation':spec.get('rotation',[0,0,0])})
