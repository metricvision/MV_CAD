"""MiniCAD 0.2. BRep history and conservative semantic planar-face references."""
import copy
import math
import cadquery as cq
from . import sketches
from . import sweeps
from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut

class ModelError(ValueError): pass

def num(v, name='Maß', positive=False):
    if isinstance(v,bool): raise ModelError(name+': Zahl erwartet')
    try: n=float(v)
    except (ValueError,TypeError): raise ModelError(name+': Zahl erwartet')
    if not math.isfinite(n) or abs(n)>10000 or (positive and n<=0):
        raise ModelError(name+': ungültig (maximal 10000 mm)')
    return n

def vec(v): return cq.Vector(*v)
def arr(v): return list(v.toTuple())
def plane_frame(name):
    specs={'XY':([1,0,0],[0,0,1]),'XZ':([1,0,0],[0,-1,0]),'YZ':([0,1,0],[1,0,0])}
    if name not in specs: raise ModelError('Unbekannte Ursprungsebene')
    u,n=map(vec,specs[name]);return {'o':[0,0,0],'u':arr(u),'v':arr(n.cross(u)),'n':arr(n)}

def local(p,frame):
    d=p-vec(frame['o']);return [d.dot(vec(frame[k])) for k in ('u','v')]

def face_frame(face,anchor,u):
    n=face.normalAt().normalized();u=vec(u);u=u-n*n.dot(u)
    if u.Length<1e-7:
        u=vec([0,0,1] if abs(n.z)<.9 else [1,0,0]);u=u-n*n.dot(u)
    u=u.normalized();a=vec(anchor);o=a+n*(face.Center()-a).dot(n)
    return {'o':arr(o),'u':arr(u),'v':arr(n.cross(u)),'n':arr(n)}

def face_info(face,entry):
    if face.geomType()!='PLANE': return {'planar':False}
    frame=face_frame(face,entry['anchor'],entry['u'])
    edges=[];line_edges=[]
    for e in face.Edges():
        pts,_=e.sample(2 if e.geomType()=='LINE' else 48)
        ps=[local(p,frame) for p in pts];edges.append(ps)
        if e.geomType()=='LINE':line_edges.append(ps)
    pts=[p for e in edges for p in e]
    bounds=[min(p[0] for p in pts),max(p[0] for p in pts),min(p[1] for p in pts),max(p[1] for p in pts)]
    targets={}
    for role,axis,value in [('left',0,bounds[0]),('right',0,bounds[1]),('bottom',1,bounds[2]),('top',1,bounds[3])]:
        candidates=[e for e in line_edges if all(abs(p[axis]-value)<1e-6 for p in e)]
        if len(candidates)==1: targets[role]={'coordinate':value,'points':candidates[0]}
    return {'planar':True,'frame':frame,'edges':edges,'bounds':bounds,'targets':targets}

def migrate(doc):
    if not isinstance(doc,dict):raise ModelError('Projekt muss ein Objekt sein')
    if doc.get('version')==2:return copy.deepcopy(doc)
    if doc.get('version')!=1:raise ModelError('Unbekanntes Projektformat')
    b=doc['base'];base={'id':b['id'],'name':'Grundkörper','support':{'plane':'XY'},'shape':'rect','op':'pad','x':b['w']/2,'y':b['h']/2,'a':b['w'],'b':b['h'],'depth':b['z'],'reverse':False}
    features=[base]
    for i,old in enumerate(doc['features']):
        f={k:old[k] for k in ('id','shape','op','a','b','depth')}
        f.update(name='Skizze '+str(i+2),support={'face':b['id']+'/end'},x=0,y=0,reverse=False)
        for axis in ('x','y'):
            oldref=old['r'+axis]
            if oldref['source']!=b['id']:raise ModelError('Alte Kantenreferenz verloren')
            f['r'+axis]={'role':oldref['role'],'distance':oldref['distance']}
        features.append(f)
    return {'version':2,'features':features}

def validate(doc):
    doc=migrate(doc);fs=doc.get('features')
    if not isinstance(fs,list) or len(fs)>50:raise ModelError('Maximal 50 Skizzen')
    ids=[]
    for f in fs:
        if not isinstance(f,dict):raise ModelError('Ungültige Skizze')
        fid=f.get('id')
        if not isinstance(fid,str) or not fid or len(fid)>100 or '/' in fid:raise ModelError('Ungültige Skizzen-ID')
        ids.append(fid)
        if f.get('op')=='helix':
            sweeps.validate_helix(f);continue
        if f.get('op') in ('sweep','sweep-pocket'):
            if f.get('shape')!='multi':raise ModelError('Sweep benötigt eine Mehrfachskizze')
            if f.get('support')!={'helix':f.get('path')} or not isinstance(f.get('path'),str):raise ModelError('Sweep benötigt eine zugeordnete Helix')
        if f.get('op') in ('fillet','chamfer'):
            num(f.get('amount'),'Radius / Fasenmaß',True)
            refs=f.get('edges')
            if not isinstance(refs,list) or not 1<=len(refs)<=30:raise ModelError('1 bis 30 Kanten auswählen')
            for ref in refs:
                if not isinstance(ref,dict) or not isinstance(ref.get('faces'),list) or len(ref['faces'])!=2 or not all(isinstance(x,str) for x in ref['faces']) or not isinstance(ref.get('curve'),str):raise ModelError('Ungültige Kantenreferenz')
                if 'chain' in ref and ref['chain'] is not True:raise ModelError('Ungültige zusammenhängende Kantenreferenz')
                if 'branch' in ref:
                    branch=ref['branch']
                    if (not isinstance(branch,dict) or set(branch)!={'axis','side'}
                        or type(branch['axis']) is not int or branch['axis'] not in (0,1,2)
                        or type(branch['side']) is not int or branch['side'] not in (-1,1)):
                        raise ModelError('Ungültige Kantenseite')
            continue
        if 'symmetric' in f and type(f['symmetric']) is not bool:raise ModelError('Ungültige gespiegelte Ausdehnung')
        if f.get('shape') not in ('rect','circle','multi'):raise ModelError('Unbekanntes Profil')
        if f.get('op') not in ('sketch','pad','pocket','revolve','revolve-pocket','sweep','sweep-pocket'):raise ModelError('Unbekannte Bearbeitung')
        if f['op'] in ('revolve','revolve-pocket'):
            if f['shape']!='multi':raise ModelError('Rotation benötigt eine Mehrfachskizze')
            f['revolveAngle']=num(f.get('revolveAngle'),'Rotationswinkel',True)
            if f['revolveAngle']>360:raise ModelError('Rotationswinkel muss größer 0 und höchstens 360° sein')
            sketches.revolve_axis(f)
        if not isinstance(f.get('support'),dict) or len(f['support'])!=1:raise ModelError('Ungültige Skizzenauflage')
        if f['shape']=='multi':
            sketches.validate(f)
            if 'reverse' in f and type(f['reverse']) is not bool:raise ModelError('Ungültige Richtung')
            num(f.get('depth'),'Tiefe',True)
            continue
        for k in ('x','y'):num(f.get(k),k)
        for k in ('a','b','depth'):num(f.get(k),k,True)
        if 'reverse' in f and not isinstance(f['reverse'],bool):raise ModelError('Ungültige Richtung')
        for k in ('rx','ry'):
            if f.get(k):
                r=f[k]
                if not isinstance(r,dict) or r.get('role') not in (('left','right') if k=='rx' else ('bottom','top')):raise ModelError('Ungültige Maßreferenz')
                num(r.get('distance'),'Abstand')
    previous=set()
    for f in fs:
        ref=f.get('support',{}).get('helix')
        if ref is not None and ref not in previous:raise ModelError('Helix fehlt oder steht nach ihrer Profilskizze')
        if f['op']=='helix':previous.add(f['id'])
    if len(ids)!=len(set(ids)):raise ModelError('Doppelte Skizzen-ID')
    return doc

def tool_registry(tool,f,frame,x,y):
    u,v,n=(vec(frame[k]) for k in ('u','v','n'))
    anchor=vec(frame['o'])+u*x+v*y
    result={}
    sign=-1 if (f['op']=='pocket') != (bool(f.get('reverse')) and not f.get('symmetric',False)) else 1
    for face in tool.Faces():
        if face.geomType()=='PLANE':
            normal=face.normalAt();dots=[normal.dot(a) for a in (u,v,n)]
            if abs(dots[2])>.99:role='end' if dots[2]*sign>0 else 'start'
            elif abs(dots[0])>.99:role='right' if dots[0]>0 else 'left'
            else:role='top' if dots[1]>0 else 'bottom'
        else:role='wall'
        key=f['id']+'/'+role
        if key in result:raise ModelError('Mehrdeutige erzeugte Fläche')
        result[key]={'faces':[face],'anchor':arr(anchor),'u':arr(u),'label':str(f.get('name','Skizze'))+' · '+role}
    return result

def propagate(registry,operation,result):
    all_faces=result.Faces();out={}
    for key,entry in registry.items():
        candidates=[]
        for old in entry['faces']:
            modified=list(operation.Modified(old.wrapped))
            shapes=modified if modified else ([] if operation.IsDeleted(old.wrapped) else [old.wrapped])
            for candidate in shapes:
                for face in all_faces:
                    if face.wrapped.IsSame(candidate) and not any(face.wrapped.IsSame(x.wrapped) for x in candidates):candidates.append(face)
        out[key]={**entry,'faces':candidates}
    return out

def name_split_faces(body,registry,feature_id):
    """Name split patches by their semantic neighbours, never by face indices.

    The original reference stays ambiguous. New references are only assigned
    where adjacency distinguishes patches uniquely; later operations propagate
    them through BRep history just like the original face names.
    """
    if not any(len(entry['faces'])>1 for entry in registry.values()):return registry
    import hashlib
    import json
    faces=body.Faces();adjacency={};names=[]
    for i,face in enumerate(faces):
        names.append({key for key,entry in registry.items()
                      if not entry.get('split_reference')
                      and any(face.isSame(old) for old in entry['faces'])})
        for edge in face.Edges():adjacency.setdefault(hash(edge.wrapped),[]).append((edge,i))
    out=dict(registry)
    for key,entry in registry.items():
        if len(entry['faces'])<2:continue
        groups={}
        for patch in entry['faces']:
            neighbours=set()
            for edge in patch.Edges():
                for other,i in adjacency.get(hash(edge.wrapped),[]):
                    if edge.isSame(other) and not patch.isSame(faces[i]):neighbours.update(names[i])
            neighbours.discard(key)
            signature=json.dumps(sorted(neighbours),separators=(',',':'))
            groups.setdefault(signature,[]).append(patch)
        for signature,patches in groups.items():
            if len(patches)!=1 or signature=='[]':continue
            patch=patches[0]
            if any(len(v['faces'])==1 and patch.isSame(v['faces'][0]) for v in out.values()):continue
            digest=hashlib.sha256(signature.encode()).hexdigest()
            child=key+'/split-'+feature_id+'/'+digest
            # Never resurrect an existing reference whose history lost its face.
            if child in out:continue
            out[child]={**entry,'faces':[patch],'split_reference':True,
                        'label':entry['label']+' · Teilfläche'}
    return out

def resolve_feature_support(support,registry,layouts):
    if 'helix' not in support:return resolve_support(support,registry)
    found=[l for l in layouts if l.get('helix') and l['id']==support['helix']]
    if len(found)!=1:raise ModelError('Helixauflage fehlt. Helix wiederherstellen oder Profil neu zuordnen.')
    l=found[0]
    return {k:copy.deepcopy(l[k]) for k in ('frame','edges','bounds','targets','planar')}

def resolve_support(support,registry):
    if 'plane' in support:
        return {'frame':plane_frame(support['plane']),'edges':[],'bounds':[-50,50,-50,50],'targets':{},'planar':True}
    key=support.get('face');entry=registry.get(key)
    if not entry or not entry['faces']:raise ModelError('Auflagefläche fehlt. Skizze neu zuordnen oder vorherige Änderung zurücknehmen.')
    if len(entry['faces'])!=1:raise ModelError('Auflagefläche wurde geteilt: Referenz ist mehrdeutig. Skizze neu zuordnen.')
    info=face_info(entry['faces'][0],entry)
    if not info['planar']:raise ModelError('Skizzen benötigen eine ebene Fläche')
    return info

# A sketch may reference only the body built BEFORE that sketch. This avoids
# circular dependencies and makes external geometry read-only for the solver.
def reference_body(body,registry):
    if body is None:return {'vertices':[],'triangles':[],'edges':[]}
    vertices=[];triangles=[]
    # Meshing is performed on a copy: display triangulations must not alter
    # the topology retained for later boolean and fillet operations.
    mesh_body=body.copy(mesh=False)
    for face in mesh_body.Faces():
        vs,ts=face.tessellate(.12,.12);offset=len(vertices)
        vertices.extend(arr(v) for v in vs);triangles.extend([[i+offset for i in t] for t in ts])
    edges=[]
    for item in edge_catalog(body,registry):
        edge=item['edge'];pts,_=edge.sample(2 if edge.geomType()=='LINE' else 64)
        if edge.IsClosed() and pts and (pts[0]-pts[-1]).Length>1e-7:pts.append(pts[0])
        edges.append({'ref':item['ref'],'points':[arr(p) for p in pts]})
    return {'vertices':vertices,'triangles':triangles,'edges':edges}

_EXTERNAL_CACHE=[]

def external_support(support,body,registry):
    if body is None:return {**support,'external':[],'referenceBody':reference_body(None,{})}
    frame=support['frame'];external=[]
    for old_body,old_registry,old_frame,data in _EXTERNAL_CACHE:
        if old_body is body and old_registry is registry and old_frame==frame:return {**support,**data}
    # Vertex identities come from incident semantic faces, not endpoint indices.
    face_names=[]
    for face in body.Faces():
        names=[k for k,v in registry.items() if len(v['faces'])==1 and face.isSame(v['faces'][0])]
        if names:face_names.append((face,names[-1]))
    def vertex_names(vertex):return sorted(k for face,k in face_names if any(vertex.isSame(v) for v in face.Vertices()))
    def project(p):return local(p,frame)
    def depth(p):return (p-vec(frame['o'])).dot(vec(frame['n']))
    for item in edge_catalog(body,registry):
        edge=item['edge'];ref=item['ref']
        if ref is None:continue
        typ=edge.geomType();data={'ref':ref}
        if typ=='CIRCLE' and edge.IsClosed():
            circle=edge._geomAdaptor().Circle();axis=circle.Axis().Direction()
            normal=vec([axis.X(),axis.Y(),axis.Z()])
            if abs(normal.dot(vec(frame['n'])))<1-1e-8:continue
            pos=circle.Location();center=vec([pos.X(),pos.Y(),pos.Z()])
            data.update(type='circle',center=project(center),radius=circle.Radius(),depth=depth(center))
        elif typ=='LINE':
            ends=edge.Vertices()
            if len(ends)!=2:continue
            keyed=[(vertex_names(v),v.Center()) for v in ends]
            if not keyed[0][0] or not keyed[1][0] or keyed[0][0]==keyed[1][0]:continue
            keyed.sort(key=lambda v:v[0]);ps=[project(v) for _,v in keyed]
            if math.dist(*ps)<1e-7:continue
            data.update(type='line',points=ps,depths=[depth(v) for _,v in keyed],vertices=[k for k,_ in keyed])
        else:continue
        external.append(data)
    data={'external':external,'referenceBody':reference_body(body,registry)}
    _EXTERNAL_CACHE.append((body,registry,copy.deepcopy(frame),data));del _EXTERNAL_CACHE[:-8]
    return {**support,**data}


def dimension_point(ref, f, support, axis):
    """Return affine coordinate: coefficients [x,y,width,height] and constant."""
    import numpy as np
    c=np.zeros(4);kind=ref.get('kind');role=ref.get('role')
    if ref.get('external'):
        typ,val=sketches.geometry_ref(ref,[],support)
        if typ=='point':return c,float(val[axis])
        if typ=='line' and abs(val[1][axis]-val[0][axis])<1e-6:return c,float((val[0][axis]+val[1][axis])/2)
        raise ModelError('Externe Referenz: Mittelpunkt oder senkrechte Kante auswählen')
    if kind=='origin':return c,0.0
    if kind=='axis':
        if role not in ('vertical','horizontal') or axis!=(0 if role=='vertical' else 1):raise ModelError('Abstand muss senkrecht zur Skizzenachse liegen')
        return c,0.0
    if kind in ('point','edge'):
        c[axis]=1
        signs={'bl':(-1,-1),'br':(1,-1),'tr':(1,1),'tl':(-1,1),'center':(0,0),'left':(-1,0),'right':(1,0),'bottom':(0,-1),'top':(0,1)}
        if role not in signs:raise ModelError('Unbekannter Skizzenpunkt')
        if kind=='edge' and ((axis==0 and role not in ('left','right')) or (axis==1 and role not in ('bottom','top'))):raise ModelError('Abstand muss senkrecht zur Kante liegen')
        if f['shape']=='circle' and role not in ('center',):raise ModelError('Kreis über Mittelpunkt oder Durchmesser bemaßen')
        c[2+axis]=signs[role][axis]/2
        return c,0.0
    if kind in ('support-edge','support-point'):
        target=support['targets'].get(role)
        if not target:raise ModelError('Bemaßte Referenzkante fehlt oder wurde geteilt')
        edge_axis=0 if role in ('left','right') else 1
        if kind=='support-edge':
            if axis!=edge_axis:raise ModelError('Abstand muss senkrecht zur Referenzkante liegen')
            return c,float(target['coordinate'])
        endpoint=ref.get('endpoint')
        if endpoint not in (0,1):raise ModelError('Ungültiger Referenzpunkt')
        points=sorted(target['points'],key=lambda p:p[1-edge_axis])
        return c,float(points[endpoint][axis])
    raise ModelError('Unbekannte Maßreferenz')

def constraint_info(rows,f):
    import numpy as np
    columns=[0,1,2] if f['shape']=='circle' else [0,1,2,3]
    A=np.array(rows,dtype=float).reshape((-1,4))[:,columns]
    if len(A):
        _,s,v=np.linalg.svd(A,full_matrices=True)
        rank=int(np.sum(s>1e-9));null=v[rank:].T
    else:rank=0;null=np.eye(len(columns))
    def fixed(coeff):return bool(np.linalg.norm(np.array(coeff)[columns]@null)<1e-8)
    def point(sx,sy):return fixed([1,0,sx/2,0]) and fixed([0,1,0,sy/2])
    points={role:point(*sign) for role,sign in {'bl':(-1,-1),'br':(1,-1),'tr':(1,1),'tl':(-1,1),'center':(0,0)}.items()}
    edges={}
    if f['shape']=='rect':
        for role,ends,normal,length in [('left',('bl','tl'),[1,0,-.5,0],[0,0,0,1]),('right',('br','tr'),[1,0,.5,0],[0,0,0,1]),('bottom',('bl','br'),[0,1,0,-.5],[0,0,1,0]),('top',('tl','tr'),[0,1,0,.5],[0,0,1,0])]:
            edges[role]='fixed' if all(points[p] for p in ends) else 'partial' if fixed(normal) or fixed(length) else 'free'
    else:edges['circle']='fixed' if rank==3 else 'partial' if fixed([0,0,1,0]) or points['center'] else 'free'
    return {'dof':len(columns)-rank,'fully':rank==len(columns),'edges':edges,'points':points}

def solve_dimensions(f,support):
    import numpy as np
    # Convert legacy center-to-boundary dimensions into visible dimension objects.
    ds=f.setdefault('dimensions',[])
    for axis in ('x','y'):
        legacy=f.pop('r'+axis,None)
        if legacy:
            role=legacy['role'];sign=1 if role in ('left','bottom') else -1
            ds.append({'id':'legacy-'+axis,'kind':'linear','axis':axis,'first':{'kind':'support-edge','role':role},'second':{'kind':'point','role':'center'},'value':abs(legacy['distance']),'sign':sign*(1 if legacy['distance']>=0 else -1),'position':[f['x']+12,f['y']+12]})
    if not isinstance(ds,list) or len(ds)>30:raise ModelError('Maximal 30 Maße pro Skizze')
    original=np.array([num(f[k]) for k in ('x','y','a','b')],dtype=float)
    rows=[];rhs=[];ids=set()
    for d in ds:
        if not isinstance(d,dict) or not isinstance(d.get('id'),str) or d['id'] in ids:raise ModelError('Ungültige oder doppelte Maß-ID')
        ids.add(d['id']);value=num(d.get('value'),'Maßwert')
        if value<0:raise ModelError('Maßwert darf nicht negativ sein')
        p=d.get('position')
        if not isinstance(p,list) or len(p)!=2:raise ModelError('Maßlinienposition fehlt')
        for v in p:num(v,'Maßlinienposition')
        if d.get('kind')=='diameter':
            if f['shape']!='circle':raise ModelError('Durchmesser benötigt einen Kreis')
            row=np.array([0.,0.,1.,0.]);target=value
        elif d.get('kind')=='linear':
            axis=d.get('axis');sign=d.get('sign')
            if axis not in ('x','y') or sign not in (-1,1):raise ModelError('Ungültige Maßrichtung')
            a,ca=dimension_point(d['first'],f,support,0 if axis=='x' else 1)
            b,cb=dimension_point(d['second'],f,support,0 if axis=='x' else 1)
            row=b-a;target=sign*value-(cb-ca)
            if np.linalg.norm(row)<1e-12:raise ModelError('Dieses Maß kann keine Skizzengeometrie steuern. Mindestens ein Skizzenelement wählen.')
        else:raise ModelError('Unbekannter Maßtyp')
        rows.append(row);rhs.append(target)
    if not rows:return constraint_info(rows,f)
    A=np.array(rows);b=np.array(rhs)
    def attempt(matrix,values):
        delta=np.linalg.lstsq(matrix,values-matrix@original,rcond=None)[0]
        result=original+delta
        return result if np.max(np.abs(matrix@result-values))<1e-6 else None
    # Keep unconstrained profile sizes for a position dimension when possible.
    result=attempt(np.vstack([A,[[0,0,1,0],[0,0,0,1]]]),np.r_[b,original[2:]])
    if result is None:result=attempt(A,b)
    if result is None:raise ModelError('Widersprüchliche Bemaßung. Ein vorhandenes Maß ändern oder löschen.')
    if result[2]<=1e-6 or result[3]<=1e-6:raise ModelError('Bemaßung würde das Profil auf null verkleinern oder umklappen')
    for k,v in zip(('x','y','a','b'),result):f[k]=num(round(float(v),10),k,k in ('a','b'))
    return constraint_info(rows,f)


def logical_edge_components(group):
    """Only closed, nonbranching, tangent loops may contain multiple edges."""
    vertices=[];ends=[]
    for item in group:
        ids=[]
        for vertex in item['edge'].Vertices():
            found=next((i for i,v in enumerate(vertices) if v.isSame(vertex)),None)
            if found is None:found=len(vertices);vertices.append(vertex)
            ids.append(found)
        ends.append(ids)
    pending=set(range(len(group)));components=[]
    while pending:
        stack=[min(pending)];component=[]
        while stack:
            i=stack.pop()
            if i not in pending:continue
            pending.remove(i);component.append(i)
            stack.extend(j for j in pending if set(ends[i])&set(ends[j]))
        component.sort()
        if len(component)>1:
            junctions={v:[i for i in component if v in ends[i]] for i in component for v in ends[i]}
            if any(len(ends[i])!=2 for i in component) or any(len(es)!=2 for es in junctions.values()):return None
            for v,es in junctions.items():
                tangents=[];point=vertices[v].Center()
                for i in es:
                    edge=group[i]['edge']
                    t=0 if (edge.positionAt(0)-point).Length<(edge.positionAt(1)-point).Length else 1
                    if (edge.positionAt(t)-point).Length>1e-5:return None
                    tangents.append(edge.tangentAt(t).normalized())
                if abs(tangents[0].dot(tangents[1]))<1-1e-6:return None
        components.append([group[i] for i in component])
    return components


def identify_edge_group(group):
    components=logical_edge_components(group)
    if components is None:return False
    if len(components)==1 and len(components[0])>1:
        for item in group:item['ref']={**item['ref'],'chain':True}
        return True
    if len(components)!=2:return False
    intervals=[]
    for component in components:
        boxes=[item['edge'].BoundingBox() for item in component]
        intervals.append([(min(getattr(b,k+'min') for b in boxes),max(getattr(b,k+'max') for b in boxes)) for k in 'xyz'])
    separated=[k for k in range(3) if max(intervals[1][k][0]-intervals[0][k][1],intervals[0][k][0]-intervals[1][k][1])>1e-5]
    if len(separated)!=1:return False
    axis=separated[0];first_low=sum(intervals[0][axis])<sum(intervals[1][axis])
    for i,component in enumerate(components):
        for item in component:
            item['ref']={**item['ref'],'branch':{'axis':axis,'side':-1 if (i==0)==first_low else 1}}
            if len(component)>1:item['ref']['chain']=True
    return True


def edge_catalog(body,registry):
    import json
    faces=body.Faces();named=[]
    for face in faces:
        names=[k for k,e in registry.items() if len(e['faces'])==1 and face.wrapped.IsSame(e['faces'][0].wrapped)]
        # An individual face may have split while its intersection with a
        # uniquely named neighbour still identifies exactly one edge. Keep
        # existing unique names first; validate fallback pairs below as usual.
        if not names:
            names=[k for k,e in registry.items() if len(e['faces'])>1
                   and any(face.wrapped.IsSame(p.wrapped) for p in e['faces'])]
        named.append(names[-1] if names else None)
    # Build edge-to-face adjacency once. Hash buckets are checked with IsSame
    # so orientation differences and hash collisions cannot change identity.
    adjacency={}
    for i,face in enumerate(faces):
        for edge in face.Edges():
            adjacency.setdefault(hash(edge.wrapped),[]).append((edge,i))
    items=[]
    for edge in body.Edges():
        adjacent=sorted({i for other,i in adjacency.get(hash(edge.wrapped),[]) if edge.wrapped.IsSame(other.wrapped)})
        keys=[named[i] for i in adjacent]
        ref={'faces':sorted(keys),'curve':edge.geomType()} if len(keys)==2 and all(keys) and len(set(keys))==2 else None
        items.append({'edge':edge,'ref':ref})
    groups={}
    for item in items:
        if item['ref'] is not None:
            groups.setdefault(json.dumps(item['ref'],sort_keys=True),[]).append(item)
    for group in groups.values():
        if len(group)==1:continue  # Preserve all existing unambiguous references.
        if not identify_edge_group(group):
            for item in group:item['ref']=None
    return items

def contour_extras(operation,chosen):
    covered=[];extra=[]
    for contour in range(1,operation.NbContours()+1):
        for index in range(1,operation.NbEdges(contour)+1):
            edge=operation.Edge(contour,index)
            if edge.IsNull():raise ModelError('Kantenkette konnte nicht sicher geprüft werden')
            if not any(edge.IsSame(x) for x in covered):covered.append(edge)
            if not any(edge.IsSame(x.wrapped) for x in chosen) and not any(edge.IsSame(x) for x in extra):extra.append(edge)
    if any(not any(edge.wrapped.IsSame(x) for x in covered) for edge in chosen):
        raise ModelError('Nicht alle ausgewählten Kanten konnten einer gültigen Kantenkette zugeordnet werden.')
    return extra


def require_selected_contours(operation,chosen,kind):
    extra=contour_extras(operation,chosen)
    if extra:
        label='Verrundung' if kind=='fillet' else 'Fase'
        raise ModelError(label+' abgebrochen: Open Cascade würde '+str(len(extra))+
                         ' zusätzliche Kante(n) automatisch mitbearbeiten. Erlaubt sind nur ausdrücklich ausgewählte Kanten.')


def bounded_fillet_slab(body,chosen,extra):
    """Support a conservative, planar stop for parallel straight convex edges.

    Bounds of every propagated edge must lie outside the open stop interval.
    No nearest-edge guessing or sampling-based containment decisions are used.
    """
    error=('Begrenzter Rundungsabschluss hier nicht möglich: Unterstützt werden gerade, parallele Kanten '+
           'mit gleicher Ausdehnung. Automatisch fortgesetzte Kanten müssen außerhalb der Abschlussflächen liegen.')
    if any(edge.geomType()!='LINE' for edge in chosen):raise ModelError(error)
    endpoints=[[v.Center() for v in edge.Vertices()] for edge in chosen]
    if any(len(ps)!=2 for ps in endpoints):raise ModelError(error)
    n=(endpoints[0][1]-endpoints[0][0]).normalized()
    dominant=max(range(3),key=lambda i:abs(n.toTuple()[i]))
    if n.toTuple()[dominant]<0:n=n.multiply(-1)
    low,high=sorted(p.dot(n) for p in endpoints[0]);tol=1e-5
    if high-low<=tol:raise ModelError(error)
    for ps in endpoints:
        direction=(ps[1]-ps[0]).normalized();a,b=sorted(p.dot(n) for p in ps)
        if abs(direction.dot(n))<1-1e-9 or abs(a-low)>tol or abs(b-high)>tol:raise ModelError(error)
    for wrapped in extra:
        box=cq.Shape.cast(wrapped).BoundingBox()
        projections=[cq.Vector(x,y,z).dot(n) for x in (box.xmin,box.xmax)
                     for y in (box.ymin,box.ymax) for z in (box.zmin,box.zmax)]
        if min(projections)<high-tol and max(projections)>low+tol:raise ModelError(error)
    box=body.BoundingBox();center=box.center
    origin=center+n.multiply(low-center.dot(n))
    width=box.DiagonalLength*3+10
    slab=cq.Workplane(cq.Plane(origin=origin,normal=n)).rect(width,width).extrude(high-low).val()
    return slab,n,origin,high-low


def bounded_boolean(kind,left,right,registry):
    operation=kind(left.wrapped,right.wrapped);operation.SetNonDestructive(True);operation.Build()
    if not operation.IsDone():raise ModelError('Begrenzter Rundungsabschluss konnte nicht berechnet werden')
    result=cq.Shape.cast(operation.Shape())
    if not result.isValid():raise ModelError('Begrenzter Rundungsabschluss erzeugt ungültige Geometrie')
    return result,propagate(registry,operation,result)


def apply_bounded_fillet(body,full,registry,newreg,slab_info,feature_id,extra):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    slab,n,origin,height=slab_info
    # Initially support material-removing (convex) blends only. Mixed/concave
    # blends require a different termination construction and fail closed.
    added,_=bounded_boolean(BRepAlgoAPI_Cut,full,body,{})
    if added.Volume()>1e-7:
        raise ModelError('Begrenzter Abschluss für konkave oder gemischte Verrundungen wird noch nicht unterstützt.')
    removed,cutreg=bounded_boolean(BRepAlgoAPI_Cut,body,full,newreg)
    capreg={}
    for side,position,normal in [('start',origin,n.multiply(-1)),('end',origin+n.multiply(height),n)]:
        faces=[face for face in slab.Faces() if face.geomType()=='PLANE' and face.normalAt().dot(normal)>1-1e-8]
        capreg[feature_id+'/stop-'+side]={'faces':faces,'anchor':arr(position),
                                        'u':arr(vec([1,0,0]) if abs(n.x)<.9 else vec([0,1,0])),
                                        'label':'Rundungsabschluss'}
    limited,limitedreg=bounded_boolean(BRepAlgoAPI_Common,removed,slab,{**cutreg,**capreg})
    if limited.Volume()<=1e-8:raise ModelError('Begrenzte Verrundung verändert den Körper nicht')
    result,reg=bounded_boolean(BRepAlgoAPI_Cut,body,limited,{**registry,**limitedreg})
    if len(result.Solids())!=len(body.Solids()) or result.Volume()<=0:raise ModelError('Begrenzter Abschluss erzeugt keinen zusammenhängenden Körper')
    # Booleans may copy topology at the end vertices. Verify geometric coverage
    # with OCCT common-edge operations rather than requiring object identity.
    result_edges=result.Edges();edge_set=None
    for edge in extra:
        if any(edge.IsSame(candidate.wrapped) for candidate in result_edges):continue
        if edge_set is None:edge_set=cq.Compound.makeCompound(result_edges)
        original=cq.Shape.cast(edge)
        common,_=bounded_boolean(BRepAlgoAPI_Common,original,edge_set,{})
        if abs(sum(candidate.Length() for candidate in common.Edges())-original.Length())>1e-6:
            raise ModelError('Abschluss abgebrochen: Eine nicht ausgewählte Kante würde verändert werden.')
    return result,reg


def treatment(body,registry,f):
    import json
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet,BRepFilletAPI_MakeChamfer
    if body is None:raise ModelError('Zuerst einen Körper erzeugen')
    catalog=edge_catalog(body,registry);chosen=[]
    for ref in f['edges']:
        matches=[e['edge'] for e in catalog if e['ref']==ref]
        if not matches or (len(matches)!=1 and ref.get('chain') is not True):raise ModelError('Kantenreferenz fehlt oder ist mehrdeutig. Bearbeitung löschen und Kante neu wählen.')
        if any(match.wrapped.IsSame(e.wrapped) for match in matches for e in chosen):raise ModelError('Kante doppelt ausgewählt')
        chosen.extend(matches)
    amount=num(f['amount'],'Radius / Fasenmaß',True)
    try:
        operation=(BRepFilletAPI_MakeFillet if f['op']=='fillet' else BRepFilletAPI_MakeChamfer)(body.wrapped)
        for edge in chosen:operation.Add(amount,edge.wrapped)
        extra=contour_extras(operation,chosen);slab_info=None
        if extra:
            if f['op']=='fillet':slab_info=bounded_fillet_slab(body,chosen,extra)
            else:require_selected_contours(operation,chosen,f['op'])
        operation.Build()
        if not operation.IsDone():raise ModelError('Kantenbearbeitung nicht möglich. Kleineres Maß oder andere Kanten wählen.')
        after=contour_extras(operation,chosen)
        if len(after)!=len(extra) or any(not any(a.IsSame(b) for b in extra) for a in after):
            raise ModelError('Kantenkette wurde während der Berechnung verändert. Vorgang abgebrochen.')
        result=cq.Shape.cast(operation.Shape())
        if not result.isValid() or len(result.Solids())!=len(body.Solids()) or result.Volume()<=0:raise ModelError('Kantenbearbeitung erzeugt keinen gültigen Körper')
        if abs(result.Volume()-body.Volume())<1e-8:raise ModelError('Kantenbearbeitung verändert den Körper nicht')
        reg=propagate(registry,operation,result);newreg={}
        for i,edge in enumerate(chosen):
            generated=list(operation.Generated(edge.wrapped))
            fs=[face for face in result.Faces() if any(face.wrapped.IsSame(g) for g in generated)]
            if fs:newreg[f['id']+'/edge-'+str(i)]={'faces':fs,'anchor':arr(edge.Center()),'u':[1,0,0],'label':f.get('name',f['op'])}
        if slab_info is not None:return apply_bounded_fillet(body,result,registry,newreg,slab_info,f['id'],extra)
        reg.update(newreg)
        return result,reg
    except ModelError:raise
    except Exception as exc:raise ModelError('Kantenbearbeitung fehlgeschlagen. Radius/Fasenmaß verkleinern oder andere Kanten wählen.') from exc


# Only the most recent feature chain is retained (maximum 50 stages).
# Shape snapshots are reused, never edited in place by the application.
_STAGES=[]
LAST_REBUILT=0

def clear_cache():
    _STAGES.clear();_EXTERNAL_CACHE.clear()

def signature(feature):
    import json
    return json.dumps(feature,sort_keys=True,separators=(',',':'),allow_nan=False)

def store_stage(feature,raw_signature,body,registry,layouts):
    _STAGES.append({'signatures':{raw_signature,signature(feature)},'feature':copy.deepcopy(feature),
                    'body':body,'registry':registry,'layouts':copy.deepcopy(layouts)})

def build_state(raw):
    global LAST_REBUILT
    doc=validate(raw);body=None;registry={};layouts=[];common=0;LAST_REBUILT=0
    for i,f in enumerate(doc['features']):
        if i>=len(_STAGES) or signature(f) not in _STAGES[i]['signatures']:break
        common+=1
    if common:
        cached=_STAGES[common-1];body=cached['body'];registry=cached['registry'];layouts=copy.deepcopy(cached['layouts'])
        for i in range(common):doc['features'][i]=copy.deepcopy(_STAGES[i]['feature'])
    del _STAGES[common:]
    for f in doc['features'][common:]:
        raw_signature=signature(f);LAST_REBUILT+=1
        try:
            if f['op']=='helix':
                layouts.append(sweeps.helix_layout(f));store_stage(f,raw_signature,body,registry,layouts);continue
            if f['op'] in ('fillet','chamfer'):
                body,registry=treatment(body,registry,f)
                registry=name_split_faces(body,registry,f['id'])
                store_stage(f,raw_signature,body,registry,layouts)
                continue
            support=external_support(resolve_feature_support(f['support'],registry,layouts),body,registry);frame=support['frame']
            if f['shape']=='multi':
                constraints=sketches.solve(f,support)
                layouts.append({'id':f['id'],'geometry':copy.deepcopy(f['geometry']),'constraints':constraints,**support})
                if f['op']=='sketch':
                    store_stage(f,raw_signature,body,registry,layouts);continue
                if f['op'] in ('sweep','sweep-pocket'):
                    helix=next(x for x in doc['features'] if x['id']==f['path'] and x['op']=='helix')
                    tool,newreg=sweeps.make_sweep(f,helix)
                else:tool,newreg=sketches.make_tool(f,frame)
            else:
                constraints=solve_dimensions(f,support)
                x,y=num(f['x']),num(f['y'])
                layouts.append({'id':f['id'],'x':x,'y':y,'a':f['a'],'b':f['b'],'constraints':constraints,**support})
                if f['op']=='sketch':
                    store_stage(f,raw_signature,body,registry,layouts)
                    continue
                sign=-1 if (f['op']=='pocket') != (bool(f.get('reverse')) and not f.get('symmetric',False)) else 1
                extrusion_origin=vec(frame['o'])-vec(frame['n'])*(sign*f['depth'] if f.get('symmetric') else 0)
                wp=cq.Workplane(cq.Plane(origin=extrusion_origin.toTuple(),xDir=tuple(frame['u']),normal=tuple(frame['n']))).center(x,y)
                wp=wp.circle(num(f['a'],positive=True)/2) if f['shape']=='circle' else wp.rect(num(f['a'],positive=True),num(f['b'],positive=True))
                sign=-1 if (f['op']=='pocket') != (bool(f.get('reverse')) and not f.get('symmetric',False)) else 1
                tool=wp.extrude(sign*num(f['depth'],positive=True)*(2 if f.get('symmetric') else 1)).val()
                newreg=tool_registry(tool,f,frame,x,y)
            if body is None:
                if f['op'] in ('pocket','revolve-pocket','sweep-pocket'):raise ModelError('Eine Tasche benötigt zuerst einen Volumenkörper')
                body=tool;registry=newreg
            else:
                old_volume=body.Volume()
                op=(BRepAlgoAPI_Cut if f['op'] in ('pocket','revolve-pocket','sweep-pocket') else BRepAlgoAPI_Fuse)(body.wrapped,tool.wrapped)
                op.SetNonDestructive(True)
                op.Build()
                if not op.IsDone():raise ModelError('Geometrieoperation fehlgeschlagen')
                body=cq.Shape.cast(op.Shape())
                if not body.isValid() or not body.Solids():raise ModelError('Bearbeitung muss gültige Volumenkörper ergeben')
                if len(body.Solids())!=1 and f['shape']!='multi' and len(_STAGES[-1]['body'].Solids())==1:raise ModelError('Bearbeitung muss einen zusammenhängenden gültigen Körper ergeben')
                if abs(body.Volume()-old_volume)<1e-7:raise ModelError('Bearbeitung verändert den Körper nicht. Lage und Richtung prüfen.')
                registry=propagate({**registry,**newreg},op,body)
                registry=name_split_faces(body,registry,f['id'])
            store_stage(f,raw_signature,body,registry,layouts)
        except (ModelError,KeyError,TypeError,ValueError) as e:
            raise ModelError(str(f.get('name','Skizze'))+': '+str(e)) from e
    return body,registry,layouts,doc

def build(doc):
    body,_,layouts,_=build_state(doc)
    if body is None:raise ModelError('Noch kein Volumenkörper. Zuerst eine Skizze aufpolstern.')
    return cq.Workplane('XY').newObject([body]),layouts

def drag_sketch(payload):
    """Solve a temporary drag without extruding the edited sketch or its successors."""
    if not isinstance(payload,dict):raise ModelError('Ungültige Verschiebung')
    doc=validate(payload.get('document'))
    matches=[i for i,f in enumerate(doc['features']) if f['id']==payload.get('sketch')]
    if len(matches)!=1:raise ModelError('Skizze fehlt')
    index=matches[0];f=doc['features'][index]
    if f.get('shape')!='multi' or f['op'] not in ('sketch','pad','pocket','revolve','revolve-pocket','sweep','sweep-pocket'):raise ModelError('Ungültige Skizze zum Verschieben')
    body,registry,layouts,_=build_state({'version':2,'features':doc['features'][:index]})
    support=external_support(resolve_feature_support(f['support'],registry,layouts),body,registry)
    sketches.solve(f,support)
    constraints=sketches.solve(f,support,{'element':payload.get('element'),'point':payload.get('point'),'delta':payload.get('delta')})
    return {'feature':f,'constraints':constraints}

def preview(raw):
    body,registry,layouts,doc=build_state(raw)
    pathpoints=[p for l in layouts if l.get('helix') for p in l['points']]
    pathbounds=[min(p[i] for p in pathpoints) if side==0 else max(p[i] for p in pathpoints) for i in range(3) for side in (0,1)] if pathpoints else [-50,50,-50,50,-50,50]
    if body is None:return {'document':doc,'vertices':[],'triangles':[],'triangleFaces':[],'faces':[],'edges':[],'layouts':layouts,'volume':0,'bounds':pathbounds}
    vertices=[];triangles=[];triangle_faces=[];faces=[]
    for index,face in enumerate(body.Faces()):
        vs,ts=face.copy(mesh=False).tessellate(.12,.12);offset=len(vertices)
        vertices.extend([arr(v) for v in vs]);triangles.extend([[i+offset for i in t] for t in ts]);triangle_faces.extend([index]*len(ts))
        matches=[(key,e) for key,e in registry.items() if any(face.wrapped.IsSame(x.wrapped) for x in e['faces'])]
        unique=[(key,e) for key,e in matches if len(e['faces'])==1]
        item={'id':index,'key':None,'planar':face.geomType()=='PLANE','label':'Fläche','selectable':False}
        if unique:
            key,e=unique[-1];item.update(key=key,label=e['label'],selectable=face.geomType()=='PLANE');item.update(face_info(face,e))
        elif matches:item['label']='Geteilte Fläche · Referenz mehrdeutig'
        if not item['planar']:item['label']='Gekrümmte Fläche · keine ebene Skizzenauflage'
        faces.append(item)
    edges=[]
    for i,item in enumerate(edge_catalog(body,registry)):
        e=item['edge'];pts,_=e.sample(2 if e.geomType()=='LINE' else 64)
        edges.append({'id':i,'ref':item['ref'],'points':[arr(p) for p in pts],'selectable':item['ref'] is not None})
    b=body.BoundingBox()
    return {'document':doc,'vertices':vertices,'triangles':triangles,'triangleFaces':triangle_faces,'faces':faces,'edges':edges,'layouts':layouts,'volume':body.Volume(),'solidCount':len(body.Solids()),'bounds':[b.xmin,b.xmax,b.ymin,b.ymax,b.zmin,b.zmax]}


def solve_sketch(payload):
    """Solve only the edited sketch; its solid and successors stay deferred."""
    if not isinstance(payload,dict):raise ModelError('Ungültige Skizzenanfrage')
    doc=validate(payload.get('document'))
    indices=[i for i,f in enumerate(doc['features']) if f['id']==payload.get('sketch')]
    if len(indices)!=1:raise ModelError('Skizze fehlt')
    index=indices[0];f=doc['features'][index]
    if f['op'] in ('helix','fillet','chamfer'):raise ModelError('Keine Skizze ausgewählt')
    body,registry,layouts,prefix=build_state({'version':2,'features':doc['features'][:index]})
    doc['features'][:index]=prefix['features']
    support=external_support(resolve_feature_support(f['support'],registry,layouts),body,registry)
    if f['shape']=='multi':
        constraints=sketches.solve(f,support)
        layout={'id':f['id'],'geometry':copy.deepcopy(f['geometry']),'constraints':constraints,**support}
    else:
        constraints=solve_dimensions(f,support)
        layout={'id':f['id'],'x':f['x'],'y':f['y'],'a':f['a'],'b':f['b'],'constraints':constraints,**support}
    return {'sketchOnly':True,'document':doc,'layout':layout}
