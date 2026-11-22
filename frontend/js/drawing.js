'use strict';
const $ = id => document.getElementById(id);
const emptyProject = () => ({format:'MetricCAD-drawing',version:1,model:null,name:'',sheets:[]});
const viewNames = {front:'Vorderansicht',top:'Draufsicht',right:'Rechtsansicht'};
const scales = [0.1,0.2,0.5,1,2,5,10,20,25,50,100,200,500,1000];
const scaleText = n => n < 1 ? (1/n)+':1' : '1:'+n;
const number = n => n.toLocaleString('de-DE',{maximumFractionDigits:3});
let doc = emptyProject(), target = null, geometry = null, generation = 0, loading = false;
let sheetView={};
let anchors = [], placing = null, tool = '';
const tools = ['autoDim','horizontal','vertical','length','diameter'];
const undoStack=[], redoStack=[];
function checkpoint(){
    undoStack.push(JSON.stringify(doc.sheets));
    if(undoStack.length>60)undoStack.shift();
    redoStack.length=0;
}
function restore(from,to){
    if(!from.length)return;
    to.push(JSON.stringify(doc.sheets));doc.sheets=JSON.parse(from.pop());
    select(target,sheet()?.id??null);
}
$('undo').onclick=()=>restore(undoStack,redoStack);
$('redo').onclick=()=>restore(redoStack,undoStack);
const cache = new Map();
let activeSheet=null,selectedDim=null;
const dimensionRows=new Map();
const sheet = () => doc.sheets.find(s => s.part === target && s.id === activeSheet);
const isAssembly = model => model?.format === 'MetricCAD-assembly';
function status(message,error=false){ $('status').textContent=message; $('status').className=error?'error':''; }
function element(tag,parent,text){
    const item=document.createElement(tag); if(text!==undefined)item.textContent=text; parent.append(item); return item;
}
function svg(tag,parent,attrs,text){
    const item=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [k,v] of Object.entries(attrs))item.setAttribute(k,v);
    if(text!==undefined)item.textContent=text;
    parent.append(item);return item;
}
function catalog(){
    if(!doc.model)return [];
    const entries=[{id:null,name:doc.name,count:1}];
    if(isAssembly(doc.model)){
        const counts=new Map();
        for(const i of doc.model.instances)counts.set(i.part,(counts.get(i.part)||0)+1);
        for(const p of doc.model.parts)if(counts.has(p.id))entries.push({id:p.id,name:p.name||p.id,count:counts.get(p.id)});
    }
    return entries;
}
function resetTool(){anchors=[];placing=null;tool='';}
const collapsed=new Set();
function tree(){
    const root=$('tree');root.replaceChildren();dimensionRows.clear();
    const entries=catalog();
    if(!entries.length){element('p',root,'Teil oder Baugruppe öffnen.');return;}
    const parts=entries.slice(1);
    for(const s of doc.sheets){
        if(s.part!==null&&!parts.some(p=>p.id===s.part))parts.push({id:s.part,name:s.name,count:0});
    }
    function button(parent,label,path,active,action){
        const b=element('button',parent);
        const icon=svg('svg',b,{viewBox:'0 0 24 24','aria-hidden':'true'});
        svg('path',icon,{d:path});element('span',b,label);
        b.title=label;b.classList.toggle('active',active);b.onclick=action;return b;
    }
    function node(parent,item){
        const sheets=doc.sheets.filter(s=>s.part===item.id);
        const children=item.id===null?parts:[];
        const head=element('div',parent);head.className='tree-head';
        const open=!collapsed.has(item.id);
        if(sheets.length||children.length){
            const arrow=element('button',head,open?'⌄':'›');arrow.className='toggle';
            arrow.setAttribute('aria-label',item.name+(open?' zuklappen':' aufklappen'));
            arrow.setAttribute('aria-expanded',String(open));
            arrow.onclick=()=>{if(open)collapsed.add(item.id);else collapsed.delete(item.id);tree();};
        }
        const suffix=item.id===null?'':item.count?' · '+item.count+' Stk.':' · Teil fehlt';
        button(head,item.name+suffix,'M2 7l10-5 10 5-10 5z M2 7v10l10 5 10-5V7 M12 12v10',
            target===item.id&&!sheet(),()=>select(item.id));
        if(!open||(!sheets.length&&!children.length))return;
        const group=element('div',parent);group.className='tree-branch';
        sheets.forEach((s,i)=>{
            const active=s===sheet();
            button(group,'Blatt '+(i+1)+(s.title?' · '+s.title:''),'M5 2h9l5 5v15H5z M14 2v6h5',
                active&&!selectedDim,()=>select(item.id,s.id));
            if(!active||!s.dims.length)return;
            const branch=element('div',group);branch.className='tree-branch';
            s.dims.forEach((dim,index)=>{
                const label='Maß '+(index+1);
                const row=button(branch,label,'M2 7v10m20-10v10M3 12h18m-14-3-4 3 4 3m10-6 4 3-4 3',
                    selectedDim===dim,()=>{resetTool();selectedDim=dim;render();});
                dimensionRows.set(dim,row);
            });
        });
        for(const child of children)node(group,child);
    }
    node(root,entries[0]);
}
let meshes=null,viewer=null,viewerReady=false,projection={},pickedLabel='';
async function requestGeometry(path,payload){
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Geometrie konnte nicht berechnet werden.');
    return data;
}
function getMeshes(model){return requestGeometry(isAssembly(model)?'/assembly/build':'/build',model);}
function sceneItems(part){
    if(!isAssembly(doc.model))return [{mesh:meshes,instance:''}];
    if(part!==null)return [{mesh:meshes.parts[part].mesh,instance:''}];
    return doc.model.instances.map(i=>({mesh:meshes.parts[i.part].mesh,transform:meshes.transforms[i.id],instance:i.id,color:i.color}));
}
function projectionLabel(){
    $('projectionFace').textContent=(pickedLabel||'Vorderansicht')+' · '+(projection.turns||0)*90+'°';
}
async function select(part,id=null){
    selectedDim=null;activeSheet=id;target=part;viewerReady=false;resetTool();projection={};pickedLabel='';
    const ticket=++generation;
    const s=sheet(),key=JSON.stringify([part,s?.projection||{}]);
    geometry=s?cache.get(key)||null:null;
    loading=!!doc.model;render();
    try{
        if(!doc.model)return;
        if(!catalog().some(e=>e.id===part))throw Error('Modellbezug fehlt. Blatt im Projekt erhalten.');
        if(s){
            if(!geometry){
                const data=await requestGeometry('/drawing/views',{model:doc.model,part,projection:s.projection});
                if(ticket!==generation)return;
                geometry=data;cache.set(key,data);
            }
            status('Zeichnungsblatt geöffnet.');
        }else{
            if(!meshes){
                const data=await getMeshes(doc.model);
                if(ticket!==generation)return;
                meshes=data;
            }
            viewer??=createModelViewer($('modelView'),f=>{
                projection={face:f.face,instance:f.instance,turns:0};pickedLabel=f.label||f.face;projectionLabel();
            });
            viewer.load(sceneItems(part));viewerReady=true;status('3D-Modell · Ebene Fläche für die Hauptansicht wählen.');
        }
    }catch(e){if(ticket===generation)status(e.message,true);}
    finally{if(ticket===generation){loading=false;render();}}
}
$('turnProjection').onclick=()=>{projection.turns=((projection.turns||0)+1)%4;viewer.align(projection.turns);projectionLabel();};
$('resetProjection').onclick=()=>{projection={};pickedLabel='';viewer.reset();projectionLabel();};
function checkModel(model){
    if(isAssembly(model) && Array.isArray(model.parts) && Array.isArray(model.instances))return;
    if(Array.isArray(model?.features) && model.features.length)return;
    throw Error('Bitte eine MetricCAD-Teil- oder Baugruppendatei wählen.');
}
async function importModel(update,expectAssembly){
    if(!window.showOpenFilePicker)throw Error('Zum Öffnen lokaler Dateien bitte Chrome oder Edge verwenden.');
    const [handle]=await window.showOpenFilePicker({types:[{description:'MetricCAD JSON',accept:{'application/json':['.json']}}]});
    const file=await handle.getFile(),model=JSON.parse(await file.text());checkModel(model);
    if(!update && isAssembly(model)!==expectAssembly)throw Error(expectAssembly?'Bitte eine Baugruppen-JSON wählen.':'Bitte eine Teil-JSON wählen.');
    if(update&&isAssembly(model)!==isAssembly(doc.model))throw Error('Modelltyp stimmt nicht mit dem Zeichnungsprojekt überein.');
    const name=model.name||file.name.replace(/\.json$/i,'');
    // Compute before replacing the snapshot, so a broken update leaves the project usable.
    const data=await getMeshes(model);
    if(!update){doc=emptyProject();collapsed.clear();}
    undoStack.length=redoStack.length=0;
    doc.model=model;doc.name=name;cache.clear();meshes=data;
    for(const s of doc.sheets){const item=catalog().find(i=>i.id===s.part);if(item)s.name=item.name;}
    await select(update?target:null,update?activeSheet:null);return true;
}
function validSheet(s){
    return s && (s.part===null||typeof s.part==='string') && typeof s.name==='string' &&
        ['A4','A3'].includes(s.format) && (s.scale===0||scales.includes(s.scale)) &&
        Array.isArray(s.views)&&s.views.length>0&&new Set(s.views).size===s.views.length&&s.views.every(v=>Object.hasOwn(viewNames,v)) &&
        Array.isArray(s.dims)&&s.dims.every(d=>Object.hasOwn(viewNames,d.view)&&
            ['horizontal','vertical','length','diameter','gap'].includes(d.kind)&&Array.isArray(d.refs)&&
            d.refs.length===(['horizontal','vertical','gap'].includes(d.kind)?2:1)&&d.refs.every(r=>typeof r?.key==='string'&&[0,1].includes(r.end))&&
            Array.isArray(d.at)&&d.at.length===2&&d.at.every(Number.isFinite));
}
const files=bindProjectFiles({defaultName:'Werkstattzeichnung.json',blocked:()=>loading,replace:async value=>{
    if(value){
        if(value.format!=='MetricCAD-drawing'||value.version!==1||!Array.isArray(value.sheets)||!value.sheets.every(validSheet))throw Error('Ungültiges Zeichnungsprojekt. Für Teile und Baugruppen „Modell öffnen“ wählen.');
        checkModel(value.model);
        const ids=new Set();
        for(const s of value.sheets){
            if(typeof s.id!=='string'||!s.id||ids.has(s.id))s.id=crypto.randomUUID();
            ids.add(s.id);
        }
    }
    undoStack.length=redoStack.length=0;doc=value||emptyProject();meshes=null;cache.clear();collapsed.clear();await select(doc.sheets[0]?.part??null,doc.sheets[0]?.id??null);return true;
}});
$('source').onclick=()=>files.switchTo(()=>importModel(false,false),true);
$('assemblySource').onclick=()=>files.switchTo(()=>importModel(false,true),true);
$('update').onclick=async()=>{
    if(!doc.model||loading)return;
    document.body.inert=true;
    try{await importModel(true);}catch(e){if(e.name!=='AbortError')status(e.message,true);}finally{document.body.inert=false;}
};
function defaults(){
    return {part:target,name:catalog().find(x=>x.id===target)?.name||'',format:'A4',scale:0,
        views:['front','top','right'],dims:[]};
}
$('create').onclick=()=>{
    if(loading||(!meshes&&!geometry))return;
    checkpoint();
    const s={...defaults(),id:crypto.randomUUID(),title:''};
    s.projection={...(sheet()?.projection||projection)};doc.sheets.push(s);collapsed.delete(null);collapsed.delete(target);
    return select(target,s.id);
};
$('deleteDim').onclick=()=>{
    const dimensions=sheet()?.dims,index=dimensions?.indexOf(selectedDim)??-1;
    if(index<0)return;
    checkpoint();dimensions.splice(index,1);selectedDim=null;resetTool();render();
};
$('sheetTitle').onchange=()=>{
    const s=sheet(),title=$('sheetTitle').value.trim();
    if(s&&title!==(s.title||'')){checkpoint();s.title=title;render();}
};
$('print').onclick=()=>window.print();
for(const n of scales){const option=element('option',$('scale'),scaleText(n));option.value=n;}
$('pdf').onclick=()=>{status('Im Druckdialog „Als PDF speichern“ wählen.');window.print();};
$('pageSettings').onclick=()=>$('format').focus();
for(const view of Object.keys(viewNames))$(view).onclick=()=>{
    const s=sheet(),enabled=s.views.includes(view);
    if(enabled && s.views.length===1)return;
    checkpoint();s.views=enabled?s.views.filter(v=>v!==view):[...s.views,view];resetTool();render();
};
for(const orientation of ['landscape','portrait'])$(orientation).onclick=()=>{
    if((sheet().orientation||'landscape')===orientation)return;
    checkpoint();sheet().orientation=orientation;resetTool();render();
};
for(const id of ['format','scale','hiddenEdges','centers','dimensions'])$(id).onchange=()=>{
    checkpoint();
    sheet()[id]=id==='format'?$(id).value:id==='scale'?Number($(id).value):$(id).checked;
    resetTool();render();
};
for(const mode of tools)$(mode).onclick=()=>{
    const enabled=mode!==tool;resetTool();if(enabled)tool=mode;render();
};
window.addEventListener('keydown',e=>{if(e.key==='Escape'){resetTool();render();}});
function bounds(lines){
    let x=Infinity,y=Infinity,r=-Infinity,b=-Infinity;
    for(const line of lines){
        if(line.hidden)continue;
        const [left,top,right,bottom]=line.box;
        x=Math.min(x,left);y=Math.min(y,top);r=Math.max(r,right);b=Math.max(b,bottom);
    }
    return Number.isFinite(x)?{x,y,w:r-x,h:b-y}:{x:0,y:0,w:0,h:0};
}
function pagePoint(event,page){
    return new DOMPoint(event.clientX,event.clientY).matrixTransform(page.getScreenCTM().inverse());
}
function drawLine(parent,a,b,color='#25303b',width=.22){
    return svg('line',parent,{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:color,'stroke-width':width});
}
function textAt(parent,x,y,text,size=3,attrs={}){
    return svg('text',parent,{x,y,'font-size':size,'font-family':'sans-serif',fill:'#182a38',...attrs},text);
}
function measure(parent,a,b,at,kind,value){
    const distance=Math.hypot(b[0]-a[0],b[1]-a[1]);
    let u=kind==='vertical'?[0,1]:kind==='horizontal'?[1,0]:distance?[ (b[0]-a[0])/distance,(b[1]-a[1])/distance ]:[1,0];
    const n=[-u[1],u[0]],foot=p=>{
        const t=(at[0]-p[0])*n[0]+(at[1]-p[1])*n[1];return [p[0]+t*n[0],p[1]+t*n[1]];
    };
    const aa=foot(a),bb=foot(b);
    for(const [p,q,other] of [[a,aa,bb],[b,bb,aa]]){
        drawLine(parent,p,q,'#516c78',.14);
        const sign=(other[0]-q[0])*u[0]+(other[1]-q[1])*u[1]>=0?1:-1;
        const back=q.map((v,i)=>v+1.6*sign*u[i]);
        svg('polygon',parent,{points:[q,back.map((v,i)=>v+.45*n[i]),back.map((v,i)=>v-.45*n[i])].map(p=>p.join(',')).join(' '),fill:'#25303b'});
    }
    drawLine(parent,aa,bb);
    const along=p=>p[0]*u[0]+p[1]*u[1];
    if((along(at)-along(aa))*(along(at)-along(bb))>0){
        const nearest=Math.abs(along(at)-along(aa))<Math.abs(along(at)-along(bb))?aa:bb;
        drawLine(parent,nearest,at);
    }
    const angle=Math.atan2(u[1],u[0])*180/Math.PI;
    const rotation=angle>89?angle-180:angle< -90?angle+180:angle;
    return textAt(parent,at[0],at[1]-1,number(value)+' mm',2.8,{'text-anchor':'middle',transform:'rotate('+rotation+' '+at[0]+' '+at[1]+')'});
}
// Project a center or parallel edge onto the other edge's extended line.
function gapPoints(a,b){
    if(a.center && b.center)return [a.center,b.center];
    if(!b.ends)return gapPoints(b,a);
    const [p,q]=b.ends,dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy);
    if(!length)return null;
    if(a.ends){
        const [r,t]=a.ends,ax=t[0]-r[0],ay=t[1]-r[1];
        if(Math.abs(ax*dy-ay*dx)>1e-6*Math.hypot(ax,ay)*length)return null;
    }
    const start=a.center||a.ends[0].map((x,k)=>(x+a.ends[1][k])/2);
    const u=((start[0]-p[0])*dx+(start[1]-p[1])*dy)/(length*length);
    return [start,[p[0]+u*dx,p[1]+u*dy]];
}
function drawAnnotation(group,d,edges,to,scale,at){
    const edge=edges[0];
    if(d.kind==='diameter'){
        const c=to(edge.center),dx=at[0]-c[0],dy=at[1]-c[1],len=Math.hypot(dx,dy)||1;
        drawLine(group,[c[0]+dx/len*edge.diameter/(2*scale),c[1]+dy/len*edge.diameter/(2*scale)],at);
        return textAt(group,...at,'Ø '+number(edge.diameter),2.8);
    }
    const pts=d.kind==='length'?edge.ends:d.kind==='gap'?gapPoints(...edges):
        edges.map((e,j)=>e.center||e.ends[d.refs[j].end]);
    if(!pts)return null;
    const dx=pts[1][0]-pts[0][0],dy=pts[1][1]-pts[0][1];
    return measure(group,to(pts[0]),to(pts[1]),at,d.kind,d.kind==='horizontal'?Math.abs(dx):
        d.kind==='vertical'?Math.abs(dy):Math.hypot(dx,dy));
}
function render(){
    tree();
    const s=sheet(),area=$('preview');area.replaceChildren();
    const ready=Boolean(s&&geometry);
    $('deleteDim').hidden=!s?.dims.includes(selectedDim);
    const modelMode=Boolean(doc.model&&!s&&catalog().some(e=>e.id===target));
    $('modelView').hidden=!modelMode||!viewerReady;
    $('projectionPanel').hidden=$('modelView').hidden;
    area.hidden=!$('modelView').hidden;projectionLabel();
    if(area.hidden)viewer.draw();
    $('settings').hidden=!ready;$('create').disabled=loading||(!ready&&!(modelMode&&meshes));
    for(const id of ['print','pdf','pageSettings',...tools,...Object.keys(viewNames)])$(id).disabled=!ready;
    for(const id of tools)$(id).setAttribute('aria-pressed',String(ready&&tool===id));
    for(const id of Object.keys(viewNames))$(id).setAttribute('aria-pressed',String(ready&&s.views.includes(id)));
    $('update').disabled=!doc.model||loading;$('save').disabled=!doc.model;
    $('undo').disabled=!undoStack.length||loading;$('redo').disabled=!redoStack.length||loading;
    if(!geometry){area.textContent=loading?'Ansicht wird berechnet …':modelMode&&meshes?'3D-Vorschau nicht verfügbar. Ein Blatt mit Standardansicht kann erstellt werden.':doc.model?'Keine Ansicht verfügbar.':'Teil oder Baugruppe für die Werkstattzeichnung wählen.';return;}
    const spec=s;
    $('sheetTitle').value=spec.title||'';
    $('format').value=spec.format;$('scale').value=spec.scale;
    for(const id of ['hiddenEdges','centers','dimensions'])$(id).checked=spec[id]??(id==='dimensions');
    for(const o of ['landscape','portrait'])$(o).setAttribute('aria-pressed',String((spec.orientation||'landscape')===o));
    $('hint').textContent=placing?(anchors.length===1&&(!tool||tool==='autoDim')?'Maß ins Freie setzen oder zweite Kante wählen.':'Maßposition auf dem Blatt anklicken.'):tool==='length'?'Gerade Kante wählen.':tool==='diameter'?'Kreis wählen.':tool&&tool!=='autoDim'?'Zwei Kantenenden oder Kreismittelpunkte in derselben Ansicht wählen.':'Kante oder Kreis wählen, optional zweite Kante, dann Maß ins Freie setzen. Maßzahl ziehen zum Verschieben.';
    const size=spec.format==='A3'?[420,297]:[297,210];
    const [w,h]=spec.orientation==='portrait'?size.reverse():size;
    document.documentElement.style.setProperty('--paper-ratio',w/h);
    document.documentElement.style.setProperty('--pw',w+'mm');document.documentElement.style.setProperty('--ph',h+'mm');
    $('paperSize').textContent='@page {size:'+w+'mm '+h+'mm;margin:0}';
    const viewport=svg('svg',area,{viewBox:'0 0 '+w+' '+h,'aria-label':'Zeichnungsblatt'});
    const page=svg('g',viewport,{class:'sheet-content'});
    const viewKey=JSON.stringify([s.id,w,h]);
    if(sheetView.key!==viewKey)sheetView={key:viewKey,z:1,x:0,y:0};
    function applyZoom(){
        page.setAttribute('transform',`translate(${sheetView.x} ${sheetView.y}) scale(${sheetView.z})`);
    }
    applyZoom();
    svg('rect',page,{x:5,y:5,width:w-10,height:h-10,fill:'white',stroke:'#283c47','stroke-width':.35});
    // First-angle layout: right view to the left, top view below the front view.
    const cells={front:[1,0],top:[1,1],right:[0,0]};
    const columns=[...new Set(spec.views.map(v=>cells[v][0]))].sort();
    const levels=[...new Set(spec.views.map(v=>cells[v][1]))].sort();
    const cols=columns.length,rows=levels.length;
    const cw=(w-14)/cols,ch=(h-32)/rows;
    const needed=Math.max(...spec.views.map(v=>{const b=bounds(geometry[v]);return Math.max(b.w/(cw-24),b.h/(ch-21));}));
    const scale=spec.scale||scales.find(n=>n>=needed)||Math.ceil(needed);
    const layouts={};
    let dragging=null;
    viewport.addEventListener('wheel',e=>{
        e.preventDefault();
        if(dragging||!e.deltaY)return;
        const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?viewport.clientHeight:1);
        const z=Math.min(32,Math.max(1,sheetView.z*Math.exp(-delta*.002)));
        if(z===sheetView.z)return;
        const p=pagePoint(e,viewport),ratio=z/sheetView.z;
        // Keep the cursor over the same paper point and stay inside the sheet.
        sheetView.x=Math.max(w*(1-z),Math.min(0,p.x-(p.x-sheetView.x)*ratio));
        sheetView.y=Math.max(h*(1-z),Math.min(0,p.y-(p.y-sheetView.y)*ratio));
        sheetView.z=z;applyZoom();
        if(placing)viewport.onpointermove(e);
    },{passive:false});
    function revealDimension(dim){
        selectedDim=dim;collapsed.delete(null);collapsed.delete(target);
        render();
        dimensionRows.get(dim)?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    function draggable(dim,label,group,at,paint,save){
        label.classList.add('dim-target');
        label.onclick=e=>{if(!placing)e.stopPropagation();};
        label.onpointerdown=e=>{
            if(e.button!==0||placing||anchors.length)return;
            e.preventDefault();e.stopPropagation();
            const start=pagePoint(e,page);
            viewport.setPointerCapture(e.pointerId);
            dragging={id:e.pointerId,start,at,group,paint,save,dim};
        };
    }
    spec.views.forEach(v=>{
        const lines=geometry[v],b=bounds(lines),cx=7+cw*(columns.indexOf(cells[v][0])+.5),cy=7+ch*(levels.indexOf(cells[v][1])+.5);
        const to=p=>[cx+(p[0]-b.x-b.w/2)/scale,cy+(p[1]-b.y-b.h/2)/scale];
        const lookup=new Map(lines.filter(e=>e.ref).map(e=>[e.ref,e]));
        layouts[v]={to,cx,cy,lookup};
        textAt(page,cx,cy-ch/2+4,viewNames[v],2.8,{'text-anchor':'middle'});
        for(const edge of [...lines.filter(e=>e.hidden),...lines.filter(e=>!e.hidden)]){
            if(edge.hidden&&!spec.hiddenEdges)continue;
            const points=edge.points.map(to).map(p=>p.join(',')).join(' ');
            if(edge.hidden){
                svg('polyline',page,{points,fill:'none',stroke:'#67727a','stroke-width':.18,'stroke-dasharray':'2 1'});continue;
            }
            if(spec.centers&&edge.center){
                const [x,y]=to(edge.center),r=edge.diameter/(2*scale)+2;
                for(const [a,b] of [[[x-r,y],[x+r,y]],[[x,y-r],[x,y+r]]])
                    drawLine(page,a,b,'#637581',.15).setAttribute('stroke-dasharray','3 .7 .5 .7');
            }
            const picked=anchors.some(r=>r.view===v&&r.key===edge.ref);
            svg('polyline',page,{points,fill:'none',stroke:picked?'#18877a':'#18232d','stroke-width':picked ? .65 : .35});
            const automatic=!tool||tool==='autoDim';
            if(spec.dimensions===false||!edge.ref||(placing&&!(automatic&&anchors.length===1)))continue;
            if(tool==='diameter'&&!edge.center||tool==='length'&&!edge.ends)continue;
            const path=svg('polyline',page,{points,class:'edge-hit'});
            path.onclick=event=>{
                event.stopPropagation();const p=pagePoint(event,page);
                let end=0;
                if(edge.ends){const distances=edge.ends.map(q=>{const [x,y]=to(q);return Math.hypot(x-p.x,y-p.y);});end=+(distances[1]<distances[0]);}
                if(anchors.length&&anchors[0].view!==v){status('Beide Bezüge in derselben Ansicht wählen.',true);return;}
                if(anchors.some(r=>r.key===edge.ref&&r.end===end)){status('Weitere Kante oder freie Maßposition wählen.');return;}
                if(automatic&&anchors.length){
                    const first=lookup.get(anchors[0].key);
                    if(first===edge||!gapPoints(first,edge)){status('Für einen Kantenabstand zwei parallele Kanten wählen.',true);return;}
                }
                anchors.push({view:v,key:edge.ref,end});
                const kind=automatic?(anchors.length===2?'gap':edge.center?'diameter':'length'):tool;
                if(automatic||kind==='length'||kind==='diameter'||anchors.length===2){
                    placing={view:v,kind,refs:anchors.map(({key,end})=>({key,end}))};
                }
                render();
            };
        }
        if(anchors.length&&anchors[0].view===v){
            const a=anchors[0],edge=lookup.get(a.key),pt=to(edge.center||edge.ends[a.end]);
            svg('circle',page,{cx:pt[0],cy:pt[1],r:1.2,fill:'#197b70','pointer-events':'none'});
        }

    });
    let missingCount=0;
    for(const d of spec.dims){
        const layout=layouts[d.view],edges=d.refs.map(r=>geometry[d.view].find(e=>e.ref===r.key));
        const missing=edges.some(e=>!e);
        const row=dimensionRows.get(d);
        function markMissing(){
            missingCount++;
            if(row){row.classList.add('missing');row.title+=' · Bezug prüfen';row.lastElementChild.textContent=row.title;}
        }
        if(missing){markMissing();continue;}
        if(!layout||spec.dimensions===false)continue;
        const {to,cx,cy}=layout,at=[cx+d.at[0],cy+d.at[1]];
        const group=svg('g',page,{'pointer-events':'none'});
        const paint=(g,pos)=>drawAnnotation(g,d,edges,to,scale,pos);
        const label=paint(group,at);
        if(!label){markMissing();continue;}
        if(row){row.title+=' · '+label.textContent;row.lastElementChild.textContent=row.title;}
        if(selectedDim===d)group.classList.add('selected-dimension');
        if(!tool&&!placing&&!anchors.length){
            group.setAttribute('pointer-events','visiblePainted');
            group.onclick=e=>{e.stopPropagation();revealDimension(d);};
        }
        draggable(d,label,group,at,paint,pos=>{d.at=[pos[0]-cx,pos[1]-cy];});
    }
    const overlay=svg('g',page,{'pointer-events':'none',class:'dimension-preview'});
    viewport.onpointermove=e=>{
        const p=pagePoint(e,page);
        if(dragging){
            if(e.pointerId!==dragging.id)return;
            const dx=p.x-dragging.start.x,dy=p.y-dragging.start.y;
            dragging.pos=[dragging.at[0]+dx,dragging.at[1]+dy];
            dragging.group.setAttribute('visibility','hidden');
            overlay.replaceChildren();dragging.paint(overlay,dragging.pos);
        }else if(placing){
            const {lookup,to}=layouts[placing.view];
            overlay.replaceChildren();
            drawAnnotation(overlay,placing,placing.refs.map(r=>lookup.get(r.key)),to,scale,[p.x,p.y]);
        }
    };
    viewport.onpointerleave=()=>{if(!dragging)overlay.replaceChildren();};
    viewport.onpointerup=e=>{
        if(!dragging||dragging.id!==e.pointerId)return;
        const p=pagePoint(e,page),dx=p.x-dragging.start.x,dy=p.y-dragging.start.y;
        if(Math.hypot(dx,dy)>.1){checkpoint();dragging.save([dragging.at[0]+dx,dragging.at[1]+dy]);}
        const dim=dragging.dim;dragging=null;revealDimension(dim);
    };
    viewport.onpointercancel=()=>{if(dragging){dragging=null;render();}};
    viewport.onclick=e=>{
        if(!placing||!s)return;
        const {view,kind,refs}=placing,{cx,cy}=layouts[view],p=pagePoint(e,page);
        checkpoint();s.dims.push({view,kind,refs,at:[p.x-cx,p.y-cy]});
        anchors=[];placing=null;render();
    };
    const boxX=w-80;
    svg('rect',page,{x:boxX,y:h-24,width:75,height:19,fill:'white',stroke:'#283c47','stroke-width':.35});
    drawLine(page,[boxX,h-14],[w-5,h-14]);textAt(page,boxX+3,h-17,spec.title||spec.name,3.6);
    const count=catalog().find(item=>item.id===target)?.count||1;
    textAt(page,boxX+3,h-8,scaleText(scale)+'     |     mm     |     '+spec.format+'     |     '+count+' Stk.',3);
    if(missingCount)textAt(page,9,h-21,missingCount+' Maßbezüge prüfen',3,{fill:'#a34029'});
    if(scale<needed)textAt(page,9,10,'Maßstab für die Blattfläche zu groß',3,{fill:'#a34029'});
}
// One depth-tested mesh buffer serves both display and face picking.
function createModelViewer(canvas,onPick){
    const gl=canvas.getContext('webgl',{antialias:true});
    if(!gl)throw Error('Für die 3D-Ansicht wird WebGL benötigt.');
    const program=gl.createProgram();
    function shader(type,source){
        const object=gl.createShader(type);gl.shaderSource(object,source);gl.compileShader(object);
        if(!gl.getShaderParameter(object,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(object));
        gl.attachShader(program,object);gl.deleteShader(object);
    }
    shader(gl.VERTEX_SHADER,`
        attribute vec3 pos, color, code;
        uniform vec3 center, right, up, depth, scale, selected;
        uniform bool picking;
        varying vec3 paint;
        void main(){
            vec3 v=pos-center;
            gl_Position=vec4(vec3(dot(v,right),dot(v,up),-dot(v,depth))*scale,1.);
            paint=picking?code:all(equal(code,selected))?mix(color,vec3(1.,.73,.24),.72):color;
        }`);
    shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 paint;void main(){gl_FragColor=vec4(paint,1.);}');
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const uniform=Object.fromEntries(['center','right','up','depth','scale','selected','picking'].map(k=>[k,gl.getUniformLocation(program,k)]));
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    ['pos','color','code'].forEach((k,i)=>{const a=gl.getAttribLocation(program,k);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,3,gl.FLOAT,false,36,i*12);});
    const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const unit=a=>a.map(x=>x/(Math.hypot(...a)||1));
    const mix=(a,b,t)=>unit(a.map((x,i)=>x*Math.cos(t)+b[i]*Math.sin(t)));
    const code=id=>[id&255,(id>>8)&255,(id>>16)&255].map(n=>n/255);
    let right,up,depth,center,radius,faces=[],selected=0,count=0,zoom=1,drag=null;
    function camera(r,n){depth=unit(n);up=unit(cross(depth,r));right=unit(cross(up,depth));}
    function draw(picking=false){
        if(canvas.hidden||!count)return;
        const ratio=Math.min(2,window.devicePixelRatio||1);
        const w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));
        if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
        gl.viewport(0,0,w,h);gl.clearColor(picking?0:.043,picking?0:.078,picking?0:.118,1);
        gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.disable(gl.DITHER);
        for(const [k,v] of Object.entries({center,right,up,depth,selected:code(selected),
            scale:[Math.min(w,h)/w*zoom/radius,Math.min(w,h)/h*zoom/radius,0.95/radius]}))gl.uniform3fv(uniform[k],v);
        gl.uniform1i(uniform.picking,picking?1:0);gl.drawArrays(gl.TRIANGLES,0,count);
    }
    function load(items){
        const data=[],lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];faces=[null];selected=0;zoom=.9;
        for(const {mesh,transform,instance,color} of items){
            const rotate=p=>transform?transform.slice(0,3).map(row=>dot(row.slice(0,3),p)):p;
            const pts=mesh.vertices.map(p=>rotate(p).map((v,i)=>v+(transform?.[i][3]||0)));
            for(const p of pts)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p[k]);hi[k]=Math.max(hi[k],p[k]);}
            const first=faces.length;
            for(const face of mesh.faces)faces.push(face.planar&&face.key&&face.frame?{
                face:face.key,instance,label:face.label,n:rotate(face.frame.n),u:rotate(face.frame.u)
            }:null);
            const base=/^#[0-9a-f]{6}$/i.test(color)?[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255):[.32,.72,.68];
            mesh.triangles.forEach((triangle,i)=>{
                const [a,b,c]=triangle.map(j=>pts[j]);
                const normal=unit(cross(b.map((v,k)=>v-a[k]),c.map((v,k)=>v-a[k])));
                const shade=.5+.5*Math.abs(dot(normal,[.35,-.48,.8]));
                const rgb=base.map(x=>x*shade),id=code(first+mesh.triangleFaces[i]);
                for(const p of [a,b,c])data.push(...p,...rgb,...id);
            });
        }
        count=data.length/9;
        if(!count)throw Error('Modell enthält keine darstellbaren Flächen.');
        center=lo.map((v,k)=>(v+hi[k])/2);radius=Math.max(.001,Math.hypot(...hi.map((v,k)=>v-lo[k]))/2);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
        camera([1,.6,0],[.6,-1,.55]);draw();
    }
    function align(turns){
        const f=faces[selected];camera(f?.u||[1,0,0],f?.n||[0,-1,0]);
        for(let i=0;i<turns;i++)camera(up,depth);
        draw();
    }
    canvas.onpointerdown=e=>{
        if(e.button!==0||drag)return;
        canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};
    };
    canvas.onpointermove=e=>{
        if(drag?.id!==e.pointerId)return;
        const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
        if(!drag.moved&&Math.hypot(dx,dy)<3)return;
        drag.moved=true;camera(mix(right,depth,dx*.009),mix(depth,right,-dx*.009));
        camera(right,mix(depth,up,dy*.009));drag.x=e.clientX;drag.y=e.clientY;draw();
    };
    canvas.onpointercancel=()=>{drag=null;};
    canvas.onpointerup=e=>{
        if(drag?.id!==e.pointerId)return;
        const click=!drag.moved;drag=null;if(!click)return;
        draw(true);const rect=canvas.getBoundingClientRect(),pixel=new Uint8Array(4);
        gl.readPixels(Math.floor((e.clientX-rect.left)*canvas.width/rect.width),canvas.height-1-Math.floor((e.clientY-rect.top)*canvas.height/rect.height),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        const id=pixel[0]+256*pixel[1]+65536*pixel[2];
        if(faces[id]){selected=id;onPick(faces[id]);align(0);}
        else{draw();if(id)status('Eine eindeutig referenzierbare ebene Fläche wählen.',true);}
    };
    canvas.onwheel=e=>{e.preventDefault();zoom=Math.min(15,Math.max(.15,zoom*Math.exp(-e.deltaY*.001)));draw();};
    new ResizeObserver(()=>draw()).observe(canvas);
    return {load,align,draw,reset(){selected=0;align(0);}};
}

render();status('Bereit.');
