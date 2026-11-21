'use strict';
const $=id=>document.getElementById(id),clone=x=>structuredClone(x),uid=()=>crypto.randomUUID();
const fresh=()=>({format:'MetricCAD-assembly',version:1,parts:[],instances:[],joints:[],constraints:[]});
let doc=fresh(),assets={},solution={transforms:{},poses:{},roots:[],dof:0,jointFrames:{}},selected=null,selectedJoint=null,history=[],future=[],busy=false,fileAction='import',replacePart=null,pick=null,jointDraft=null,animation=null,motionBefore=null;
let constraintDraft=null,selectedConstraint=null,transformMode=null,hoverFace=null,dragState=null,previewQueue=null,previewTask=null,previewError=null,previewToken=0;
function status(s,error=false){$('status').textContent=s;$('status').className=error?'error':''}
async function request(path,payload){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!r.ok){const x=await r.json();throw Error(x.error||'Berechnung fehlgeschlagen')}return r}
async function commit(candidate,withMeshes=false,record=true){if(busy||animation||dragState)return false;busy=true;renderControls();status('Baugruppe wird berechnet …');try{const r=await(await request(withMeshes?'/assembly/build':'/assembly/solve',candidate)).json();if(record){history.push(JSON.stringify(doc));if(history.length>40)history.shift();future=[]}doc=r.document;solution=r;if(r.parts){assets=r.parts;prepareBuffers()}selected=doc.instances.some(i=>i.id===selected)?selected:null;selectedJoint=doc.joints.some(j=>j.id===selectedJoint)?selectedJoint:null;jointDraft=null;constraintDraft=null;pick=null;render();status('Aktuell · '+r.dof+' freie Bewegungsparameter');return true}catch(e){status(e.message,true);return false}finally{busy=false;render()}}
function download(data,name,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function el(tag,text,parent){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(parent)parent.append(e);return e}
function button(parent,text,fn,cls=''){const b=el('button',text,parent);b.onclick=fn;b.className=cls;b.disabled=busy||!!animation;return b}
function note(parent,text){el('p',text,parent).className='hint'}
function textInput(parent,label,value){el('label',label,parent);const i=el('input',undefined,parent);i.value=value;return i}
function numberInput(parent,label,value){const i=textInput(parent,label,value);i.type='number';i.step='0.5';return i}
function vectorInput(parent,label,values){el('label',label,parent);const row=el('div',undefined,parent);row.className='row';return values.map((v,k)=>{const i=el('input',undefined,row);i.type='number';i.step='0.5';i.value=v;i.title=['X','Y','Z'][k];return i})}
function readVector(inputs){const v=inputs.map(i=>Number(i.value));if(!v.every(Number.isFinite))throw Error('Bitte drei gültige Zahlen eingeben.');return v}
function selectInput(parent,label,options,value){el('label',label,parent);const select=el('select',undefined,parent);for(const [val,name] of options){const o=el('option',name,select);o.value=val}select.value=value;return select}
const kinds={fixed:'Starre Verbindung',revolute:'Drehgelenk',slider:'Schubgelenk'};
function partOf(id){return doc.instances.find(i=>i.id===id)?.part}
function availableDatums(id){return assets[partOf(id)]?.datums||{}}
function keepPoses(candidate){for(const i of candidate.instances)if(solution.poses[i.id])i.pose=clone(solution.poses[i.id])}
function selectInstance(id){if(busy||animation||motionBefore)return;selected=id;selectedJoint=null;selectedConstraint=null;constraintDraft=null;jointDraft=null;pick=null;render()}
const foldedTreeRows = new Set();
const treeIcons = {
    assembly: 'M9 2h6v6H9z M12 8v4 M5 16v-4h14v4 M2 16h6v6H2z M16 16h6v6h-6z',
    part: 'M2 7l10-5 10 5-10 5z M2 7v10l10 5 10-5V7 M12 12v10',
    fixed: 'M5 10h14v12H5z M8 10V7a4 4 0 0 1 8 0v3',
    folder: 'M2 5h7l3 3h10v13H2z',
    link: 'M10 14l4-4 M8 10l-3 3a4 4 0 0 0 6 6l3-3 M10 8l3-3a4 4 0 0 1 6 6l-3 3'
};
function treeIcon(parent, name) {
    const icon = svg('svg', {viewBox:'0 0 24 24','aria-hidden':'true'}, '', parent);
    svg('path', {d:treeIcons[name]}, '', icon);
}
function treeRow(parent, label, icon, action, key, active=false) {
    const row = el('div', undefined, parent);
    row.className = 'model-row' + (active ? ' selected' : '');
    const open = !foldedTreeRows.has(key);
    function toggle() {
        if (open) foldedTreeRows.add(key);
        else foldedTreeRows.delete(key);
        renderTree();
    }
    if (key) {
        const arrow = button(row, open ? '⌄' : '›', toggle, 'tree-toggle');
        arrow.setAttribute('aria-expanded', String(open));
        arrow.setAttribute('aria-label', label + (open ? ' zuklappen' : ' aufklappen'));
    }
    const item = button(row, '', action || toggle, 'tree-label');
    if (treeIcons[icon]) treeIcon(item, icon);
    else item.append($(icon).querySelector('svg').cloneNode(true));
    el('span', label, item);
    item.title = label;
    return open;
}
function renderTree() {
    const tree = $('tree');
    tree.replaceChildren();
    const groups = new Map();
    for (const i of doc.instances) {
        if (!groups.has(i.part)) groups.set(i.part, []);
        groups.get(i.part).push(i);
    }
    const names = new Map(doc.instances.map(i => [i.id, i.name || i.id]));
    if (!groups.size) note(tree, 'Noch keine Teile eingefügt.');
    else if (treeRow(tree, doc.name || 'Baugruppe', 'assembly', null, 'root')) {
        const branch = el('div', undefined, tree);
        branch.className = 'model-branch';
        for (const instances of groups.values()) {
            const group = el('div', undefined, branch);
            if (instances.length > 1) {
                group.className = 'linked-instances';
                const bracket = el('div', undefined, group);
                bracket.className = 'instance-bracket';
                bracket.title = 'Instanzen derselben Teildefinition';
                treeIcon(bracket, 'link');
            }
            for (const [index, i] of instances.entries()) {
                const matches = r => r.parent === i.id || r.child === i.id;
                const constraints = (doc.constraints || []).filter(matches);
                const joints = doc.joints.filter(matches);
                const key = constraints.length || joints.length ? 'part:' + i.id : null;
                const open = treeRow(group, names.get(i.id), i.fixed ? 'fixed' : 'part',
                    () => selectInstance(i.id), key, selected === i.id);
                if (!open || !key) continue;
                // End the bracket at the final instance row, above its expanded children.
                const body = el('div', undefined, index === instances.length - 1 ? branch : group);
                body.className = 'model-children';
                const peer = r => names.get(r.parent === i.id ? r.child : r.parent);
                if (constraints.length && treeRow(body, 'Bedingungen', 'folder', null, 'mates:' + i.id)) {
                    const list = el('div', undefined, body);
                    list.className = 'model-children';
                    for (const c of constraints) {
                        const label = c.name || conditionNames[c.type];
                        const icon = label === 'Bündig' ? 'flushTool' : label === 'Senkrecht' ? 'rightAngleTool' : c.type + 'Tool';
                        treeRow(list, label + ' → ' + peer(c), icon, () => selectConstraint(c.id), null, selectedConstraint === c.id);
                    }
                }
                for (const j of joints) {
                    const icon = {fixed:'fixedJoint', revolute:'newJoint', slider:'sliderJoint'}[j.type];
                    treeRow(body, (j.name || kinds[j.type]) + ' → ' + peer(j), icon, () => editJoint(j.id), null, selectedJoint === j.id);
                }
            }
        }
    }
    const parts=$('parts');parts.replaceChildren();for(const p of doc.parts){const row=el('div',undefined,parts);note(row,p.name||p.id);button(row,'＋ Instanz',()=>addInstance(p.id));button(row,'Im Part Design bearbeiten ↗',()=>openPartEditor(p.id));button(row,'Teil aktualisieren …',()=>{replacePart=p.id;fileAction='replace';$('file').click()})}}
function addInstance(part){const d=clone(doc),n=d.instances.length;const id=uid();d.instances.push({id,part,name:(d.parts.find(p=>p.id===part)?.name||'Teil')+' · '+(n+1),pose:{position:[n?30:0,0,0],rotation:[0,0,0]},fixed:n===0});selected=id;commit(d).then(ok=>{if(ok)fit()})}
function renderProperties(){const pane=$('properties');pane.replaceChildren();if(constraintDraft){constraintEditor(pane);return}if(jointDraft){jointEditor(pane);return}if(selectedJoint){const j=doc.joints.find(j=>j.id===selectedJoint);if(j){editJoint(j.id);return}}const i=doc.instances.find(i=>i.id===selected);if(!i){note(pane,'Teil im Modell oder Baum anklicken. Für eine Bewegung anschließend ein Gelenk anlegen.');note(pane,'Die erste Instanz wird fixiert. Jede weitere Instanz kann unabhängig platziert oder als Kind eines Gelenks verbunden werden.');return}el('h3',i.name||'Instanz',pane);button(pane,'Im Part Design bearbeiten ↗',()=>openPartEditor(i.part),'primary');note(pane,'Bearbeitet die gemeinsame Teildefinition für '+doc.instances.filter(x=>x.part===i.part).length+' Instanz(en).');const incoming=doc.joints.find(j=>j.child===i.id);const name=textInput(pane,'Name',i.name||'');const pose=solution.poses[i.id]||i.pose||{position:[0,0,0],rotation:[0,0,0]};const pos=vectorInput(pane,'Position X / Y / Z (mm)',pose.position),rot=vectorInput(pane,'Drehung X / Y / Z (°)',pose.rotation);rot[0].id='rotationX';for(const x of [...pos,...rot])x.disabled=!!incoming||i.fixed;const fixed=el('label',undefined,pane),check=el('input',undefined,fixed);check.type='checkbox';check.checked=!!i.fixed;check.disabled=!!incoming;fixed.append(document.createTextNode(' Teil fixieren'));if(incoming)note(pane,'Position wird durch „'+(incoming.name||kinds[incoming.type])+'“ bestimmt.');button(pane,'Eigenschaften übernehmen',async()=>{try{const d=clone(doc),target=d.instances.find(x=>x.id===i.id);target.name=name.value;target.fixed=check.checked;if(!incoming&&!i.fixed)target.pose={position:readVector(pos),rotation:readVector(rot)};await commit(d)}catch(e){status(e.message,true)}},'primary');button(pane,'Gelenk mit diesem Teil …',()=>newJoint(i.id));button(pane,'Instanz entfernen',()=>{if(!confirm('Instanz und zugehörige Gelenke entfernen? Andere Teile bleiben in ihrer aktuellen Lage.'))return;const d=clone(doc);keepPoses(d);d.instances=d.instances.filter(x=>x.id!==i.id);d.joints=d.joints.filter(j=>j.parent!==i.id&&j.child!==i.id);d.constraints=(d.constraints||[]).filter(c=>c.parent!==i.id&&c.child!==i.id);commit(d)},'danger')}
function newJoint(child=selected,type='revolute'){if(busy||animation||motionBefore)return;constraintDraft=null;selectedConstraint=null;if(doc.instances.length<2){status('Zuerst mindestens zwei Instanzen einfügen.',true);return}const c=doc.instances.find(i=>i.id===child&&!i.fixed)||doc.instances.find(i=>!i.fixed);if(!c){status('Mindestens ein Teil muss beweglich sein: Fixierung lösen.',true);return}const p=doc.instances.find(i=>i.id!==c.id);jointDraft={id:uid(),name:kinds[type],type,parent:p.id,child:c.id,parentFrame:{origin:[0,0,0],rotation:[0,0,0]},childFrame:{origin:[0,0,0],rotation:[0,0,0]},value:0,limits:type==='slider'?[-20,20]:[-180,180]};transformMode=null;pick=null;selectedJoint=null;render()}
function editJoint(id){if(busy||animation||motionBefore)return;constraintDraft=null;selectedConstraint=null;const j=doc.joints.find(j=>j.id===id);if(!j)return;selectedJoint=id;selected=null;jointDraft=clone(j);pick=null;render()}
function frameEditor(parent,side){const j=jointDraft,frame=j[side+'Frame'];el('h3',side==='parent'?'Bezug am Elternteil':'Bezug am Kindteil',parent);const options=[['','Teilursprung / manuell'],...Object.entries(availableDatums(j[side])).map(([key,v])=>[key,(v.type==='CYLINDER'?'Zylinderachse · ':'Ebene · ')+v.label])];if(frame.face&&!options.some(x=>x[0]===frame.face))options.push([frame.face,'FEHLENDE REFERENZ: '+frame.face]);const pickSelect=selectInput(parent,'Koordinatensystem (Gelenkachse = lokales Z)',options,frame.face||'');pickSelect.onchange=()=>{j[side+'Frame']=pickSelect.value?{face:pickSelect.value,offset:[0,0,0],rotation:[0,0,0]}:{origin:[0,0,0],rotation:[0,0,0]};render()};button(parent,'Im Modell wählen',()=>{pick={side,instance:j[side]};$('pickHint').textContent=(side==='parent'?'Elternteil':'Kindteil')+': ebene oder zylindrische Fläche anklicken';draw()});const origin=vectorInput(parent,frame.face?'Lokaler Versatz X / Y / Z (mm)':'Lokaler Ursprung X / Y / Z (mm)',frame.offset||frame.origin||[0,0,0]);for(const i of origin)i.oninput=()=>{frame[frame.face?'offset':'origin']=origin.map(x=>Number(x.value))};const angles=vectorInput(parent,'Lokale Drehung X / Y / Z (°)',frame.rotation||[0,0,0]);for(const i of angles)i.oninput=()=>frame.rotation=angles.map(x=>Number(x.value));button(parent,'Achse umkehren (X +180°)',()=>{frame.rotation=[(frame.rotation?.[0]||0)+180,frame.rotation?.[1]||0,frame.rotation?.[2]||0];render()})}
function jointEditor(pane){const j=jointDraft;el('h3',selectedJoint?'Gelenk bearbeiten':'Neues Gelenk',pane);const name=textInput(pane,'Name',j.name||'');name.oninput=()=>j.name=name.value;const type=selectInput(pane,'Verbindung',Object.entries(kinds),j.type);type.onchange=()=>{j.type=type.value;j.value=0;j.limits=j.type==='slider'?[-20,20]:[-180,180];render()};for(const side of ['parent','child']){const sel=selectInput(pane,side==='parent'?'Elternteil':'Kindteil',doc.instances.map(i=>[i.id,i.name||i.id]),j[side]);sel.onchange=()=>{j[side]=sel.value;j[side+'Frame']={origin:[0,0,0],rotation:[0,0,0]};render()}}note(pane,'Bezugssysteme werden deckungsgleich ausgerichtet. Drehung erfolgt um Z, Verschiebung entlang Z. Über lokale Versätze lassen sich Abstand und Orientierung vorgeben.');frameEditor(pane,'parent');frameEditor(pane,'child');if(j.type!=='fixed'){const unit=j.type==='revolute'?'°':'mm';const value=numberInput(pane,'Stellung ('+unit+')',j.value);value.oninput=()=>j.value=Number(value.value);const lo=numberInput(pane,'Untere Grenze ('+unit+')',j.limits?.[0]??-180),hi=numberInput(pane,'Obere Grenze ('+unit+')',j.limits?.[1]??180);for(const i of [lo,hi])i.oninput=()=>j.limits=[Number(lo.value),Number(hi.value)]}button(pane,'Gelenk übernehmen',()=>{const d=clone(doc),index=d.joints.findIndex(x=>x.id===j.id),copy=clone(j);if(copy.type==='fixed'){copy.value=0;delete copy.limits}if(index<0)d.joints.push(copy);else d.joints[index]=copy;if(copy.type!=='fixed')d._drive={joint:copy.id,value:copy.value};commit(d).then(ok=>{if(ok){selectedJoint=null;render()}})},'primary');if(selectedJoint)button(pane,'Gelenk lösen',()=>{const d=clone(doc);keepPoses(d);d.joints=d.joints.filter(x=>x.id!==j.id);commit(d)},'danger');button(pane,'Abbrechen',()=>{jointDraft=null;selectedJoint=null;pick=null;render()})}
function renderMotion(){const select=$('motionJoint'),old=select.value;select.replaceChildren();for(const j of doc.joints.filter(j=>j.type!=='fixed')){const o=el('option',j.name||kinds[j.type],select);o.value=j.id}if([...select.options].some(o=>o.value===old))select.value=old;const j=doc.joints.find(j=>j.id===select.value),slider=$('motionSlider');$('motion').hidden=!j;if(j){const limits=j.limits||(j.type==='revolute'?[-180,180]:[-20,20]);slider.min=limits[0];slider.max=limits[1];slider.step='0.1';slider.value=j.value;$('motionValue').textContent=j.value.toFixed(1)+(j.type==='revolute'?'°':' mm')}}
function renderControls(){const locked=busy||!!animation||!!motionBefore;for(const b of document.querySelectorAll('button'))b.disabled=locked;$('stop').disabled=!animation;$('undo').disabled=locked||!history.length;$('redo').disabled=locked||!future.length;$('duplicate').disabled=$('copyPart').disabled=locked||!selected;for(const button of document.querySelectorAll('#assembly-tools [aria-label="Bedingungen"] button,#assembly-tools [aria-label="Gelenke"] button'))button.disabled=locked||doc.instances.length<2;
    const instance=doc.instances.find(i=>i.id===selected);
    $('rotateTool').disabled=locked||!instance||instance.fixed||doc.joints.some(j=>j.child===selected);
    $('motionJoint').disabled=locked;$('motionSlider').disabled=busy||!!animation;for(const i of document.querySelectorAll('#properties input,#properties select'))if(locked)i.disabled=true;}

function render(){renderTree();renderProperties();renderMotion();$('summary').textContent=doc.instances.length+' Instanzen · '+doc.joints.length+' Gelenke · '+(doc.constraints||[]).length+' Bedingungen · '+solution.dof+' Freiheitsgrade';$('empty').hidden=!!doc.instances.length;$('pickHint').textContent=pick?'Gewählte Instanz: Bezugfläche anklicken':' ';if(!pick)$('pickHint').textContent='';for(const mode of ['move','rotate']){const tool=$(mode+'Tool');tool.classList.toggle('active',transformMode===mode);tool.setAttribute('aria-pressed',String(transformMode===mode))}renderControls();draw()}
// Row-major rigid transforms. Shared convention with assembly_solver.py.
const identity=()=>[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
function mm(a,b){return a.map((row,i)=>row.map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0)))}
function inverse(t){const r=identity();for(let i=0;i<3;i++){for(let j=0;j<3;j++)r[i][j]=t[j][i];r[i][3]=-r[i].slice(0,3).reduce((s,v,k)=>s+v*t[k][3],0)}return r}
function transform(t,p){return t.slice(0,3).map(row=>row[3]+row.slice(0,3).reduce((s,v,k)=>s+v*p[k],0))}
function localMotion(){const roots=new Set(solution.roots),out={};function visit(id){if(out[id])return out[id];const j=doc.joints.find(j=>j.child===id);if(!j){out[id]=solution.transforms[id];return out[id]}const frames=solution.jointFrames[j.id],d=identity();if(j.type==='revolute'){const a=j.value*Math.PI/180;d[0][0]=d[1][1]=Math.cos(a);d[0][1]=-Math.sin(a);d[1][0]=Math.sin(a)}if(j.type==='slider')d[2][3]=j.value;out[id]=mm(mm(mm(visit(j.parent),frames.parent),d),inverse(frames.child));return out[id]}for(const i of doc.instances)visit(i.id);return out}
function animateValue(value){const j=doc.joints.find(j=>j.id===$('motionJoint').value);if(!j)return;j.value=value;solution.transforms=localMotion();$('motionSlider').value=value;$('motionValue').textContent=value.toFixed(1)+(j.type==='revolute'?'°':' mm');draw()}
function queuePreview(payload){previewQueue=payload;if(!previewTask){const token=previewToken;previewTask=(async()=>{while(previewQueue&&token===previewToken){const next=previewQueue;previewQueue=null;try{const r=await(await request('/assembly/solve',next)).json();if(token!==previewToken)break;doc=r.document;solution=r;draw();renderMotion()}catch(e){if(token===previewToken)previewError=e.message;previewQueue=null;break}}})().finally(()=>{previewTask=null})}return previewTask}
async function finishMotion(){if(!motionBefore)return;busy=true;renderControls();await previewTask;busy=false;const before=motionBefore;motionBefore=null;const candidate=clone(doc);doc=JSON.parse(before);if(previewError){const error=previewError;previewError=null;await commit(doc,false,false);status(error,true);return}if(!(await commit(candidate))){solution.transforms=localMotion();render()}}
$('motionSlider').oninput=e=>{if(busy||animation)return;motionBefore??=JSON.stringify(doc);const value=Number(e.target.value);renderControls();if(doc.constraints?.length){const d=clone(doc);d._drive={joint:$('motionJoint').value,value};queuePreview(d)}else animateValue(value)};$('motionSlider').onchange=finishMotion;$('motionJoint').onchange=()=>{if(motionBefore)finishMotion();renderMotion()};
$('play').onclick=()=>{if(busy||animation||jointDraft||constraintDraft)return;const j=doc.joints.find(j=>j.id===$('motionJoint').value);if(!j)return;const period=Number($('period').value);if(!(period>=1&&period<=120)){status('Periode zwischen 1 und 120 Sekunden wählen.',true);return}motionBefore=JSON.stringify(doc);previewError=null;const lo=Number($('motionSlider').min),hi=Number($('motionSlider').max);animation={start:performance.now(),period,lo,hi,phase:Math.acos(Math.max(-1,Math.min(1,1-2*(j.value-lo)/(hi-lo))))};renderControls();async function step(t){if(!animation)return;const a=animation,value=a.lo+(a.hi-a.lo)*(1-Math.cos(a.phase+(t-a.start)/1000/a.period*2*Math.PI))/2;if(doc.constraints?.length){const d=clone(doc);d._drive={joint:j.id,value};await queuePreview(d);if(previewError){$('stop').onclick();return}}else animateValue(value);if(animation)requestAnimationFrame(step)}requestAnimationFrame(step)};
$('stop').onclick=async()=>{animation=null;await finishMotion();render()};
async function undo(redo=false){if(busy||animation||motionBefore)return;const from=redo?future:history,to=redo?history:future;if(!from.length)return;const before=JSON.stringify(doc),target=from.at(-1);if(await commit(JSON.parse(target),true,false)){from.pop();to.push(before);renderControls()}}
$('undo').onclick=()=>undo();$('redo').onclick=()=>undo(true);
async function replaceAssembly(value) {
  if(value!==null && value?.format!=='MetricCAD-assembly')throw Error('Bitte eine Baugruppen-JSON wählen. Einzelteile über „Teil-JSON importieren“ einfügen.');
  if(!await commit(value??fresh(),true,false))return false;
  history=[];future=[];selected=selectedJoint=selectedConstraint=null;
  invalidatePartEditors();fit();render();return true;
}
const assemblyFiles=bindProjectFiles({defaultName:'MetricCAD-Baugruppe.json',blocked:()=>busy||animation||motionBefore||dragState,replace:replaceAssembly});
$('import').onclick=()=>{fileAction='import';$('file').click()};
$('file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file||busy||animation)return;try{if(file.size>4000000)throw Error('Datei größer als 4 MB');const value=JSON.parse(await file.text());const d=clone(doc);if(fileAction==='replace'){d.parts.find(p=>p.id===replacePart).document=value}else{const id=uid(),instance=uid(),name=file.name.replace(/\.json$/i,'');d.parts.push({id,name,document:value});d.instances.push({id:instance,part:id,name,pose:{position:[0,0,0],rotation:[0,0,0]},fixed:d.instances.length===0});selected=instance}if(await commit(d,true))fit()}catch(e){status(e.message,true)}};
async function copyInstance(independent){
    const source=doc.instances.find(instance=>instance.id===selected);
    if(!source||busy||animation||motionBefore||dragState)return;
    const candidate=clone(doc);
    const copy=clone(source);
    copy.id=uid();
    copy.name=(source.name||'Teil')+' Kopie';
    copy.fixed=false;
    copy.pose=clone(solution.poses[source.id]);
    copy.pose.position[0]+=20;
    if(independent){
        const original=doc.parts.find(part=>part.id===source.part);
        const part=clone(original);
        part.id=uid();
        const base=(original.name||'Teil')+' Kopie';
        part.name=base;
        for(let n=2;candidate.parts.some(item=>item.name===part.name);n++)part.name=base+' '+n;
        candidate.parts.push(part);
        copy.part=part.id;
        copy.name=part.name;
    }
    candidate.instances.push(copy);
    // A new definition also needs its mesh and face references in the viewport.
    if(await commit(candidate,independent))selectInstance(copy.id);
}
$('duplicate').onclick=()=>copyInstance(false);
$('copyPart').onclick=()=>copyInstance(true);
$('newJoint').onclick=()=>newJoint();
$('step').onclick=async()=>{if(busy||animation)return;busy=true;renderControls();try{const r=await request('/assembly/step',doc);download(await r.arrayBuffer(),'MetricCAD-Baugruppe.step','application/step');status('STEP exportiert · aktuelle Stellung, ohne Gelenkdefinitionen.')}catch(e){status(e.message,true)}finally{busy=false;render()}};
const canvas=$('view'),gl=canvas.getContext('webgl',{antialias:true}),buffers={};let W=1,H=1,dpr=1,camera={yaw:-.7,pitch:.65,center:[0,0,0],scale:3,pan:[0,0]},pointer=null,pickTriangles=[];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),norm=a=>{const n=Math.hypot(...a)||1;return a.map(x=>x/n)};
let program,positionLocation,normalLocation,modelLocation,viewLocation,colorLocation,lineLocation;
function shader(type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
if(gl){program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec3 n;uniform mat4 model;uniform mat4 view;varying vec3 normal;void main(){normal=mat3(model)*n;gl_Position=view*model*vec4(p,1.0);}'));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform vec3 color;uniform float lines;varying vec3 normal;void main(){float shade=lines>0.5?1.0:0.38+0.62*abs(dot(normalize(normal),normalize(vec3(0.4,-0.6,1.0))));gl_FragColor=vec4(color*shade,1.0);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('WebGL-Programm konnte nicht erstellt werden');positionLocation=gl.getAttribLocation(program,'p');normalLocation=gl.getAttribLocation(program,'n');modelLocation=gl.getUniformLocation(program,'model');viewLocation=gl.getUniformLocation(program,'view');colorLocation=gl.getUniformLocation(program,'color');lineLocation=gl.getUniformLocation(program,'lines')}else status('WebGL nicht verfügbar. Bitte Hardwarebeschleunigung im Browser aktivieren.',true);
const columnMajor=m=>new Float32Array(m[0].map((_,j)=>m.map(row=>row[j])).flat());
function basis(){const {yaw:y,pitch:p}=camera;return {right:[Math.cos(y),Math.sin(y),0],up:[-Math.sin(y)*Math.sin(p),Math.cos(y)*Math.sin(p),Math.cos(p)],depth:[Math.sin(y)*Math.cos(p),-Math.cos(y)*Math.cos(p),Math.sin(p)]}}
function project(p){const b=basis(),v=sub(p,camera.center);return[W/2+camera.pan[0]+dot(v,b.right)*camera.scale,H/2+camera.pan[1]-dot(v,b.up)*camera.scale,dot(v,b.depth)]}
function viewMatrix(){const b=basis(),s=camera.scale;let depthRange=100;for(const i of doc.instances){const t=solution.transforms[i.id],bounds=assets[i.part]?.mesh.bounds;if(t&&bounds){const radius=Math.hypot(Math.max(Math.abs(bounds[0]),Math.abs(bounds[1])),Math.max(Math.abs(bounds[2]),Math.abs(bounds[3])),Math.max(Math.abs(bounds[4]),Math.abs(bounds[5])));depthRange=Math.max(depthRange,2*(Math.hypot(...sub(t.slice(0,3).map(r=>r[3]),camera.center))+radius))}}return [[...b.right.map(v=>v*2*s/W),-dot(camera.center,b.right)*2*s/W+2*camera.pan[0]/W],[...b.up.map(v=>v*2*s/H),-dot(camera.center,b.up)*2*s/H-2*camera.pan[1]/H],[...b.depth.map(v=>-v/depthRange),dot(camera.center,b.depth)/depthRange],[0,0,0,1]]}
function prepareBuffers(){if(!gl)return;for(const b of Object.values(buffers)){gl.deleteBuffer(b.tri);gl.deleteBuffer(b.edge)}for(const k of Object.keys(buffers))delete buffers[k];for(const [id,a] of Object.entries(assets)){const data=[],edges=[];for(const t of a.mesh.triangles){const vs=t.map(i=>a.mesh.vertices[i]),n=norm(cross(sub(vs[1],vs[0]),sub(vs[2],vs[0])));for(const p of vs)data.push(...p,...n)}for(const e of a.mesh.edges)for(let i=1;i<e.points.length;i++)for(const p of [e.points[i-1],e.points[i]])edges.push(...p,0,0,1);const upload=values=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);return b};buffers[id]={tri:upload(data),edge:upload(edges),count:data.length/6,edgeCount:edges.length/6}}}
function bufferDraw(buffer,count,type,color,lines=false){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.vertexAttribPointer(positionLocation,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(normalLocation,3,gl.FLOAT,false,24,12);gl.uniform3fv(colorLocation,color);gl.uniform1f(lineLocation,lines?1:0);gl.drawArrays(type,0,count)}
const palette=[[.25,.69,.62],[.35,.58,.85],[.84,.64,.32],[.67,.47,.8],[.65,.73,.79]];
function draw(){drawGizmo();if(!gl)return;gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.045,.075,.11,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.useProgram(program);gl.enableVertexAttribArray(positionLocation);gl.enableVertexAttribArray(normalLocation);gl.uniformMatrix4fv(viewLocation,false,columnMajor(viewMatrix()));for(const [k,i] of doc.instances.entries()){const b=buffers[i.part],t=solution.transforms[i.id];if(!b||!t)continue;gl.uniformMatrix4fv(modelLocation,false,columnMajor(t));gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);bufferDraw(b.tri,b.count,gl.TRIANGLES,i.id===selected||i.id===pick?.instance?[.94,.75,.4]:palette[k%palette.length]);gl.disable(gl.POLYGON_OFFSET_FILL);bufferDraw(b.edge,b.edgeCount,gl.LINES,[.08,.17,.22],true)}drawFaceHighlight();drawAxes()}
let axisBuffer=null;
function drawAxes(){let t=identity();if(jointDraft&&solution.transforms[jointDraft.parent]){try{t=mm(solution.transforms[jointDraft.parent],draftFrame(jointDraft.parent,jointDraft.parentFrame))}catch{}}else if(selected&&solution.transforms[selected])t=solution.transforms[selected];gl.uniformMatrix4fv(modelLocation,false,columnMajor(t));if(!axisBuffer)axisBuffer=gl.createBuffer();const length=32/camera.scale;for(let k=0;k<3;k++){const p=[0,0,0];p[k]=length;gl.bindBuffer(gl.ARRAY_BUFFER,axisBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,0,0,0,1,...p,0,0,1]),gl.DYNAMIC_DRAW);bufferDraw(axisBuffer,2,gl.LINES,[[1,.35,.3],[.35,1,.55],[.4,.65,1]][k],true)}}
function eulerPose(origin,angles){const [x,y,z]=angles.map(v=>v*Math.PI/180),cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);return [[cz*cy,cz*sy*sx-sz*cx,cz*sy*cx+sz*sx,origin[0]],[sz*cy,sz*sy*sx+cz*cx,sz*sy*cx-cz*sx,origin[1]],[-sy,cy*sx,cy*cx,origin[2]],[0,0,0,1]]}
function draftFrame(instance,f){const offset=eulerPose(f.offset||f.origin||[0,0,0],f.rotation||[0,0,0]);if(!f.face)return offset;const a=availableDatums(instance)[f.face]?.frame;if(!a)throw Error('Referenz fehlt');const t=identity();for(let k=0;k<3;k++){t[k][0]=a.u[k];t[k][1]=a.v[k];t[k][2]=a.n[k];t[k][3]=a.o[k]}return mm(t,offset)}
function fit(){const points=[];for(const i of doc.instances){const m=assets[i.part]?.mesh,t=solution.transforms[i.id];if(m&&t)for(const p of m.vertices)points.push(transform(t,p))}if(!points.length){camera.center=[0,0,0];camera.scale=3}else{const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(const p of points)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p[k]);hi[k]=Math.max(hi[k],p[k])}camera.center=lo.map((v,k)=>(v+hi[k])/2);camera.scale=Math.min(W,H)*.65/Math.max(10,Math.hypot(...sub(hi,lo)))}camera.pan=[0,0];draw()}
function triangleDepth(p,a,b,c){const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-10)return null;const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/den,v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/den,w=1-u-v;return u>=0&&v>=0&&w>=0?u*a[2]+v*b[2]+w*c[2]:null}
function hit(p){let best=null,depth=-Infinity;for(const i of doc.instances){const mesh=assets[i.part]?.mesh,t=solution.transforms[i.id];if(!mesh||!t)continue;const points=mesh.vertices.map(p=>project(transform(t,p)));for(let k=0;k<mesh.triangles.length;k++){const z=triangleDepth(p,...mesh.triangles[k].map(v=>points[v]));if(z!==null&&z>depth){depth=z;best={instance:i.id,face:mesh.faces[mesh.triangleFaces[k]]?.key}}}}return best}
const markerHits=[];
const mouse=e=>{const r=canvas.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top]};
canvas.onpointerdown=e=>{if(e.button!==0&&e.button!==1)return;canvas.setPointerCapture(e.pointerId);if(e.button===0&&!e.shiftKey&&beginDrag(mouse(e)))return;pointer={start:mouse(e),yaw:camera.yaw,pitch:camera.pitch,pan:[...camera.pan],panning:e.shiftKey||e.button===1,moved:false}};
canvas.onpointermove=e=>{if(dragState){updateDrag(mouse(e));return}if(!pointer){if(pick){hoverFace=hit(mouse(e));draw()}return;}const p=mouse(e),dx=p[0]-pointer.start[0],dy=p[1]-pointer.start[1];pointer.moved||=Math.hypot(dx,dy)>4;if(pointer.panning)camera.pan=[pointer.pan[0]+dx,pointer.pan[1]+dy];else{camera.yaw=pointer.yaw-dx*.008;camera.pitch=Math.max(-1.5,Math.min(1.5,pointer.pitch+dy*.008))}draw()};
canvas.onpointerup=e=>{if(dragState){endDrag();return}const drag=pointer;pointer=null;if(!drag||drag.moved||drag.panning||busy||animation)return;if(!pick&&!jointDraft&&!transformMode&&!dragState){
    const marker=hitMarker(mouse(e));
    if(marker){selectConstraint(marker);canvas.focus({preventScroll:true});return;}
}const h=hit(mouse(e));if(pick?.constraint){acceptConstraintPick(h);return}if(pick){if(!h||h.instance!==pick.instance){status('Bitte eine Fläche der hervorgehobenen Instanz auswählen.',true);return}if(!availableDatums(h.instance)[h.face]){status('Nur eindeutig referenzierbare ebene oder zylindrische Flächen sind als Bezug verfügbar.',true);return}jointDraft[pick.side+'Frame']={face:h.face,offset:[0,0,0],rotation:[0,0,0]};pick=null;render();return}if(h||selectedConstraint)selectInstance(h?.instance??null)};canvas.onpointercancel=()=>{pointer=null;if(dragState)cancelDrag()};canvas.onwheel=e=>{e.preventDefault();camera.scale=Math.max(.0001,Math.min(10000,camera.scale*Math.exp(-e.deltaY*.001)));draw()};
$('fit').onclick=fit;$('iso').onclick=()=>{camera.yaw=-.7;camera.pitch=.65;draw()};window.addEventListener('keydown',e=>{if(e.key==='Escape'){if(dragState){cancelDrag();return}constraintDraft=null;selectedConstraint=null;if(animation){$('stop').onclick();return}pick=null;jointDraft=null;selectedJoint=null;render()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){e.preventDefault();undo(e.shiftKey)}});
const conditionNames={offset:'Flächenabstand',concentric:'Konzentrisch',angle:'Winkel',tangent:'Tangential'};
$('assembly-tools').addEventListener('focusin',e=>{
    $('assembly-tools').dataset.focusLabel=e.target.title||'';
});
function selectConstraint(id){
    if(busy||animation||motionBefore||dragState)return;
    const c=doc.constraints?.find(item=>item.id===id);
    if(!c)return;
    selected=null;selectedJoint=null;jointDraft=null;transformMode=null;pick=null;hoverFace=null;
    selectedConstraint=id;constraintDraft=clone(c);
    render();status('Bedingung ausgewählt · Entf zum Löschen.');
}
async function removeSelectedConstraint(){
    if(!selectedConstraint||busy||animation||motionBefore||dragState||pick)return;
    const candidate=clone(doc);
    if(!candidate.constraints?.some(c=>c.id===selectedConstraint))return;
    keepPoses(candidate);
    candidate.constraints=candidate.constraints.filter(c=>c.id!==selectedConstraint);
    if(await commit(candidate)){selectedConstraint=null;render();}
}
window.addEventListener('keydown',e=>{
    if(e.key!=='Delete'||e.repeat||e.defaultPrevented||document.body.inert||!selectedConstraint)return;
    if(e.target.isContentEditable||e.target.closest?.('input,textarea,select,dialog'))return;
    e.preventDefault();removeSelectedConstraint();
});
function newConstraint(type,name=conditionNames[type],angle=45){
    if(busy||animation||doc.instances.length<2)return;
    jointDraft=null;selectedJoint=null;selectedConstraint=null;transformMode=null;
    constraintDraft={id:uid(),type,name,parent:'',child:'',parentFace:'',childFace:'',opposed:false};
    if(type==='offset')constraintDraft.offset=0;
    if(type==='angle')constraintDraft.angle=angle;
    pick={constraint:true,side:'parent'};
    render();
    status(type==='concentric'?'Erste Zylinderfläche wählen.':type==='tangent'?'Ebene und Zylinderfläche wählen.':'Erste Bezugsfläche wählen.');
}
$('offsetTool').onclick=()=>newConstraint('offset');
$('flushTool').onclick=()=>newConstraint('offset','Bündig');
$('concentricTool').onclick=()=>newConstraint('concentric');
$('tangentTool').onclick=()=>newConstraint('tangent');
$('angleTool').onclick=()=>newConstraint('angle');
$('rightAngleTool').onclick=()=>newConstraint('angle','Senkrecht',90);
$('fixedJoint').onclick=()=>newJoint(selected,'fixed');
$('sliderJoint').onclick=()=>newJoint(selected,'slider');
for (const mode of ['move', 'rotate']) {
    $(mode+'Tool').onclick = () => {
        transformMode = transformMode === mode ? null : mode;
        constraintDraft = selectedConstraint = selectedJoint = jointDraft = pick = null;
        render();
        status(!transformMode ? 'Bereit.' : mode === 'rotate'
            ? 'Farbring mit der Maus ziehen, um das Teil zu drehen. Esc bricht die Drehung ab.'
            : 'Teil auswählen und einen Achspfeil oder eine Ebenenfläche ziehen.');
    };
}
function constraintEditor(pane){const c=constraintDraft;el('h3',conditionNames[c.type],pane);const name=textInput(pane,'Name',c.name||'');name.oninput=()=>c.name=name.value;for(const side of ['parent','child']){const i=doc.instances.find(i=>i.id===c[side]);note(pane,(side==='parent'?'Fläche 1: ':'Fläche 2: ')+(i?(i.name||i.id)+' · '+(assets[i.part]?.datums[c[side+'Face']]?.label||c[side+'Face']):'noch nicht gewählt'));button(pane,side==='parent'?'Fläche 1 wählen':'Fläche 2 wählen',()=>{pick={constraint:true,side};render();status('Passende Fläche im Modell anklicken.');});}if(c.type==='offset'){const value=numberInput(pane,'Signierter Abstand entlang Normale von Fläche 1 (mm)',c.offset);value.oninput=()=>c.offset=Number(value.value);button(pane,'Abstandsrichtung umkehren',()=>{c.offset=-c.offset;render()});note(pane,'Beide Ebenen bleiben parallel. X/Y-Verschiebung in der Ebene und Drehung um ihre Normale bleiben frei.');}else if(c.type==='angle'){
    const field=numberInput(pane,'Winkel zwischen Normalen oder Achsen (°)',c.angle);
    field.min=0;field.max=180;field.step='any';
    field.oninput=()=>c.angle=field.valueAsNumber;
}else if(c.type==='tangent'){
    const side=selectInput(pane,'Kontaktseite der Ebene',[['positive','Positive Normale'],['negative','Negative Normale']],c.opposed?'negative':'positive');
    side.onchange=()=>c.opposed=side.value==='negative';
}else note(pane,'Die Zylinderachsen werden deckungsgleich.');
if(c.type==='concentric'||c.type==='offset'){
    const orientation=selectInput(pane,'Achsen / Normalen',[['same','Gleichgerichtet'],['opposed','Entgegengesetzt']],c.opposed?'opposed':'same');
    orientation.onchange=()=>c.opposed=orientation.value==='opposed';
}
button(pane,'Bedingung übernehmen',async()=>{const d=clone(doc);d.constraints??=[];const index=d.constraints.findIndex(x=>x.id===c.id);if(index<0)d.constraints.push(clone(c));else d.constraints[index]=clone(c);if(await commit(d)){selectedConstraint=null;render()}},'primary');if(selectedConstraint)button(pane,'Bedingung löschen',removeSelectedConstraint,'danger');button(pane,'Abbrechen',()=>{constraintDraft=null;selectedConstraint=null;pick=null;hoverFace=null;render()});}
function acceptConstraintPick(hit){
    const c=constraintDraft;
    if(!c||!hit)return;
    const side=pick.side,other=side==='parent'?'child':'parent';
    const kind=availableDatums(hit.instance)[hit.face]?.type;
    const otherKind=availableDatums(c[other])[c[other+'Face']]?.type;
    if(!['PLANE','CYLINDER'].includes(kind) || (c.type==='offset'&&kind!=='PLANE') ||
       (c.type==='concentric'&&kind!=='CYLINDER') || (c.type==='tangent'&&kind===otherKind)){
        status(c.type==='tangent'?'Eine ebene und eine zylindrische Fläche wählen.':'Unpassender Flächentyp.',true);
        return;
    }
    if(c[other]===hit.instance){status('Zwei verschiedene Instanzen wählen.',true);return;}
    c[side]=hit.instance;c[side+'Face']=hit.face;
    if(c.parent&&c.child){
        if(c.type==='tangent'&&availableDatums(c.parent)[c.parentFace].type==='CYLINDER'){
            [c.parent,c.child]=[c.child,c.parent];
            [c.parentFace,c.childFace]=[c.childFace,c.parentFace];
        }
        const frame=side=>mm(solution.transforms[c[side]],draftFrame(c[side],{face:c[side+'Face']}));
        const a=frame('parent'),b=frame('child'),normal=a.slice(0,3).map(row=>row[2]);
        if(c.type==='tangent')c.opposed=dot(normal,b.slice(0,3).map((row,i)=>row[3]-a[i][3]))<0;
        else if(c.type!=='angle')c.opposed=dot(normal,b.slice(0,3).map(row=>row[2]))<0;
        pick=null;
    }else pick={constraint:true,side:other};
    hoverFace=null;render();status(pick?'Zweite Bezugsfläche wählen.':'Bezüge gewählt. Bedingung übernehmen.');
}
function drawFaceHighlight(){if(!gl)return;const refs=[];if(hoverFace&&pick)refs.push({...hoverFace,color:[1,.8,.35]});if(constraintDraft)for(const side of ['parent','child'])if(constraintDraft[side])refs.push({instance:constraintDraft[side],face:constraintDraft[side+'Face'],color:side==='parent'?[.25,.9,.8]:[.6,.65,1]});for(const ref of refs){const i=doc.instances.find(i=>i.id===ref.instance),a=i&&assets[i.part],b=i&&buffers[i.part];if(!a||!b)continue;gl.uniformMatrix4fv(modelLocation,false,columnMajor(solution.transforms[i.id]));gl.bindBuffer(gl.ARRAY_BUFFER,b.tri);gl.vertexAttribPointer(positionLocation,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(normalLocation,3,gl.FLOAT,false,24,12);gl.uniform3fv(colorLocation,ref.color);gl.uniform1f(lineLocation,0);for(let k=0;k<a.mesh.triangles.length;k++)if(a.mesh.faces[a.mesh.triangleFaces[k]]?.key===ref.face)gl.drawArrays(gl.TRIANGLES,k*3,3)}}
function gizmoGeometry(){const i=doc.instances.find(i=>i.id===selected);if(!transformMode||!i||i.fixed||(transformMode==='rotate'&&doc.joints.some(j=>j.child===i.id))||pick||jointDraft||constraintDraft)return null;const t=solution.transforms[i.id];if(!t)return null;const origin=t.slice(0,3).map(r=>r[3]),p=project(origin),unit=82/camera.scale,axes=[[1,0,0],[0,1,0],[0,0,1]],ends=axes.map(a=>project(origin.map((v,k)=>v+a[k]*unit))),planes=[];for(const [a,b] of [[0,1],[0,2],[1,2]]){const va=sub(ends[a],p),vb=sub(ends[b],p);if(Math.abs(va[0]*vb[1]-va[1]*vb[0])<700)continue;const points=[[.2,.2],[.4,.2],[.4,.4],[.2,.4]].map(([u,v])=>[p[0]+va[0]*u+vb[0]*v,p[1]+va[1]*u+vb[1]*v]);planes.push({axes:[a,b],points})}return {origin,p,ends,planes,axes};}
function svg(tag,attributes,text,parent=$('gizmo')){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attributes))e.setAttribute(k,v);if(text)e.textContent=text;parent.append(e);return e}
// Markers and their hit areas share screen coordinates with the mesh picker.
function hitMarker([x,y]){
    for(let i=markerHits.length-1;i>=0;i--){
        const {id,label,segments}=markerHits[i];
        if(Math.abs(x-label.x)<=label.width/2 && Math.abs(y-label.y)<=10)return id;
        for(const [a,b] of segments){
            const dx=b[0]-a[0],dy=b[1]-a[1];
            const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)));
            if(Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)<=5)return id;
        }
    }
    return null;
}
const markerNumber=new Intl.NumberFormat('de-DE',{maximumFractionDigits:3});
function markerReference(c,side){
    const datum=availableDatums(c[side])[c[side+'Face']],pose=solution.transforms[c[side]];
    if(!datum||!pose)return null;
    const normal=pose.slice(0,3).map(row=>dot(row.slice(0,3),datum.frame.n));
    return {point:transform(pose,datum.center||datum.frame.o),normal,radius:datum.radius};
}
function drawConstraintMarkers(){
    markerHits.length=0;
    const labels=[];
    const constraints=(doc.constraints||[]).filter(c=>c.id!==constraintDraft?.id);
    if(constraintDraft)constraints.push(constraintDraft);
    for(const c of constraints){
        const a=markerReference(c,'parent'),b=markerReference(c,'child');
        if(!a||!b)continue;
        const selected=c.id===selectedConstraint||c===constraintDraft;
        const group=svg('g',{class:'mate-marker'+(selected?' selected':'')});
        const segments=[];
        function line(start,end,style=''){
            svg('path',{d:'M'+start.slice(0,2).join(' ')+' L'+end.slice(0,2).join(' '),class:style},null,group);
            segments.push([start,end]);
        }
        const shifted=(p,n,d)=>p.map((x,k)=>x+n[k]*d);
        let start=project(a.point),end=project(b.point);
        let label=conditionNames[c.type];
        if(c.type==='offset'||c.type==='tangent'){
            // Project the second reference onto the first plane, along its normal.
            const foot=shifted(b.point,a.normal,-dot(sub(b.point,a.point),a.normal));
            const projected=project(foot);
            line(start,projected,'witness');start=projected;
            if(c.type==='offset')label=markerNumber.format(c.offset)+' mm';
            else if(b.radius){
                end=project(shifted(b.point,a.normal,c.opposed?b.radius:-b.radius));
                line(project(b.point),end,'witness');
            }
        }else{
            // Show the directions even when the reference points project to one pixel.
            for(const r of [a,b])line(project(r.point),project(shifted(r.point,r.normal,28/camera.scale)));
            if(c.type==='angle')label=markerNumber.format(c.angle)+'°';
        }
        line(start,end);
        for(const p of [start,end])svg('circle',{cx:p[0],cy:p[1],r:3},null,group);
        const mid=[(start[0]+end[0])/2,(start[1]+end[1])/2];
        const width=Math.max(40,label.length*7.2+12);
        const x=Math.max(width/2+2,Math.min(W-width/2-2,mid[0]+16));
        let y=mid[1]-15;
        while(labels.some(box=>Math.abs(box.x-x)<(box.width+width)/2+2&&Math.abs(box.y-y)<21))y+=22;
        const box={x,y,width};labels.push(box);
        line(mid,[x,y],'witness');
        svg('rect',{x:x-width/2,y:y-9,width,height:18,rx:4},null,group);
        svg('text',{x,y:y+4},label,group);
        if(c!==constraintDraft||selectedConstraint)markerHits.push({id:c.id,label:box,segments});
    }
}
// Project each world-axis ring into the same screen space used for picking.
function rotationRings(g) {
    const {right, up} = basis();
    return [0, 1, 2].map(axis => {
        const a = (axis + 1) % 3, b = (axis + 2) % 3;
        const u = [right[a] * 68, -up[a] * 68], v = [right[b] * 68, -up[b] * 68];
        const points = Array.from({length: 72}, (_, n) => {
            const angle = n * Math.PI / 36;
            return u.map((x, k) => g.p[k] + x * Math.cos(angle) + v[k] * Math.sin(angle));
        });
        return {axis, center:g.p, u, v, points};
    });
}
function pickRing(p, rings) {
    let best = null, distance = 8;
    for (const ring of rings) {
        ring.points.forEach((start, n) => {
            const end = ring.points[(n + 1) % ring.points.length];
            const dx = end[0] - start[0], dy = end[1] - start[1];
            const t = Math.max(0, Math.min(1, ((p[0]-start[0])*dx + (p[1]-start[1])*dy) / (dx*dx + dy*dy || 1)));
            const gap = Math.hypot(p[0]-start[0]-t*dx, p[1]-start[1]-t*dy);
            if (gap < distance) {
                best = {ring, angle:(n+t)*Math.PI/36};
                distance = gap;
            }
        });
    }
    return best;
}
function ringAngle(p, ring) {
    const {u, v, center} = ring;
    const det = u[0]*v[1] - u[1]*v[0];
    if (Math.abs(det) < 450) return null;
    const x = p[0]-center[0], y = p[1]-center[1];
    return Math.atan2((u[0]*y-u[1]*x)/det, (v[1]*x-v[0]*y)/det);
}
function updateRotation(p, d) {
    const {ring, angle} = d.rotation;
    const current = ringAngle(p, ring);
    let delta;
    if (current === null) {
        // Edge-on rings use the tangent at the grabbed point.
        const tangent = ring.u.map((u,k) => -u*Math.sin(angle) + ring.v[k]*Math.cos(angle));
        const length = Math.hypot(...tangent);
        const direction = length > 2 ? tangent.map(v => v/length) : [1,0];
        delta = ((p[0]-d.start[0])*direction[0] + (p[1]-d.start[1])*direction[1])/68;
    } else {
        delta = current - ringAngle(d.start, ring);
    }
    const axis = ring.axis, a = (axis+1)%3, b = (axis+2)%3;
    const rot = identity();
    rot[a][a] = rot[b][b] = Math.cos(delta);
    rot[a][b] = -Math.sin(delta);
    rot[b][a] = Math.sin(delta);
    const m = mm(rot, d.solution.transforms[d.instance]);
    // Extrinsic XYZ Euler angles, matching the assembly solver.
    const cy = Math.hypot(m[0][0], m[1][0]);
    const angles = [cy > 1e-8 ? Math.atan2(m[2][1],m[2][2]) : Math.atan2(-m[1][2],m[1][1]),
        Math.atan2(-m[2][0],cy), cy > 1e-8 ? Math.atan2(m[1][0],m[0][0]) : 0];
    const candidate = clone(d.before);
    candidate.instances.find(i => i.id === d.instance).pose = {
        position:[...d.origin], rotation:angles.map(v => v*180/Math.PI)
    };
    queuePreview(candidate);
}
function drawGizmo(){const overlay=$('gizmo');if(!overlay)return;overlay.replaceChildren();overlay.setAttribute('viewBox',`0 0 ${W} ${H}`);drawConstraintMarkers();const g=gizmoGeometry();if(!g)return;const colors=['#ff796f','#77e69c','#7eb6ff'];if (transformMode === 'rotate') {
    for (const ring of rotationRings(g)) {
        const active = dragState?.rotation?.ring.axis === ring.axis;
        svg('polygon', {points:ring.points.map(p=>p.join(',')).join(' '), fill:'none',
            stroke:colors[ring.axis], 'stroke-width':active ? 5 : 3});
        const label = ring.points[8+ring.axis*13];
        svg('text',{x:label[0]+4,y:label[1]-4,fill:colors[ring.axis],'font-weight':700},'XYZ'[ring.axis]);
    }
    return;
}for(const plane of g.planes)svg('polygon',{points:plane.points.map(p=>p.join(',')).join(' '),fill:colors[plane.axes[0]],'fill-opacity':.3,stroke:colors[plane.axes[1]],'stroke-width':1.5});g.ends.forEach((p,k)=>{const dx=p[0]-g.p[0],dy=p[1]-g.p[1],length=Math.hypot(dx,dy);if(length<18)return;const ux=dx/length,uy=dy/length;svg('line',{x1:g.p[0],y1:g.p[1],x2:p[0],y2:p[1],stroke:colors[k],'stroke-width':4});svg('polygon',{points:`${p[0]},${p[1]} ${p[0]-ux*12-uy*5},${p[1]-uy*12+ux*5} ${p[0]-ux*12+uy*5},${p[1]-uy*12-ux*5}`,fill:colors[k]});svg('text',{x:p[0]+7,y:p[1]-7,fill:colors[k],'font-size':14,'font-weight':700},['X','Y','Z'][k])});}
function gizmoHit(p,g){for(const plane of g.planes){const [a,b,c,d]=plane.points;if(triangleDepth(p,[...a,0],[...b,0],[...c,0])!==null||triangleDepth(p,[...a,0],[...c,0],[...d,0])!==null)return plane.axes}let best=null,distance=9;g.ends.forEach((e,k)=>{const dx=e[0]-g.p[0],dy=e[1]-g.p[1],n=dx*dx+dy*dy;if(n<324)return;const u=Math.max(.12,Math.min(1,((p[0]-g.p[0])*dx+(p[1]-g.p[1])*dy)/n)),d=Math.hypot(p[0]-g.p[0]-u*dx,p[1]-g.p[1]-u*dy);if(d<distance){best=[k];distance=d}});return best}
function beginDrag(p){if(busy||animation||motionBefore||previewTask)return false;const g=gizmoGeometry();if(!g)return false;
    const rotation=transformMode==='rotate' ? pickRing(p,rotationRings(g)) : null;
    const axes=transformMode==='move' ? gizmoHit(p,g) : null;
    if(!axes&&!rotation)return false;
    dragState={rotation,start:p,origin:g.origin,axes,before:clone(doc),solution:clone(solution),instance:selected};previewError=null;busy=true;renderControls();return true}
function updateDrag(p){if(dragState.released)return;if(dragState.rotation){updateRotation(p,dragState);return}const d=dragState,b=basis(),dx=(p[0]-d.start[0])/camera.scale,dy=-(p[1]-d.start[1])/camera.scale,target=[...d.origin];if(d.axes.length===1){const k=d.axes[0],n=b.right[k]**2+b.up[k]**2;if(n<.02)return;target[k]+=(dx*b.right[k]+dy*b.up[k])/n;}else{const [i,j]=d.axes,det=b.right[i]*b.up[j]-b.right[j]*b.up[i];if(Math.abs(det)<.05)return;target[i]+=(dx*b.up[j]-dy*b.right[j])/det;target[j]+=(dy*b.right[i]-dx*b.up[i])/det;}d.requested=target;const candidate=clone(doc);candidate._drag={instance:d.instance,position:target};queuePreview(candidate)}
async function endDrag(){const d=dragState;if(!d||d.released)return;d.released=true;await previewTask;if(dragState!==d)return;dragState=null;busy=false;if(previewError){doc=d.before;solution=d.solution;status(previewError,true);previewError=null;}else{if(JSON.stringify(doc)!==JSON.stringify(d.before)){history.push(JSON.stringify(d.before));if(history.length>40)history.shift();future=[]}const pos=solution.transforms[d.instance].slice(0,3).map(r=>r[3]);status(d.rotation?'Drehwerkzeug · bestehende Bedingungen eingehalten.':d.requested&&Math.hypot(...sub(pos,d.origin))<1e-7?'In dieser Richtung ist durch die Bedingungen keine Verschiebung möglich.':'Position aktualisiert · bestehende Bedingungen eingehalten.')}render()}
async function cancelDrag(){const d=dragState;if(!d)return;previewToken++;previewQueue=null;doc=d.before;solution=d.solution;dragState=null;previewError=null;draw();await previewTask;busy=false;render();status(d.rotation?'Drehen abgebrochen.':'Verschieben abgebrochen.');}

new ResizeObserver(()=>{const r=$('stage').getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);dpr=Math.min(devicePixelRatio||1,2);canvas.width=W*dpr;canvas.height=H*dpr;draw()}).observe($('stage'));
function demoDocument(){const box=(id,a,b,depth)=>({version:2,features:[{id:'body',shape:'multi',op:'pad',support:{plane:'XY'},depth,geometry:[{id:'outline',type:'rect',x:0,y:0,a,b,angle:0}],dimensions:[],relations:[]}]});return {format:'MetricCAD-assembly',version:1,parts:[{id:'base',name:'Grundplatte',document:box('base',70,50,8)},{id:'arm',name:'Hebel',document:box('arm',70,12,6)},{id:'block',name:'Schieber',document:box('block',12,18,10)}],instances:[{id:'ground',part:'base',name:'Grundplatte · fixiert',fixed:true,pose:{position:[0,0,0],rotation:[0,0,0]}},{id:'lever',part:'arm',name:'Hebel',fixed:false,pose:{position:[0,0,8],rotation:[0,0,0]}},{id:'slide',part:'block',name:'Schieber',fixed:false,pose:{position:[0,0,14],rotation:[0,0,0]}}],joints:[{id:'hinge',name:'Hebel drehen',type:'revolute',parent:'ground',child:'lever',parentFrame:{origin:[-20,0,8],rotation:[0,0,0]},childFrame:{origin:[-30,0,0],rotation:[0,0,0]},value:25,limits:[-80,80]},{id:'rail',name:'Schieber bewegen',type:'slider',parent:'lever',child:'slide',parentFrame:{origin:[0,0,6],rotation:[0,90,0]},childFrame:{origin:[0,0,0],rotation:[0,90,0]},value:0,limits:[-22,22]}]}}
$('demo').onclick=()=>{return assemblyFiles.switchTo(()=>replaceAssembly(demoDocument()),true)};
// Dedicated editor tabs; no shared localStorage mailbox or external-file writes.
const partEditors=new Map();
function openPartEditor(partID){if(busy||animation||motionBefore||dragState)return;const part=doc.parts.find(p=>p.id===partID);if(!part)return;for(const [token,session] of partEditors){if(session.part===partID&&!session.window.closed){session.window.focus();status('Der Editor für dieses Teil ist bereits geöffnet.');return}if(session.window.closed)partEditors.delete(token)}const token=uid(),editor=window.open('/#assembly-edit='+encodeURIComponent(token),'_blank');if(!editor){status('Der Browser hat den Editor-Tab blockiert. Bitte Pop-ups für MetricCAD erlauben.',true);return}partEditors.set(token,{part:partID,window:editor,base:JSON.stringify(part.document)});status('Teil im Part Design geöffnet · Änderungen gelten für alle Instanzen dieser Teildefinition.');}
function editorReply(session,token,type,data={}){session.window.postMessage({channel:'metriccad-part-edit',token,type,...data},location.origin)}
function invalidatePartEditors(){for(const [token,session] of partEditors)if(!session.window.closed)editorReply(session,token,'invalid',{error:'In der Baugruppe wurde ein anderes Projekt geöffnet. Bitte das Teil dort erneut zum Bearbeiten öffnen.'});partEditors.clear()}
async function receivePartEdit(e){const m=e.data;if(e.origin!==location.origin||!m||m.channel!=='metriccad-part-edit'||typeof m.token!=='string')return;const session=partEditors.get(m.token);if(!session||e.source!==session.window)return;const part=doc.parts.find(p=>p.id===session.part);if(!part){editorReply(session,m.token,'invalid',{error:'Die Teildefinition ist in dieser Baugruppe nicht mehr vorhanden.'});return}if(m.type==='ready'||m.type==='reload'){if(assemblyFiles.active||busy||animation||motionBefore||dragState){editorReply(session,m.token,'error',{error:'Baugruppe ist beschäftigt. Bitte danach erneut „Teil neu laden“ wählen.'});return}session.base=JSON.stringify(part.document);editorReply(session,m.token,'load',{document:clone(part.document),name:part.name||part.id,instances:doc.instances.filter(i=>i.part===part.id).length});return}if(m.type!=='apply')return;if(assemblyFiles.active||busy||animation||motionBefore||dragState){editorReply(session,m.token,'result',{request:m.request,ok:false,error:'Baugruppe ist beschäftigt. Bitte anschließend erneut übernehmen.'});return}if(JSON.stringify(part.document)!==session.base){editorReply(session,m.token,'result',{request:m.request,ok:false,error:'Das Teil wurde inzwischen in der Baugruppe geändert. Bitte deine Bearbeitung als JSON sichern und „Teil neu laden“ wählen, bevor du erneut übernimmst.'});return}if(!m.document||!Array.isArray(m.document.features)){editorReply(session,m.token,'result',{request:m.request,ok:false,error:'Ungültiges Teilprojekt.'});return}const candidate=clone(doc);candidate.parts.find(p=>p.id===session.part).document=clone(m.document);const ok=await commit(candidate,true);if(ok){session.base=JSON.stringify(doc.parts.find(p=>p.id===session.part).document);status('Teil aktualisiert · '+doc.instances.filter(i=>i.part===session.part).length+' Instanzen übernommen.')}editorReply(session,m.token,'result',{request:m.request,ok,error:ok?null:$('status').textContent,instances:doc.instances.filter(i=>i.part===session.part).length});}
window.addEventListener('message',receivePartEdit);

// Offer a pre-file-workflow assembly for explicit recovery.
try {
 if(localStorage.getItem('metriccad-assembly-v1')!==null){
  const legacy=document.createElement('button');legacy.textContent='Alte Baugruppe öffnen';
  $('open').after(legacy);
  legacy.onclick=()=>assemblyFiles.switchTo(()=>replaceAssembly(JSON.parse(localStorage.getItem('metriccad-assembly-v1'))),true);
 }
}catch{/* Browser storage may be disabled. */}
render();
