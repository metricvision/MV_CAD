"""CAD-independent forward kinematics for rooted joint trees. Units: mm, degrees."""
import math
import numpy as np
from scipy.spatial.transform import Rotation

class AssemblyError(ValueError):pass

def number(v,label='Wert',limit=1000000):
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>limit:raise AssemblyError(label+': ungültige Zahl')
    return float(v)

def vector(v,label):
    if not isinstance(v,list) or len(v)!=3:raise AssemblyError(label+': drei Zahlen erforderlich')
    return [number(x,label) for x in v]

def pose_matrix(pose):
    if not isinstance(pose,dict):raise AssemblyError('Ungültige Position')
    t=np.eye(4);t[:3,3]=vector(pose.get('position',[0,0,0]),'Position')
    t[:3,:3]=Rotation.from_euler('xyz',vector(pose.get('rotation',[0,0,0]),'Drehung'),degrees=True).as_matrix()
    return t

def matrix_pose(t):
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',UserWarning)
        angles=Rotation.from_matrix(t[:3,:3]).as_euler('xyz',degrees=True).tolist()
    return {'position':t[:3,3].tolist(),'rotation':angles}

def solve(instances,joints,frames):
    """Frames keyed by (joint id, parent/child), all expressed in part coordinates."""
    nodes={i['id']:i for i in instances};incoming={};outgoing={i:[] for i in nodes}
    for j in joints:
        parent,child=j['parent'],j['child']
        if parent not in nodes or child not in nodes or parent==child:raise AssemblyError('Gelenk benötigt zwei unterschiedliche vorhandene Instanzen')
        if child in incoming:raise AssemblyError('Pro Instanz ist nur ein eingehendes Gelenk erlaubt. Geschlossene Ketten werden noch nicht unterstützt.')
        if nodes[child].get('fixed'):raise AssemblyError('Ein fixiertes Teil kann kein bewegtes/gebundenes Kind sein. Zuerst Fixierung lösen.')
        incoming[child]=j;outgoing[parent].append(j)
    roots=[i for i in nodes if i not in incoming];matrices={};active=set()
    def visit(id,t):
        if id in active or id in matrices:raise AssemblyError('Geschlossene Gelenkketten werden noch nicht unterstützt')
        active.add(id);matrices[id]=t
        for j in outgoing[id]:
            motion=np.eye(4);value=j.get('value',0)
            if j['type']=='revolute':motion[:3,:3]=Rotation.from_euler('z',value,degrees=True).as_matrix()
            elif j['type']=='slider':motion[2,3]=value
            a=frames[(j['id'],'parent')];b=frames[(j['id'],'child')]
            visit(j['child'],t@a@motion@np.linalg.inv(b))
        active.remove(id)
    for id in roots:visit(id,pose_matrix(nodes[id].get('pose',{})))
    if len(matrices)!=len(nodes):raise AssemblyError('Geschlossene Gelenkkette erkannt. Ein Gelenk entfernen.')
    dof=sum(6 for id in roots if not nodes[id].get('fixed'))+sum(j['type']!='fixed' for j in joints)
    return {'transforms':{id:t.tolist() for id,t in matrices.items()},'poses':{id:matrix_pose(t) for id,t in matrices.items()},'roots':roots,'dof':dof}


def solve_constraints(instances,joints,frames,constraints,reference_frames,drag=None,drive=None):
    """Solve remaining root/joint coordinates, preserving exact joint-tree kinematics.

    Surface constraints are hard within 1e-5 mm / 1e-6 direction tolerance.
    Drag targets and proximity to the previous solution are soft objectives.
    Nothing is committed when the hard residual fails validation.
    """
    import copy
    from scipy.optimize import least_squares
    base=solve(instances,joints,frames)
    nodes={i['id']:i for i in instances}
    initial={k:np.array(t) for k,t in base['transforms'].items()}
    movable=[k for k in base['roots'] if not nodes[k].get('fixed')]
    active=[j for j in joints if j['type']!='fixed' and (not drive or j['id']!=drive['joint'])]
    # A directed normal alignment seed avoids the stationary antiparallel case.
    seeds={k:initial[k].copy() for k in movable}
    for c in constraints:
        child=c['child']
        if child not in seeds:continue
        a=seeds.get(c['parent'],initial[c['parent']])@reference_frames[(c['id'],'parent')]
        b=seeds[child]@reference_frames[(c['id'],'child')]
        n=a[:3,2]*(-1 if c.get('opposed',False) else 1);v=b[:3,2]
        axis=np.cross(v,n);s=np.linalg.norm(axis);cos=np.clip(np.dot(v,n),-1,1)
        if s>1e-10:r=Rotation.from_rotvec(axis/s*math.atan2(s,cos)).as_matrix()
        elif cos<0:
            axis=b[:3,0];r=Rotation.from_rotvec(axis*math.pi).as_matrix()
        else:r=np.eye(3)
        if cos<.999999:
            pivot=b[:3,3].copy();t=seeds[child];t[:3,3]=pivot+r@(t[:3,3]-pivot);t[:3,:3]=r@t[:3,:3]
    nroots=len(movable);x0=np.zeros(6*nroots+len(active));lower=np.full(len(x0),-np.inf);upper=-lower
    for k,j in enumerate(active):
        index=6*nroots+k;x0[index]=j['value']
        if j.get('limits'):lower[index],upper[index]=j['limits']
    inverse_frames={j['id']:np.linalg.inv(frames[(j['id'],'child')]) for j in joints}
    children={i['id']:[] for i in instances}
    for j in joints:children[j['parent']].append(j)
    def evaluate(x):
        roots={k:initial[k] for k in base['roots']};values={j['id']:j['value'] for j in joints}
        for k,key in enumerate(movable):
            t=seeds[key].copy();t[:3,3]+=x[k*6:k*6+3]
            t[:3,:3]=Rotation.from_rotvec(x[k*6+3:k*6+6]/10).as_matrix()@t[:3,:3];roots[key]=t
        for k,j in enumerate(active):values[j['id']]=x[6*nroots+k]
        if drive:values[drive['joint']]=drive['value']
        result={}
        def visit(key,t):
            result[key]=t
            for j in children[key]:
                m=np.eye(4)
                if j['type']=='revolute':m[:3,:3]=Rotation.from_euler('z',values[j['id']],degrees=True).as_matrix()
                elif j['type']=='slider':m[2,3]=values[j['id']]
                visit(j['child'],t@frames[(j['id'],'parent')]@m@inverse_frames[j['id']])
        for key,t in roots.items():visit(key,t)
        return result,values
    def hard(x):
        transforms,_=evaluate(x);out=[]
        for c in constraints:
            a=transforms[c['parent']]@reference_frames[(c['id'],'parent')]
            b=transforms[c['child']]@reference_frames[(c['id'],'child')]
            n=a[:3,2];delta=b[:3,3]-a[:3,3]
            out.extend(10*(b[:3,2]-n*(-1 if c.get('opposed',False) else 1)))
            if c['type']=='offset':out.append(float(np.dot(delta,n)-c['offset']))
            else:out.extend(delta-n*np.dot(delta,n))
        return np.array(out,dtype=float)
    def residual(x):
        pieces=[hard(x)]
        if drag:
            t,_=evaluate(x);pieces.append((t[drag['instance']][:3,3]-np.array(drag['position']))*1e-4)
        pieces.append((x-x0)*(1e-8 if drag else 1e-6))
        return np.concatenate(pieces)
    if len(x0):
        fit=least_squares(residual,x0,bounds=(lower,upper),max_nfev=240,ftol=1e-12,xtol=1e-12,gtol=1e-13)
        x=fit.x
    else:x=x0
    error=hard(x)
    if error.size and np.max(np.abs(error))>1e-5:
        raise AssemblyError('Bedingungen widersprechen sich oder konnten nicht gelöst werden. Abstand, Flächenausrichtung und Fixierungen prüfen. Keine Änderung übernommen.')
    transforms,values=evaluate(x)
    rank=0
    if len(x) and error.size:
        jac=np.empty((len(error),len(x)))
        for k in range(len(x)):
            step=1e-5;plus=x.copy();minus=x.copy();plus[k]+=step;minus[k]-=step
            jac[:,k]=(hard(plus)-hard(minus))/(2*step)
        rank=int(np.linalg.matrix_rank(jac,tol=1e-6))
    solved_instances=copy.deepcopy(instances);solved_joints=copy.deepcopy(joints)
    for i in solved_instances:i['pose']=matrix_pose(transforms[i['id']])
    for j in solved_joints:j['value']=float(values[j['id']])
    return {'transforms':{k:t.tolist() for k,t in transforms.items()},'poses':{k:matrix_pose(t) for k,t in transforms.items()},'roots':base['roots'],'dof':max(0,len(x)-rank),'instances':solved_instances,'joints':solved_joints}
