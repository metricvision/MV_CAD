"""Multi-element sketches: stable local IDs, numeric constraints, nested contours."""
import math
import numpy as np
import cadquery as cq
from scipy.optimize import least_squares
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.gp import gp_Vec, gp_Ax1, gp_Pnt, gp_Dir

class SketchError(ValueError): pass

def number(v):
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>10000:raise SketchError('Ungültige Skizzenkoordinate oder Maßwert')
    return float(v)

def ident(v):
    if not isinstance(v,str) or not v or len(v)>100 or '/' in v:raise SketchError('Ungültige Geometrie-ID')
    return v

def validate(f):
    validate_relations(f)
    gs=f.get('geometry');ds=f.get('dimensions',[])
    if not isinstance(gs,list) or not 1<=len(gs)<=60:raise SketchError('1 bis 60 Elemente pro Skizze erlaubt')
    if not isinstance(ds,list) or len(ds)>120:raise SketchError('Maximal 120 Maße pro Skizze')
    ids=set();total=0
    for g in gs:
        gid=ident(g.get('id'))
        if gid in ids:raise SketchError('Doppelte Geometrie-ID')
        ids.add(gid);kind=g.get('type')
        if 'construction' in g and type(g['construction']) is not bool:raise SketchError('Ungültige Hilfsgeometrie')
        if kind in ('rect','circle','arc','ellipse'):
            for key in ('x','y','a'):number(g.get(key))
            if g['a']<=1e-6:raise SketchError('Größe muss positiv sein')
            if kind in ('rect','ellipse'):
                if number(g.get('b'))<=1e-6:raise SketchError('Größe muss positiv sein')
                number(g.setdefault('angle',0))
            if kind=='arc':
                number(g.get('start'));sweep=number(g.get('sweep'))
                if not 1e-5<abs(sweep)<2*math.pi-1e-5:raise SketchError('Bogenwinkel muss zwischen 0 und 360 Grad liegen')
            if kind=='ellipse':
                number(g.setdefault('start',0));sw=number(g.setdefault('sweep',2*math.pi))
                if not 1e-5<abs(sw)<=2*math.pi+1e-9:raise SketchError('Ungültiger Ellipsenbogen')
            total+=7 if kind=='ellipse' else 5 if kind in ('rect','arc') else 3
        elif kind in ('polyline','spline'):
            if kind=='spline' and (len(g.get('points',[]))!=4 or g.get('closed') is not False):raise SketchError('Kubische Spline benötigt vier Kontrollpunkte')
            pts=g.get('points')
            if not isinstance(pts,list) or not 2<=len(pts)<=80 or type(g.get('closed')) is not bool:raise SketchError('Linienzug benötigt 2 bis 80 Punkte')
            if g['closed'] and len(pts)<3:raise SketchError('Geschlossenes Profil benötigt mindestens drei Punkte')
            names=set()
            for p in pts:
                pid=ident(p.get('id'))
                if pid in names:raise SketchError('Doppelte Punkt-ID')
                names.add(pid);number(p.get('x'));number(p.get('y'))
            total+=2*len(pts)
        else:raise SketchError('Unbekanntes Skizzenelement')
    if total>240:raise SketchError('Skizze zu groß: maximal 240 Geometrieparameter')
    seen=set()
    for d in ds:
        did=ident(d.get('id'))
        if did in seen:raise SketchError('Doppelte Maß-ID')
        seen.add(did);v=number(d.get('value'))
        if v<0:raise SketchError('Maß muss positiv oder null sein')
        if not isinstance(d.get('position'),list) or len(d['position'])!=2:raise SketchError('Maßposition fehlt')
        for x in d['position']:number(x)
        if d.get('kind')=='angle' and not 0<=v<=180:raise SketchError('Winkel muss zwischen 0° und 180° liegen')

RELATION_KINDS={'coincident','perpendicular','concentric','horizontal','vertical','equal','mirror','rotation','tangent'}

def validate_relations(f):
    relations=f.get('relations',[])
    if not isinstance(relations,list) or len(relations)>120:raise SketchError('Maximal 120 Bedingungen pro Skizze')
    ids=set()
    for r in relations:
        if not isinstance(r,dict) or r.get('kind') not in RELATION_KINDS:raise SketchError('Unbekannte Bedingung')
        if r.get('orientation',1) not in (-1,1):raise SketchError('Ungültige Bedingungsrichtung')
        rid=ident(r.get('id'))
        if rid in ids:raise SketchError('Doppelte Bedingungs-ID')
        ids.add(rid)
        keys=['first'] if r['kind'] in ('horizontal','vertical') else ['first','second']
        if r['kind']=='mirror':keys.append('axis')
        if r['kind']=='rotation':
            keys.append('center')
            if not 0<number(r.get('angle'))<360:raise SketchError('Rotationswinkel muss zwischen 0 und 360 Grad liegen')
        for k in keys:
            if not isinstance(r.get(k),dict):raise SketchError('Bedingungsreferenz fehlt')
        if not any(r[k].get('element') for k in keys):raise SketchError('Mindestens ein Skizzenelement auswählen')
        if 'second' in keys and r['first']==r['second']:raise SketchError('Zwei unterschiedliche Elemente auswählen')
        if 'position' in r:
            if not isinstance(r['position'],list) or len(r['position'])!=2:raise SketchError('Ungültige Symbolposition')
            for v in r['position']:number(v)

def relation_residuals(f,support):
    gs=f['geometry'];out=[]
    def ref(r):return geometry_ref(r,gs,support)
    for r in f.get('relations',[]):
        kind=r['kind']
        if kind in ('mirror','rotation'):
            a=next((g for g in gs if g['id']==r['first'].get('element')),None)
            b=next((g for g in gs if g['id']==r['second'].get('element')),None)
            if a is None or b is None or a['type']!=b['type']:raise SketchError('Gebundene Geometrie fehlt oder ist inkompatibel')
            if kind=='mirror':
                if r['axis'].get('element') in (a['id'],b['id']):raise SketchError('Spiegelachse muss unabhängig von den gespiegelten Elementen sein')
                typ,line=ref(r['axis'])
                if typ!='line':raise SketchError('Gerade Spiegelachse auswählen')
                u=direction(line);matrix=2*np.outer(u,u)-np.eye(2);origin=line[0]
            else:
                if r['center'].get('element') in (a['id'],b['id']):raise SketchError('Musterzentrum muss unabhängig von Original und Kopie sein')
                typ,origin=ref(r['center'])
                if typ!='point':raise SketchError('Mittelpunkt für das Muster auswählen')
                angle=math.radians(r['angle']);matrix=np.array([[math.cos(angle),-math.sin(angle)],[math.sin(angle),math.cos(angle)]])
            def mirrored(p):return origin+matrix@(p-origin)
            if a['type'] in ('polyline','spline'):
                if len(a['points'])!=len(b['points']) or a['closed']!=b['closed']:raise SketchError('Gebundene Linienzüge müssen dieselbe Punktanzahl haben')
                for pa,pb in zip(a['points'],b['points']):out.extend(np.array([pb['x'],pb['y']])-mirrored(np.array([pa['x'],pa['y']])))
            else:
                out.extend(np.array([b['x'],b['y']])-mirrored(np.array([a['x'],a['y']])))
                out.append(b['a']-a['a'])
                if a['type']=='arc':
                    for role in ('start','end'):out.extend(points(b)[role]-mirrored(points(a)[role]))
                    out.append(b['sweep']-a['sweep']*(-1 if kind=='mirror' else 1))
                if a['type'] in ('rect','ellipse'):
                    out.append(b['b']-a['b']);ua=np.array([math.cos(a['angle']),math.sin(a['angle'])]);ub=np.array([math.cos(b['angle']),math.sin(b['angle'])]);out.extend(10*(ub-matrix@ua))
            if a['type']=='ellipse':
                out.append(b['start']-a['start']*(-1 if kind=='mirror' else 1));out.append(b['sweep']-a['sweep']*(-1 if kind=='mirror' else 1))
            continue
        ta,a=ref(r['first'])
        if kind in ('horizontal','vertical'):
            if ta!='line':raise SketchError('Gerade Linie auswählen')
            out.append((a[1]-a[0])[1 if kind=='horizontal' else 0]);continue
        tb,b=ref(r['second'])
        if kind=='coincident':
            if ta=='point' and tb=='point':out.extend(a-b)
            else:
                if ta=='line' and tb=='point':ta,tb,a,b=tb,ta,b,a
                if ta!='point' or tb!='line':raise SketchError('Koinzidenz: zwei Punkte oder Punkt und Linie auswählen')
                u=direction(b);out.append(np.dot(a-b[0],[-u[1],u[0]]))
        elif kind=='perpendicular':
            if ta!= 'line' or tb!='line':raise SketchError('Rechtwinkligkeit benötigt zwei Linien')
            u=direction(a);v=direction(b);angle=math.atan2(u[0]*v[1]-u[1]*v[0],np.dot(u,v));target=math.pi/2*r.get('orientation',1)
            out.append(10*math.atan2(math.sin(angle-target),math.cos(angle-target)))
        elif kind=='tangent':
            if ta=='circle' and tb=='line':ta,tb,a,b=tb,ta,b,a
            if ta=='line' and tb=='circle':
                u=direction(a);normal=np.array([-u[1],u[0]])
                out.append(np.dot(np.array([b['x'],b['y']])-a[0],normal)-r.get('orientation',1)*b['a']/2)
            elif ta==tb=='circle':
                out.append(np.linalg.norm(np.array([a['x']-b['x'],a['y']-b['y']]))-(a['a']+b['a'])/2)
            else:raise SketchError('Tangentialität benötigt Linie und Kreis/Bogen oder zwei Kreise/Bögen')
        elif kind=='concentric':
            if ta!='circle' or tb!='circle':raise SketchError('Konzentrizität benötigt zwei Kreise')
            out.extend([a['x']-b['x'],a['y']-b['y']])
        elif kind=='equal':
            if ta==tb=='circle':out.append(a['a']-b['a'])
            elif ta==tb=='line':out.append(np.linalg.norm(a[1]-a[0])-np.linalg.norm(b[1]-b[0]))
            else:raise SketchError('Gleichheit benötigt zwei Linien oder zwei Kreise')
    return out

SIGNS={'bl':(-1,-1),'br':(1,-1),'tr':(1,1),'tl':(-1,1),'center':(0,0)}
ENDS={'bottom':('bl','br'),'right':('br','tr'),'top':('tl','tr'),'left':('bl','tl')}

def pack(gs):
    values=[];spec=[];lower=[];upper=[]
    for g in gs:
        fields=[(g,k) for k in ((('x','y','a','b','angle') if abs(g['sweep'])>2*math.pi-1e-5 else ('x','y','a','b','angle','start','sweep')) if g['type']=='ellipse' else ('x','y','a','b','angle') if g['type']=='rect' else ('x','y','a','start','sweep') if g['type']=='arc' else ('x','y','a'))] if g['type'] not in ('polyline','spline') else [(p,k) for p in g['points'] for k in ('x','y')]
        for obj,key in fields:
            spec.append((obj,key));values.append(obj[key]);lower.append(1e-5 if key in ('a','b') else (1e-5 if g.get('sweep',1)>0 else -2*math.pi+1e-5) if key=='sweep' else -10000);upper.append((2*math.pi-1e-5 if g.get('sweep',1)>0 else -1e-5) if key=='sweep' else 10000)
    return np.array(values,dtype=float),spec,(lower,upper)

def put(spec,x):
    for (obj,key),v in zip(spec,x):obj[key]=float(v)

def points(g):
    if g['type'] in ('polyline','spline'):return {p['id']:np.array([p['x'],p['y']]) for p in g['points']}
    center=np.array([g['x'],g['y']])
    if g['type']=='ellipse':
        ps={'center':center,'major':ellipse_point(g,0),'minor':ellipse_point(g,math.pi/2)}
        if abs(g['sweep'])<2*math.pi-1e-5:ps.update(start=ellipse_point(g,g['start']),end=ellipse_point(g,g['start']+g['sweep']))
        return ps
    if g['type']=='circle':return {'center':center}
    if g['type']=='arc':return {'center':center,**{role:center+g['a']/2*np.array([math.cos(t),math.sin(t)]) for role,t in [('start',g['start']),('end',g['start']+g['sweep'])]}}
    a=g.get('angle',0);rot=np.array([[math.cos(a),-math.sin(a)],[math.sin(a),math.cos(a)]])
    return {key:center+rot@np.array([sx*g['a']/2,sy*g['b']/2]) for key,(sx,sy) in SIGNS.items()}

def segments(g):
    ps=points(g)
    if g['type']=='rect':return {key:(ps[a],ps[b]) for key,(a,b) in ENDS.items()}
    if g['type'] in ('circle','arc','ellipse','spline'):return {}
    names=[p['id'] for p in g['points']]
    return {names[i]:(ps[names[i]],ps[names[(i+1)%len(names)]]) for i in range(len(names) if g['closed'] else len(names)-1)}

def geometry_ref(ref,gs,support):
    kind=ref.get('kind');role=ref.get('role')
    if kind=='fixed-point':
        p=ref.get('position')
        if not isinstance(p,list) or len(p)!=2:raise SketchError('Ungültiges Musterzentrum')
        return 'point',np.array([number(v) for v in p])
    if ref.get('external'):
        matches=[t for t in support.get('external',[]) if t['ref']==ref['external']]
        if len(matches)!=1:raise SketchError('Externe Referenzkante fehlt, ist mehrdeutig oder nicht mehr passend zur Skizzenebene. Bitte neu zuordnen.')
        t=matches[0]
        if kind=='circle' and t['type']=='circle':return 'circle',{'x':t['center'][0],'y':t['center'][1],'a':2*t['radius']}
        if kind=='edge' and t['type']=='line':return 'line',tuple(np.array(p) for p in t['points'])
        if kind=='point':
            if t['type']=='circle' and role=='center':return 'point',np.array(t['center'])
            if t['type']=='line':
                ids=[i for i,key in enumerate(t['vertices']) if key==ref.get('vertex')]
                if len(ids)==1:return 'point',np.array(t['points'][ids[0]])
        raise SketchError('Externer Punkt oder Kantentyp nicht mehr vorhanden')
    if kind=='origin':return 'point',np.zeros(2)
    if kind=='axis':
        if role not in ('horizontal','vertical'):raise SketchError('Unbekannte Achse')
        return 'line',(np.zeros(2),np.array([1.,0.]) if role=='horizontal' else np.array([0.,1.]))
    if kind in ('support-edge','support-point'):
        t=support['targets'].get(role)
        if not t:raise SketchError('Bemaßte Auflagekante fehlt')
        axis=0 if role in ('left','right') else 1
        ps=sorted(t['points'],key=lambda p:p[1-axis]);a,b=np.array(ps[0]),np.array(ps[-1])
        if kind=='support-point':
            if ref.get('endpoint') not in (0,1):raise SketchError('Ungültiger Endpunkt')
            return 'point',(a,b)[ref['endpoint']]
        return 'line',(a,b)
    g=next((g for g in gs if g['id']==ref.get('element')),None)
    if g is None:raise SketchError('Bemaßtes Skizzenelement fehlt')
    if kind=='point' and role in points(g):return 'point',points(g)[role]
    if kind=='edge' and role in segments(g):return 'line',segments(g)[role]
    if kind=='circle' and g['type'] in ('circle','arc'):return 'circle',g
    raise SketchError('Ungültige Geometriereferenz')

def direction(line):
    v=line[1]-line[0];length=np.linalg.norm(v)
    if length<1e-7:raise SketchError('Linie würde auf null schrumpfen')
    return v/length

def solve(f,support,drag=None):
    validate(f);gs=f['geometry'];ds=f.setdefault('dimensions',[]);original,spec,bounds=pack(gs)
    goal=original.copy();weights=np.ones(len(original));rigidity=[]
    if drag is not None:
        if not isinstance(drag,dict):raise SketchError('Ungültige Verschiebung')
        selected=next((g for g in gs if g['id']==drag.get('element')),None)
        if selected is None:raise SketchError('Zu verschiebendes Element fehlt')
        delta=drag.get('delta')
        if not isinstance(delta,list) or len(delta)!=2:raise SketchError('Verschiebung benötigt X und Y')
        dx,dy=map(number,delta);point=drag.get('point')
        if point is not None:
            if selected['type'] not in ('polyline','spline'):raise SketchError('Einzelne Eckpunkte können nur bei Linienzügen gezogen werden')
            moved=[p for p in selected['points'] if p['id']==point]
            if not moved:raise SketchError('Zu verschiebender Punkt fehlt')
        else:moved=selected['points'] if selected['type'] in ('polyline','spline') else [selected]
        weights[:]=.1
        for i,(obj,key) in enumerate(spec):
            if any(obj is p for p in moved) and key in ('x','y'):
                goal[i]+=dx if key=='x' else dy;weights[i]=1
        if point is None:
            if selected['type'] in ('polyline','spline'):
                indices={id(obj):{} for obj in moved}
                for i,(obj,key) in enumerate(spec):
                    if id(obj) in indices:indices[id(obj)][key]=i
                first=indices[id(moved[0])]
                for p in moved[1:]:
                    for key in ('x','y'):rigidity.append((indices[id(p)][key],first[key]))
            else:
                for i,(obj,key) in enumerate(spec):
                    if obj is selected and key not in ('x','y'):rigidity.append((i,None))
    def rigid_residual(x):
        return np.array([x[i]-original[i] if j is None else (x[i]-x[j])-(original[i]-original[j]) for i,j in rigidity])
    def residual(x):
        put(spec,x);out=[]
        for d in ds:
            kind=d['kind'];value=d['value']
            if not (d.get('element') or d.get('first',{}).get('element') or d.get('second',{}).get('element')):raise SketchError('Mindestens ein Skizzenelement für das Maß auswählen')
            if kind in ('diameter','radius'):
                _,g=geometry_ref({'kind':'circle','element':d.get('element')},gs,support);out.append(g['a']-(2*value if kind=='radius' else value));continue
            a,va=geometry_ref(d['first'],gs,support)
            if kind=='length':
                if a!='line':raise SketchError('Längenmaß benötigt eine Linie')
                out.append(np.linalg.norm(va[1]-va[0])-value);continue
            b,vb=geometry_ref(d['second'],gs,support)
            if kind=='angle':
                if a!='line' or b!='line':raise SketchError('Winkel benötigt zwei gerade Linien oder Achsen')
                flips=[d.get('flipFirst',1),d.get('flipSecond',1)]
                if any(v not in (-1,1) for v in flips):raise SketchError('Ungültiger Winkelsektor')
                u=direction(va)*flips[0];v=direction(vb)*flips[1];sign=d.get('sign',1)
                if sign not in (-1,1):raise SketchError('Ungültige Winkelrichtung')
                target=math.radians(value)*sign
                out.extend([10*(np.dot(u,v)-math.cos(target)),10*(u[0]*v[1]-u[1]*v[0]-math.sin(target))]);continue
            if kind=='linear':
                axis=d.get('axis');sign=d.get('sign')
                if axis not in ('x','y') or sign not in (-1,1):raise SketchError('Ungültige Maßrichtung')
                i=0 if axis=='x' else 1
                def coordinate(typ,val):
                    if typ=='point':return val[i]
                    if typ=='line':
                        # Also constrain the selected line to remain parallel to the axis.
                        out.append((val[1]-val[0])[i]);return (val[0][i]+val[1][i])/2
                    raise SketchError('Kreismittelpunkt für Abstände auswählen')
                ca=coordinate(a,va);cb=coordinate(b,vb);out.append(cb-ca-sign*value);continue
            if kind=='distance':
                if a=='point' and b=='point':
                    if value==0:out.extend(vb-va)
                    else:out.append(np.linalg.norm(vb-va)-value)
                else:
                    if a=='line' and b=='point':a,b,va,vb=b,a,vb,va
                    if b!='line':raise SketchError('Abstand benötigt Punkte oder gerade Linien')
                    u=direction(vb);normal=np.array([-u[1],u[0]])
                    if a=='line':
                        v=direction(va);out.append(10*(v[0]*u[1]-v[1]*u[0]));p=(va[0]+va[1])/2
                    elif a=='point':p=va
                    else:raise SketchError('Kreismittelpunkt für Abstände auswählen')
                    sign=d.get('sign',1)
                    if sign not in (-1,1):raise SketchError('Ungültige Abstandsrichtung')
                    out.append(np.dot(p-vb[0],normal)-sign*value)
                continue
            raise SketchError('Unbekannter Maßtyp')
        out.extend(relation_residuals(f,support))
        return np.array(out)
    try:
        if ds or f.get('relations'):
            initial=residual(original)
            if not np.all(np.isfinite(initial)):raise SketchError('Ungültige Bemaßung')
            # A tiny regularizer chooses the nearest solution in the nullspace.
            # Without it, bounded TRF can move wholly unrelated free geometry.
            x=original
            # First follow the pointer, then project back onto the constraints.
            # Staging avoids slow motion along curved constraint manifolds.
            for strength in ([1e-2,1e-4,1e-6] if drag or f.get('relations') else [1e-6]):
                def objective(x):return np.r_[residual(x),rigid_residual(x),strength*weights*(x-goal)]
                result=least_squares(objective,x,bounds=bounds,ftol=1e-12,xtol=1e-12,gtol=1e-14 if drag else 1e-12,max_nfev=350)
                x=result.x
            if np.max(np.abs(np.r_[residual(result.x),rigid_residual(result.x)]))>1e-6:raise SketchError('Widersprüchliche Bemaßung oder keine Lösung in dieser Lage. Vorhandene Maße ändern oder löschen.')
            x=result.x;J=result.jac[:len(initial)]
        else:
            x=goal
            if np.any(x<np.array(bounds[0])) or np.any(x>np.array(bounds[1])):raise SketchError('Verschiebung außerhalb des Zeichenbereichs')
            J=np.empty((0,len(x)))
        put(spec,x)
        # Nullspace describes remaining motion, including rigid rotation.
        _,s,v=np.linalg.svd(J,full_matrices=True);rank=int(np.sum(s>1e-7));null=v[rank:].T
        states={}
        def status(observe):
            base=np.array(observe());derivative=np.empty((len(base),len(x)))
            for i in range(len(x)):
                step=1e-5;trial=x.copy();trial[i]+=step;put(spec,trial);derivative[:,i]=(np.array(observe())-base)/step
            put(spec,x);motion=derivative@null
            if np.linalg.norm(motion)<1e-6:return 'fixed'
            # Compare rank of remaining motion to unconstrained observable motion.
            return 'partial' if np.linalg.matrix_rank(motion,tol=1e-6)<np.linalg.matrix_rank(derivative,tol=1e-6) else 'free'
        for g in gs:
            states[g['id']]={'points':{},'edges':{}}
            for role in points(g):states[g['id']]['points'][role]=status(lambda g=g,r=role:points(g)[r])=='fixed'
            if g['type'] in ('circle','arc'):states[g['id']]['edges']['circle']=status(lambda g=g:[g['x'],g['y'],g['a']]+([g['start'],g['sweep']] if g['type']=='arc' else []))
            elif g['type'] in ('ellipse','spline'):states[g['id']]['edges']['curve']=status(lambda g=g:pack([g])[0])
            else:
                for role in segments(g):states[g['id']]['edges'][role]=status(lambda g=g,r=role:np.concatenate(segments(g)[r]))
            for a,b in segments(g).values():
                if np.linalg.norm(b-a)<1e-5:raise SketchError('Profil enthält eine Linie ohne Länge')
        return {'dof':len(x)-rank,'fully':rank==len(x),'elements':states}
    except Exception:
        put(spec,original);raise

def revolve_axis(f):
    ref=f.get('revolveAxis')
    if not isinstance(ref,dict) or ref.get('external'):raise SketchError('Rotationsachse fehlt')
    if ref.get('kind')=='edge':
        g=next((g for g in f.get('geometry',[]) if g['id']==ref.get('element')),None)
        if not g or not g.get('construction') or g['type'] not in ('polyline','spline'):raise SketchError('Rotationsachse muss eine Skizzenachse oder Hilfslinie sein')
    elif ref.get('kind')!='axis':raise SketchError('Ungültige Rotationsachse')
    kind,(a,b)=geometry_ref(ref,f.get('geometry',[]),{})
    if kind!='line' or np.linalg.norm(b-a)<1e-7:raise SketchError('Rotationsachse hat keine Länge')
    return a,b

def arc_point(g,t):
    return np.array([g['x']+g['a']/2*math.cos(t),g['y']+g['a']/2*math.sin(t)])

def arc_contains(g,t):
    distance=((t-g['start'])*(1 if g['sweep']>0 else -1))%(2*math.pi)
    return distance<=abs(g['sweep'])+1e-9

def arc_extrema(g,normal):
    angle=math.atan2(normal[1],normal[0])
    ts=[g['start'],g['start']+g['sweep']]+[t for t in [angle,angle+math.pi] if arc_contains(g,t)]
    return [arc_point(g,t) for t in ts]


def ellipse_point(g,t):
    a=g.get('angle',0);x=g['a']/2*math.cos(t);y=g['b']/2*math.sin(t)
    return np.array([g['x']+x*math.cos(a)-y*math.sin(a),g['y']+x*math.sin(a)+y*math.cos(a)])

def bezier_point(g,t):
    p=np.array([[p['x'],p['y']] for p in g['points']],dtype=float)
    while len(p)>1:p=(1-t)*p[:-1]+t*p[1:]
    return p[0]

def curve_extrema(g,normal):
    if g['type']=='ellipse':
        a=g['angle'];u=np.array([math.cos(a),math.sin(a)])*g['a']/2;v=np.array([-math.sin(a),math.cos(a)])*g['b']/2
        t=math.atan2(np.dot(v,normal),np.dot(u,normal))
        ts=[g['start'],g['start']+g['sweep']]+[x for x in (t,t+math.pi) if arc_contains(g,x)]
        return [ellipse_point(g,x) for x in ts]
    p=np.array([np.dot([p['x'],p['y']],normal) for p in g['points']]);d=np.diff(p)
    roots=np.roots([d[0]-2*d[1]+d[2],2*(d[1]-d[0]),d[0]])
    return [bezier_point(g,t) for t in [0,1]+[float(r.real) for r in roots if abs(r.imag)<1e-9 and 0<r.real<1]]

def curve_edge(g,world,n):
    if g['type']=='spline':return cq.Edge.makeBezier([world((p['x'],p['y'])) for p in g['points']])
    # Exact conic with an explicitly oriented local frame; supports either semiaxis order.
    from OCP.Geom import Geom_Ellipse, Geom_TrimmedCurve
    from OCP.gp import gp_Ax2
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    a=g['angle'];start=g['start'];sweep=g['sweep'];ra=g['a']/2;rb=g['b']/2
    if rb>ra:ra,rb=rb,ra;a+=math.pi/2;start-=math.pi/2
    direction=world((math.cos(a),math.sin(a)))-world((0,0))
    curve=Geom_Ellipse(gp_Ax2(gp_Pnt(*world((g['x'],g['y'])).toTuple()),gp_Dir(*n.toTuple()),gp_Dir(*direction.toTuple())),ra,rb)
    if abs(sweep)>2*math.pi-1e-5:return cq.Edge(BRepBuilderAPI_MakeEdge(curve).Edge())
    # Reversal is geometric traversal only; assembled wires restore contour orientation.
    lo=min(start,start+sweep);hi=max(start,start+sweep)
    return cq.Edge(BRepBuilderAPI_MakeEdge(Geom_TrimmedCurve(curve,lo,hi)).Edge())

def profile_loops(gs,world,n):
    """Join open lines/arcs by coincident endpoints; never bridge gaps silently.
    Stable edge ownership survives mixed contour assembly and boolean history.
    """
    loops=[];open_edges=[]
    def add_loop(records,wire=None):
        if wire is None:wire=cq.Wire.assembleEdges([edge for _,_,edge in records])
        if not wire.IsClosed():raise SketchError('Profil ist offen: Endpunkte mit Koinzidenz verbinden')
        actual=wire.Edges();mapped=[];used=[]
        for owner,role,source in records:
            matches=[]
            for edge in actual:
                if edge.geomType()!=source.geomType() or abs(edge.Length()-source.Length())>1e-6:continue
                if (edge.Center()-source.Center()).Length>1e-6:continue
                a=[v.Center() for v in edge.Vertices()];b=[v.Center() for v in source.Vertices()]
                if len(a)==len(b) and all(any((p-q).Length<1e-6 for q in b) for p in a):matches.append(edge)
            if len(matches)!=1 or any(matches[0].isSame(e) for e in used):raise SketchError('Profilkante ist doppelt oder nicht eindeutig zuordenbar')
            used.append(matches[0]);mapped.append((owner,role,matches[0]))
        face=cq.Face.makeFromWires(wire)
        if not face.isValid() or face.Area()<1e-7:raise SketchError('Profil kreuzt sich selbst oder besitzt keine gültige Fläche')
        # Stable cap ownership independent of the order of geometry elements.
        owner=min((g for g,_,_ in records),key=lambda g:g['id'])
        loops.append({'g':owner,'wire':wire,'face':face,'edges':mapped,'parent':None})
    for g in gs:
        if g['type']=='circle':
            w=cq.Wire.makeCircle(g['a']/2,world((g['x'],g['y'])),n);add_loop([(g,'wall',w.Edges()[0])],w)
        elif g['type'] in ('ellipse','spline'):
            edge=curve_edge(g,world,n)
            if g['type']=='ellipse' and abs(g['sweep'])>2*math.pi-1e-5:add_loop([(g,'wall',edge)])
            else:open_edges.append((g,'wall',edge))
        elif g['type']=='arc':
            edge=cq.Edge.makeThreePointArc(world(arc_point(g,g['start'])),world(arc_point(g,g['start']+g['sweep']/2)),world(arc_point(g,g['start']+g['sweep'])))
            open_edges.append((g,'wall',edge))
        else:
            records=[(g,role,cq.Edge.makeLine(world(a),world(b))) for role,(a,b) in segments(g).items()]
            if g['type']=='rect' or g['closed']:add_loop(records)
            else:open_edges.extend(records)
    if open_edges:
        vertices=[];ends=[];adj={}
        for index,(_,_,edge) in enumerate(open_edges):
            pair=[]
            for vertex in edge.Vertices():
                p=vertex.Center();matches=[k for k,q in enumerate(vertices) if (p-q).Length<1e-6]
                if len(matches)>1:raise SketchError('Profilendpunkte sind mehrdeutig')
                if matches:k=matches[0]
                else:k=len(vertices);vertices.append(p)
                pair.append(k);adj.setdefault(k,[]).append(index)
            if len(pair)!=2 or pair[0]==pair[1]:raise SketchError('Ungültige offene Profilkante')
            ends.append(pair)
        if any(len(v)!=2 for v in adj.values()):raise SketchError('Profil ist offen oder verzweigt: Jedes Ende muss genau zwei Kanten verbinden')
        remaining=set(range(len(open_edges)))
        while remaining:
            stack=[min(remaining)];component=[]
            while stack:
                i=stack.pop()
                if i not in remaining:continue
                remaining.remove(i);component.append(open_edges[i]);stack.extend(j for v in ends[i] for j in adj[v] if j in remaining)
            add_loop(component)
    return loops


def make_tool(f,frame):
    gs=[g for g in f['geometry'] if not g.get('construction')];origin=cq.Vector(*frame['o']);u=cq.Vector(*frame['u']);v=cq.Vector(*frame['v']);n=cq.Vector(*frame['n'])
    mirrored=f['op'] in ('pad','pocket') and bool(f.get('symmetric'))
    sign=-1 if (f['op']=='pocket')!=(bool(f.get('reverse')) and not mirrored) else 1
    if mirrored:origin=origin-n*(sign*f['depth'])
    def world(p):return origin+u*float(p[0])+v*float(p[1])
    revolving=f['op'] in ('revolve','revolve-pocket')
    if revolving:
        axa,axb=revolve_axis(f);direction=(axb-axa)/np.linalg.norm(axb-axa);normal=np.array([-direction[1],direction[0]])
        distances=[]
        for g in gs:
            if g['type'] in ('ellipse','spline'):
                distances.extend(float(np.dot(p-axa,normal)) for p in curve_extrema(g,normal))
            elif g['type']=='arc':
                distances.extend(float(np.dot(p-axa,normal)) for p in arc_extrema(g,normal))
            elif g['type']=='circle':
                d=float(np.dot(np.array([g['x'],g['y']])-axa,normal));distances.extend([d-g['a']/2,d+g['a']/2])
            else:distances.extend(float(np.dot(pt-axa,normal)) for pt in points(g).values())
        if distances and min(distances)<-1e-7 and max(distances)>1e-7:raise SketchError('Das Profil muss auf einer Seite der Rotationsachse liegen; Berühren ist erlaubt.')
        axisworld=(world(axb)-world(axa)).normalized()*(-1 if f.get('reverse') else 1)
        axis=gp_Ax1(gp_Pnt(*world(axa).toTuple()),gp_Dir(*axisworld.toTuple()))
    loops=profile_loops(gs,world,n)
    # Disjoint or strictly nested contours only; exact planar booleans catch crossing.
    for i,a in enumerate(loops):
        containers=[]
        for j,b in enumerate(loops):
            if i==j:continue
            if a['wire'].distance(b['wire'])<1e-6:raise SketchError('Konturen dürfen sich nicht berühren oder kreuzen')
            op=BRepAlgoAPI_Common(a['face'].wrapped,b['face'].wrapped);op.SetNonDestructive(True);op.Build()
            if not op.IsDone():raise SketchError('Konturen konnten nicht geprüft werden')
            area=cq.Shape.cast(op.Shape()).Area();aa=a['face'].Area();bb=b['face'].Area()
            if area<1e-7:continue
            if abs(area-aa)<max(1e-6,aa*1e-8) and aa<bb:containers.append(j)
            elif abs(area-bb)>=max(1e-6,bb*1e-8):raise SketchError('Überlappende Konturen: Überschneidungen entfernen')
        if containers:a['parent']=min(containers,key=lambda j:loops[j]['face'].Area())
    def depth(i):
        p=loops[i]['parent'];return 0 if p is None else 1+depth(p)
    solids=[];registry={}
    def entry(key,faces,label,g):
        center=np.array([g['x'],g['y']]) if g['type'] not in ('polyline','spline') else np.mean(list(points(g).values()),axis=0)
        registry[key]={'faces':faces,'anchor':list(world(center).toTuple()),'u':list(frame['u']),'label':label}
    for i,a in enumerate(loops):
        if depth(i)%2:continue
        holes=[b for b in loops if b['parent']==i]
        face=cq.Face.makeFromWires(a['wire'],[b['wire'] for b in holes])
        if not face.isValid():raise SketchError('Ungültige Kontur mit Aussparung')
        # Copy preserves Generated history for planar radial edges in full revolutions.
        if revolving:op=BRepPrimAPI_MakeRevol(face.wrapped,axis,float(f['revolveAngle'])*np.pi/180,True)
        else:
            vector=n*(sign*f['depth']*(2 if mirrored else 1));op=BRepPrimAPI_MakePrism(face.wrapped,gp_Vec(*vector.toTuple()),False,True)
        op.Build()
        if not op.IsDone():raise SketchError('Volumenkörper konnte nicht erzeugt werden')
        solid=cq.Shape.cast(op.Shape())
        if not solid.isValid() or not solid.Solids() or solid.Volume()<1e-8:raise SketchError('Erzeugter Volumenkörper ist ungültig')
        solids.extend(solid.Solids())
        prefix=f['id']+('/' if a['g']['id']=='legacy' else '/g-'+a['g']['id']+'/')
        for role,shape in [('start',op.FirstShape()),('end',op.LastShape())]:
            faces=[ff for ff in solid.Faces() if not shape.IsNull() and ff.wrapped.IsSame(shape)]
            if faces:entry(prefix+role,faces,f.get('name','Skizze')+' · '+role,a['g'])
        for loop in [a]+holes:
            for owner,role,edge in loop['edges']:
                prefix=f['id']+('/' if owner['id']=='legacy' else '/g-'+owner['id']+'/' )
                generated=list(op.Generated(edge.wrapped));faces=[ff for ff in solid.Faces() if any(ff.wrapped.IsSame(x) for x in generated)]
                if not faces and revolving and edge.geomType()=='LINE' and all((vertex.Center()-world(axa)).cross(axisworld).Length<1e-7 for vertex in edge.Vertices()):continue
                if not faces:raise SketchError('Seitenfläche konnte nicht ihrem Skizzensegment zugeordnet werden')
                entry(prefix+role,faces,f.get('name','Skizze')+' · '+role,owner)
    if not solids:raise SketchError('Keine geschlossene Kontur vorhanden')
    return (solids[0] if len(solids)==1 else cq.Compound.makeCompound(solids)),registry
