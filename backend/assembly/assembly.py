"""Assembly documents and service functions, isolated from Part Design internals."""
import copy
import numpy as np
from .assembly_solver import AssemblyError,number,vector,pose_matrix,solve,solve_constraints
from .assembly_parts import part_asset,frame_matrix

def ident(v):
    if not isinstance(v,str) or not v or len(v)>100:raise AssemblyError('Ungültige ID')
    return v

def validate(raw):
    if not isinstance(raw,dict) or raw.get('format')!='MetricCAD-assembly' or raw.get('version')!=1:raise AssemblyError('Keine MetricCAD-Baugruppe (Formatversion 1)')
    d=copy.deepcopy(raw)
    d.setdefault('constraints',[])
    d.pop('_drag',None);d.pop('_drive',None)
    for key,limit in [('parts',30),('instances',100),('joints',99),('constraints',200)]:
        if not isinstance(d.get(key),list) or len(d[key])>limit:raise AssemblyError(key+': ungültige Anzahl (max. '+str(limit)+')')
        ids=[]
        for x in d[key]:
            if not isinstance(x,dict):raise AssemblyError('Ungültiger Eintrag in '+key)
            ids.append(ident(x.get('id')))
            if 'name' in x and not isinstance(x['name'],str):raise AssemblyError('Name muss Text sein')
        if len(set(ids))!=len(ids):raise AssemblyError('Doppelte IDs in '+key)
    parts={p['id'] for p in d['parts']}
    for p in d['parts']:
        if not isinstance(p.get('document'),dict):raise AssemblyError('Teilprojekt fehlt')
    for i in d['instances']:
        if i.get('part') not in parts:raise AssemblyError('Teildefinition fehlt')
        if type(i.get('fixed',False)) is not bool:raise AssemblyError('Ungültige Fixierung')
        pose_matrix(i.get('pose',{}))
    for j in d['joints']:
        if j.get('type') not in ('fixed','revolute','slider'):raise AssemblyError('Unbekannter Gelenktyp')
        ident(j.get('parent'));ident(j.get('child'))
        for side in ('parentFrame','childFrame'):
            f=j.setdefault(side,{'origin':[0,0,0],'rotation':[0,0,0]})
            if not isinstance(f,dict):raise AssemblyError('Ungültiges Gelenkkoordinatensystem')
            if 'face' in f and (not isinstance(f['face'],str) or not f['face'] or len(f['face'])>1000):raise AssemblyError('Ungültige Fläche')
            for field in ('origin','offset','rotation'):
                if field in f:vector(f[field],field)
        j['value']=number(j.get('value',0),'Gelenkwert')
        if j['type']=='fixed' and j['value']!=0:raise AssemblyError('Starre Verbindung hat keinen Bewegungswert')
        limits=j.get('limits')
        if limits is not None:
            if not isinstance(limits,list) or len(limits)!=2:raise AssemblyError('Zwei Bewegungsgrenzen erforderlich')
            lo,hi=[number(v,'Grenze') for v in limits]
            if lo>=hi or not lo<=j['value']<=hi:raise AssemblyError('Gelenkwert außerhalb der Grenzen oder Grenzen ungültig')
    instances={i['id'] for i in d['instances']}
    for c in d['constraints']:
        if c.get('type') not in ('offset','concentric'):raise AssemblyError('Unbekannte Flächenbedingung')
        if c.get('parent') not in instances or c.get('child') not in instances or c['parent']==c['child']:raise AssemblyError('Bedingung benötigt zwei unterschiedliche Instanzen')
        if type(c.get('opposed',False)) is not bool:raise AssemblyError('Ungültige Flächenausrichtung')
        for side in ('parent','child'):
            face=c.get(side+'Face')
            if not isinstance(face,str) or not face or len(face)>1000:raise AssemblyError('Flächenreferenz fehlt')
        if c['type']=='offset':c['offset']=number(c.get('offset',0),'Flächenabstand')
    return d

def prepare(raw,include_mesh=False):
    d=validate(raw);assets={}
    for p in d['parts']:
        try:assets[p['id']]=part_asset(p['document'])
        except Exception as ex:raise AssemblyError('Teil '+p.get('name',p['id'])+': '+str(ex)) from ex
    instances={i['id']:i for i in d['instances']};frames={}
    for j in d['joints']:
        for side in ('parent','child'):
            i=instances.get(j[side])
            if i is None:raise AssemblyError('Gelenkinstanz fehlt')
            frames[(j['id'],side)]=frame_matrix(j[side+'Frame'],assets[i['part']])
    references={}
    for c in d['constraints']:
        for side in ('parent','child'):
            asset=assets[instances[c[side]]['part']];key=c[side+'Face'];datum=asset['datums'].get(key)
            expected='PLANE' if c['type']=='offset' else 'CYLINDER'
            if not datum or datum['type']!=expected:raise AssemblyError('Bedingungsreferenz fehlt oder hat falschen Flächentyp: '+key)
            references[(c['id'],side)]=frame_matrix({'face':key},asset)
    drag=raw.get('_drag');drive=raw.get('_drive')
    if drag is not None:
        if not isinstance(drag,dict) or drag.get('instance') not in instances:raise AssemblyError('Ungültiges Verschiebeziel')
        vector(drag.get('position'),'Verschiebeziel')
        if instances[drag['instance']].get('fixed'):raise AssemblyError('Fixierte Instanz kann nicht verschoben werden')
    if drive is not None:
        if not isinstance(drive,dict):raise AssemblyError('Ungültiger Gelenkantrieb')
        j=next((j for j in d['joints'] if j['id']==drive.get('joint')),None)
        if j is None or j['type']=='fixed':raise AssemblyError('Ungültiger Gelenkantrieb')
        value=number(drive.get('value'),'Gelenkantrieb')
        if j.get('limits') and not j['limits'][0]<=value<=j['limits'][1]:raise AssemblyError('Gelenkantrieb außerhalb der Grenzen')
    if d['constraints'] or drag or drive:
        result=solve_constraints(d['instances'],d['joints'],frames,d['constraints'],references,drag,drive)
        d['instances']=result.pop('instances');d['joints']=result.pop('joints')
        if drive:
            # Report geometric freedom, not the temporary drive lock.
            report=solve_constraints(d['instances'],d['joints'],frames,d['constraints'],references)
            result['dof']=report['dof']
    else:result=solve(d['instances'],d['joints'],frames)
    result['document']=d
    result['jointFrames']={j['id']:{side:frames[(j['id'],side)].tolist() for side in ('parent','child')} for j in d['joints']}
    if include_mesh:result['parts']={id:{'mesh':a['mesh'],'datums':a['datums']} for id,a in assets.items()}
    return result

def export_step(raw,path):
    import cadquery as cq
    from OCP.gp import gp_Trsf
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    r=prepare(raw);d=r['document'];assets={p['id']:part_asset(p['document']) for p in d['parts']};assembly=cq.Assembly(name='MetricCAD')
    if not d['instances']:raise AssemblyError('Baugruppe ist leer')
    for i in d['instances']:
        t=r['transforms'][i['id']];tr=gp_Trsf();tr.SetValues(*[t[row][col] for row in range(3) for col in range(4)])
        shape=cq.Shape.cast(BRepBuilderAPI_Transform(assets[i['part']]['body'].wrapped,tr,True).Shape());assembly.add(shape,name=i['id'])
    assembly.save(str(path),exportType='STEP')
