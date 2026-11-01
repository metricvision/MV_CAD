"""Parametric cylindrical helices and screw-oriented profile sweeps (millimetres).
Helix features: id, op='helix', axis X/Y/Z, origin [x,y,z], radius,
pitch, height, phase (degrees), leftHand, reverse. Sketch support {'helix':id}
places local X radially outward and local Y along the helix axis at its start.
Sweep features reuse the sketch and set op='sweep'/'sweep-pocket', path=id.
"""
import math
import cadquery as cq
import numpy as np
import sketches
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell


def value(v,label,positive=False):
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>10000 or (positive and v<=0):raise ValueError(label+': ungültiger Wert')
    return float(v)


def validate_helix(f):
    if f.get('axis') not in ('X','Y','Z'):raise ValueError('Helixachse muss X, Y oder Z sein')
    origin=f.get('origin')
    if not isinstance(origin,list) or len(origin)!=3:raise ValueError('Helix benötigt einen XYZ-Ursprung')
    for n in origin:value(n,'Ursprung')
    for k in ('radius','pitch','height'):value(f.get(k),k,True)
    if f['radius']<.001 or f['pitch']<.01:raise ValueError('Helixradius mindestens 0,001 mm, Steigung mindestens 0,01 mm')
    if not .01<=f['height']/f['pitch']<=100:raise ValueError('Helix benötigt 0,01 bis 100 Windungen')
    value(f.get('phase',0),'Startwinkel')
    for k in ('leftHand','reverse'):
        if type(f.get(k,False)) is not bool:raise ValueError('Ungültige Helixrichtung')


def basis(f):
    validate_helix(f)
    axis=cq.Vector(*{'X':(1,0,0),'Y':(0,1,0),'Z':(0,0,1)}[f['axis']])*(-1 if f.get('reverse') else 1)
    u=cq.Vector(0,1,0) if f['axis']=='X' else cq.Vector(1,0,0)
    v=axis.cross(u);a=math.radians(f.get('phase',0));radial=u*math.cos(a)+v*math.sin(a)
    return cq.Vector(*f['origin']),radial,axis


def profile_frame(f):
    o,u,v=basis(f)
    return {'o':list((o+u*f['radius']).toTuple()),'u':list(u.toTuple()),'v':list(v.toTuple()),'n':list(u.cross(v).toTuple())}


def path(f):
    o,u,v=basis(f)
    wire=cq.Wire.makeHelix(f['pitch'],f['height'],f['radius'],lefthand=f.get('leftHand',False))
    return wire.moved(cq.Plane(origin=o,xDir=u,normal=v).location)


def helix_layout(f):
    o,u,v=basis(f);side=v.cross(u);turns=f['height']/f['pitch'];count=max(16,math.ceil(turns*64));points=[]
    for i in range(count+1):
        t=i/count;a=t*turns*2*math.pi*(-1 if f.get('leftHand') else 1)
        p=o+u*(f['radius']*math.cos(a))+side*(f['radius']*math.sin(a))+v*(f['height']*t);points.append(list(p.toTuple()))
    span=max(2,f['pitch']*1.5)
    return {'id':f['id'],'helix':True,'frame':profile_frame(f),'points':points,'axisPoints':[list(o.toTuple()),list((o+v*f['height']).toTuple())],'bounds':[-span,span,-span,span],'targets':{},'edges':[],'planar':True}


def make_sweep(f,helix):
    validate_helix(helix)
    if f.get('support')!={'helix':helix['id']} or f.get('path')!=helix['id']:raise ValueError('Sweep-Profil muss auf der Startfläche seiner Helix liegen')
    frame=profile_frame(helix);o,u,v,n=[cq.Vector(*frame[k]) for k in ('o','u','v','n')]
    world=lambda p:o+u*float(p[0])+v*float(p[1])
    gs=[g for g in f['geometry'] if not g.get('construction')]
    loops=sketches.profile_loops(gs,world,n)
    if len(loops)!=1:raise ValueError('Helix-Sweep benötigt genau eine geschlossene Kontur ohne Innenkonturen')
    # Conservative exact extrema prevent crossing the axis or adjacent turns.
    ranges=[]
    for normal in (np.array([1.,0.]),np.array([0.,1.])):
        vals=[]
        for g in gs:
            if g['type'] in ('ellipse','spline'):ps=sketches.curve_extrema(g,normal)
            elif g['type']=='arc':ps=sketches.arc_extrema(g,normal)
            elif g['type']=='circle':
                c=np.array([g['x'],g['y']]);ps=[c-normal*g['a']/2,c+normal*g['a']/2]
            else:ps=list(sketches.points(g).values())
            vals.extend(float(np.dot(p,normal)) for p in ps)
        ranges.append((min(vals),max(vals)))
    if ranges[0][0]+helix['radius']<=1e-5:raise ValueError('Sweep-Profil berührt oder kreuzt die Helixachse')
    if ranges[1][1]-ranges[1][0]>=helix['pitch']-1e-5:raise ValueError('Profilhöhe muss kleiner als die Steigung sein, damit sich Windungen nicht berühren')
    contour=loops[0]
    try:
        op=BRepOffsetAPI_MakePipeShell(path(helix).wrapped)
        # The helix Frenet frame rotates rigidly about its axis. Keeping correction
        # off preserves the initial axial/radial profile, including left-hand paths.
        op.SetMode(True);op.SetTolerance(1e-6,1e-6,1e-5)
        op.Add(contour['wire'].wrapped,False,False);op.Build()
        if not op.IsDone() or not op.MakeSolid():raise ValueError('Helix-Sweep konnte nicht geschlossen werden')
        solid=cq.Shape.cast(op.Shape())
        if not solid.isValid() or len(solid.Solids())!=1 or solid.Volume()<=1e-8:raise ValueError('Helix-Sweep ist ungültig. Profil und Steigung prüfen.')
        registry={}
        def add(key,faces):
            if faces:registry[key]={'faces':faces,'anchor':list(o.toTuple()),'u':list(u.toTuple()),'label':f.get('name','Helix-Sweep')+' · '+key.split('/')[-1]}
        for role,shape in [('start',op.FirstShape()),('end',op.LastShape())]:
            caps=cq.Shape.cast(shape).Faces() if not shape.IsNull() else []
            add(f['id']+'/'+role,[ff for ff in solid.Faces() if any(ff.isSame(c) for c in caps)])
        for owner,role,edge in contour['edges']:
            history=list(op.Generated(edge.wrapped));faces=[ff for ff in solid.Faces() if any(ff.wrapped.IsSame(g) for g in history)]
            if not faces:raise ValueError('Sweep-Seitenfläche konnte nicht ihrer Profilkante zugeordnet werden')
            add(f['id']+'/g-'+owner['id']+'/'+role,faces)
        return solid,registry
    except ValueError:raise
    except Exception as exc:raise ValueError('Helix-Sweep fehlgeschlagen. Profil verkleinern oder Steigung erhöhen.') from exc
