
'use strict';
const $=id=>document.getElementById(id),uid=()=>crypto.randomUUID(),fresh=()=>({version:2,features:[]});
let doc=fresh(),mesh=null,selected=null,selectedFace=null,plane=null,context=null,tool=null,bind=null,repair=null,mode='3d',dirty=false,busy=false,history=[],future=[],lastError='',zoom=1,pan=[0,0],yaw=-.7,pitch=.65,drag=null,hoverFace=null,pending=false;
let selectedKind='sketch',hoverPlane=null,originVisible=true,waitingPlane=false;const collapsedNodes=new Set();
const overlay=$('overlay'),ctx=overlay.getContext('2d'),glCanvas=$('gl');let W=1,H=1,DPR=1;
const gl=glCanvas.getContext('webgl',{antialias:true,alpha:false});
let shader=null,buffer=null,loc={};
if(gl){const vs='attribute vec3 p; attribute vec3 c; varying vec3 color; void main(){gl_Position=vec4(p,1.0);color=c;}';const fs='precision mediump float; varying vec3 color; void main(){gl_FragColor=vec4(color,1.0);}';const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};shader=gl.createProgram();gl.attachShader(shader,compile(gl.VERTEX_SHADER,vs));gl.attachShader(shader,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(shader);if(!gl.getProgramParameter(shader,gl.LINK_STATUS))throw Error('WebGL konnte nicht initialisiert werden');buffer=gl.createBuffer();loc={p:gl.getAttribLocation(shader,'p'),c:gl.getAttribLocation(shader,'c')};gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL)}
const sub=(a,b)=>a.map((x,i)=>x-b[i]),add=(a,b)=>a.map((x,i)=>x+b[i]),mul=(a,s)=>a.map(x=>x*s),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>mul(a,1/(Math.hypot(...a)||1));
function planeInfo(p){const [u,n]=p==='XY'?[[1,0,0],[0,0,1]]:p==='XZ'?[[1,0,0],[0,-1,0]]:[[0,1,0],[1,0,0]];return {frame:{o:[0,0,0],u,v:cross(n,u),n},edges:[],targets:{},bounds:[-50,50,-50,50]}}
function cur(){return doc.features.find(f=>f.id===selected)}
function layout(f){return mesh?.layouts.find(l=>l.id===f?.id)}
function status(s,error=false){$('status').textContent=s;$('status').className=error?'error':''}
function stash(){if(new URLSearchParams(location.hash.slice(1)).has('assembly-edit'))return;try{localStorage.setItem('minicad-v2',JSON.stringify(doc))}catch{}window.metriccadSync?.changed();}
function mutate(fn){history.push(JSON.stringify(doc));if(history.length>60)history.shift();future=[];fn();dirty=true;lastError='';stash();status('Änderungen offen · Aktualisieren berechnet den Körper.');render()}
function selectedInfo(){return mesh?.faces.find(f=>f.key===selectedFace)}
function syncContext(){if(context?.id){const f=doc.features.find(f=>f.id===context.id),l=layout(f);if(f&&l)context={id:f.id,support:f.support,info:l};else if(!f)context=null}else if(context?.support.face){const a=mesh?.faces.find(f=>f.key===context.support.face);if(a?.frame)context.info=a}}
function input(label,value,fn){const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.type='number';i.step='0.5';i.value=value;i.onchange=()=>{const v=Number(i.value);if(!Number.isFinite(v)){status('Bitte eine gültige Zahl eingeben.',true);return}mutate(()=>fn(v));autoUpdate()};i.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();i.blur()}};$('edit').append(l,i)}
function button(text,fn,parent='edit'){const b=document.createElement('button');b.textContent=text;b.onclick=fn;$(parent).append(b);return b}
function note(text,cls='hint'){const p=document.createElement('p');p.className=cls;p.textContent=text;$('edit').append(p)}
function originPlanes(){if(!originVisible||mode!=='3d')return[];const size=42;return ['XY','XZ','YZ'].map(name=>{const f=planeInfo(name).frame,world=[[0,0],[size,0],[size,size],[0,size]].map(([u,v])=>add(mul(f.u,u),mul(f.v,v)));return{name,points:world.map(project),label:project(add(mul(f.u,size*.7),mul(f.v,size*.7))),color:{XY:[86,170,238],XZ:[235,168,83],YZ:[87,198,153]}[name]}})}
function triangleDepth(p,a,b,c){const den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-7)return null;const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/den,v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/den,w=1-u-v;return u>=0&&v>=0&&w>=0?u*a[2]+v*b[2]+w*c[2]:null;}
function hitOriginPlane(x,y){const planes=originPlanes();for(const p of planes){if(Math.abs(x-p.label[0])<20&&Math.abs(y-p.label[1])<13)return p.name}let hit=null,nearest=-Infinity;for(const p of planes){for(const t of [[0,1,2],[0,2,3]]){const d=triangleDepth([x,y],...t.map(i=>p.points[i]));if(d!==null&&d>nearest){nearest=d;hit=p.name}}}return hit;}
function drawOriginPlanes(){const planes=originPlanes().sort((a,b)=>a.points.reduce((s,p)=>s+p[2],0)-b.points.reduce((s,p)=>s+p[2],0));
 for(const p of planes){const hovered=hoverPlane===p.name,chosen=!selectedFace&&plane===p.name,c=p.color.join(',');ctx.beginPath();ctx.moveTo(p.points[0][0],p.points[0][1]);p.points.slice(1).forEach(q=>ctx.lineTo(q[0],q[1]));ctx.closePath();ctx.fillStyle=`rgba(${c},${hovered?.40:chosen?.29:.12})`;ctx.fill();ctx.strokeStyle=hovered?'#efffff':`rgba(${c},${chosen?1:.65})`;ctx.lineWidth=hovered||chosen?2:1;ctx.stroke();}
 for(const p of planes){const chosen=plane===p.name&&!selectedFace,hovered=hoverPlane===p.name;ctx.fillStyle=hovered?'#e5f4ff':chosen?'#1a5a55':'#172737';ctx.fillRect(p.label[0]-20,p.label[1]-13,40,26);ctx.strokeStyle=hovered?'#e5f4ff':`rgb(${p.color.join(',')})`;ctx.lineWidth=1;ctx.strokeRect(p.label[0]-20,p.label[1]-13,40,26);ctx.fillStyle=hovered?'#122333':'#e7f4ff';ctx.font='bold 12px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(p.name,p.label[0],p.label[1]);ctx.textAlign='start';ctx.textBaseline='alphabetic';ctx.font='12px system-ui';}
}
async function selectOriginPlane(p){plane=p;selectedFace=null;hoverPlane=p;hoverFace=null;selected=null;context=null;tool=bind=null;dimensionTool=false;closeDimensionEditor();if(repair){const f=doc.features.find(x=>x.id===repair);mutate(()=>{f.support={plane:p};delete f.rx;delete f.ry;f.dimensions=(f.dimensions||[]).filter(d=>![d.first?.kind,d.second?.kind].some(k=>k?.startsWith('support-')))});repair=null;waitingPlane=false;await update();return}render();if(waitingPlane){waitingPlane=false;await newSketch()}else status(p+'-Ebene ausgewählt · Oben „Neue Skizze“ wählen oder Ebene doppelklicken.');}

async function selectNode(f,kind){if(geometrySaving||busy)return;if(dirty&&!(await update()))return;edgeTool=null;edgeSelection=[];hoverEdge=null;selected=f.id;selectedKind=kind;selectedFace=null;dimensionTool=false;dimensionPicks=[];closeDimensionEditor();tool=bind=null;context=null;mode='3d';render();}
function symmetricExtentControl(f){const l=document.createElement('label');l.style.display='flex';l.style.gap='8px';const symmetric=document.createElement('input');symmetric.id='symmetricExtent';symmetric.type='checkbox';symmetric.style.width='auto';symmetric.checked=!!f.symmetric;symmetric.disabled=busy||geometrySaving;symmetric.onchange=()=>{const value=symmetric.checked;mutate(()=>f.symmetric=value);autoUpdate()};l.append(symmetric,document.createTextNode('Gespiegelte Ausdehnung'));$('edit').append(l);if(f.symmetric)note('Maß pro Seite: '+f.depth+' mm · Gesamtausdehnung: '+(2*f.depth)+' mm');}
function featureLabel(f){const index=doc.features.filter(x=>x.op===f.op).findIndex(x=>x.id===f.id)+1;return (f.op==='helix'?'Helix ':f.op==='sweep'?'Helix-Sweep ':f.op==='sweep-pocket'?'Helix-Abtrag ':f.op==='revolve'?'Rotationskörper ':f.op==='revolve-pocket'?'Rotationstasche ':f.op==='pad'?'Aufpolsterung ':f.op==='pocket'?'Tasche ':f.op==='fillet'?'Verrundung ':f.op==='chamfer'?'Fase ':'Skizze ')+index;}
function treeRow(parent,{key,label,icon,kind,f,children}){const row=document.createElement('div');row.className='node-row';
 if(children){const arrow=document.createElement('button');arrow.className='node-arrow';arrow.textContent=collapsedNodes.has(key)?'▸':'▾';arrow.setAttribute('aria-label',label+(collapsedNodes.has(key)?' aufklappen':' zuklappen'));arrow.setAttribute('aria-expanded',String(!collapsedNodes.has(key)));arrow.onclick=()=>{if(collapsedNodes.has(key))collapsedNodes.delete(key);else collapsedNodes.add(key);render()};row.append(arrow)}else{const spacer=document.createElement('span');spacer.className='node-spacer';row.append(spacer)}
 const name=document.createElement('button');name.className='node-name'+(f&&selected===f.id&&selectedKind===kind?' selected':'');name.title=label;name.setAttribute('aria-label',label);const symbol=document.createElement('span');symbol.className='node-icon';symbol.textContent=icon;const text=document.createElement('span');text.textContent=label;name.append(symbol,text);if(f){name.onclick=()=>selectNode(f,kind);if(kind==='sketch')name.ondblclick=()=>editSketch(f)}else name.onclick=()=>{if(collapsedNodes.has(key))collapsedNodes.delete(key);else collapsedNodes.add(key);render()};row.append(name);parent.append(row);
 if(children&&!collapsedNodes.has(key)){const group=document.createElement('div');group.className='node-children';parent.append(group);children(group)}
}
function renderTree(){const root=$('tree');root.replaceChildren();$('featureCount').textContent=doc.features.filter(f=>!isTreatment(f)).length+' Skizzen';treeRow(root,{key:'body',label:'Körper',icon:'◇',children:group=>{
 if(!doc.features.length){const p=document.createElement('p');p.className='hint';p.textContent='Noch keine Bearbeitungen';group.append(p)}
 for(const f of doc.features){if(isHelix(f))treeRow(group,{key:f.id,label:featureLabel(f),icon:'〰',kind:'feature',f});else if(isTreatment(f))treeRow(group,{key:f.id,label:featureLabel(f),icon:f.op==='fillet'?'◜':'◩',kind:'feature',f});else if(f.op==='sketch')treeRow(group,{key:f.id,label:f.name||'Skizze',icon:'▱',kind:'sketch',f});else treeRow(group,{key:f.id,label:featureLabel(f),icon:isRevolve(f)?'⟳':f.op==='pad'?'▰':'▣',kind:'feature',f,children:child=>treeRow(child,{key:f.id+'/sketch',label:f.name||'Skizze',icon:'▱',kind:'sketch',f})})}
 }});}
function render(){renderTree();const face=selectedInfo();$('supportLabel').textContent=selectedFace?'Auflage: '+(face?.label||'Flächenreferenz'):plane?'Auflage: '+plane+'-Ebene':'Ebene im Zeichenbereich auswählen';
 $('edit').replaceChildren();const f=cur();
 if(edgeTool){edgeDraftPanel();}
 else if(isHelix(f)){helixProperties(f);}
 else if(f&&isTreatment(f)){const title=document.createElement('div');title.className='property-title';title.textContent=featureLabel(f);$('edit').append(title);input(f.op==='fillet'?'Radius':'Symmetrisches Fasenmaß',f.amount,v=>f.amount=v);note(f.edges.length+' referenzierte Kante(n)');button('Bearbeitung löschen',()=>{mutate(()=>{doc.features=doc.features.filter(x=>x.id!==f.id);selected=null});update()}).className='danger';}
 else if(f){const title=document.createElement('div');title.className='property-title';title.textContent=selectedKind==='feature'?featureLabel(f):(f.name||'Skizze');$('edit').append(title);
 note(f.support.helix?'Auflage: Helixstart':f.support.plane?'Auflage: '+f.support.plane+'-Ebene':'Auflage: Körperfläche · '+f.support.face.split('/').pop());
 if(selectedKind==='feature'){
 if(isSweep(f))note('Länge und Richtung werden über die Helix gesteuert.');else if(isRevolve(f))input('Rotationswinkel (°)',f.revolveAngle,v=>f.revolveAngle=v);else input(f.op==='pocket'?'Taschentiefe':'Extrusionshöhe',f.depth,v=>f.depth=v);
 if(['pad','pocket'].includes(f.op))symmetricExtentControl(f);
 if(!isSweep(f)){const label=document.createElement('label');label.style.display='flex';label.style.gap='8px';const c=document.createElement('input');c.type='checkbox';c.style.width='auto';c.checked=!!f.reverse;c.id='reverseExtent';c.disabled=busy||(['pad','pocket'].includes(f.op)&&!!f.symmetric);c.onchange=()=>{const reverse=c.checked;mutate(()=>f.reverse=reverse);autoUpdate()};label.append(c,document.createTextNode('Richtung umkehren'));$('edit').append(label);}
 button('Zugehörige Skizze bearbeiten',()=>editSketch(f));
 }else{if(['sketch','pad','pocket'].includes(f.op))symmetricExtentControl(f);note((f.shape==='multi'?'Mehrfachskizze':f.shape==='circle'?'Kreis':'Rechteck')+' · '+(f.dimensions?.length||0)+' Maße');note('Skizze doppelklicken oder oben das Bearbeiten-Symbol wählen. Maßzahlen lassen sich direkt in der Zeichnung ändern.');if(f.op==='sketch')note('Noch ohne Bearbeitung. Oben Aufpolstern oder Tasche wählen.');if(!f.support.helix)button('Auflage neu wählen',()=>beginRepair(f));}
 button(selectedKind==='feature'?'Bearbeitung mit Skizze löschen':'Skizze und Bearbeitung löschen',()=>{if(!confirm('Diese Skizze samt Bearbeitung löschen? Nachfolgende Referenzen können verloren gehen.'))return;mutate(()=>{doc.features=doc.features.filter(x=>x.id!==f.id);selected=null;context=null});update()}).className='danger';
 }else if(context&&mode==='2d'){note('Skizze auf '+(context.support.plane||'Körperfläche'));note('Oben Rechteck oder Kreis wählen und mit gedrückter Maustaste zeichnen.');}
 else if(face){note(face.label);note('Oben das Symbol „Neue Skizze“ wählen.');}
 else{note(plane?'Ausgewählte Ebene: '+plane:'Mit der Maus über eine Ursprungsebene fahren und diese anklicken.');note('Das Skizzen-Symbol oben startet die Zeichnung. Ein Doppelklick auf eine Ebene startet direkt.');}
 if(mode==='2d'&&context)sketchViewPanel();
 $('view3').classList.toggle('active',mode==='3d');$('view2').classList.toggle('active',mode==='2d');$('dimension').classList.toggle('active',dimensionTool&&mode==='2d');$('rect').classList.toggle('active',tool==='rect');$('circle').classList.toggle('active',tool==='circle');$('origins').classList.toggle('active',originVisible&&mode==='3d');
 $('export').disabled=busy;$('exportStl').disabled=busy;$('undo').disabled=!history.length||busy;$('redo').disabled=!future.length||busy;$('update').disabled=busy;$('newSketch').disabled=busy;$('editSketchTool').disabled=!f||isTreatment(f)||busy;$('dimension').disabled=!f||isTreatment(f)||busy;$('padTool').disabled=!f||isTreatment(f)||busy;$('pocketTool').disabled=!f||isTreatment(f)||busy||!mesh?.vertices.length;
 for(const id of ['rect','circle'])$(id).disabled=busy||(!context&&!plane&&!selectedFace);$('dimAxis').disabled=!dimensionTool;
 for(const [id,kind] of [['filletTool','fillet'],['chamferTool','chamfer']]){$(id).disabled=busy||!mesh?.vertices.length;$(id).classList.toggle('active',edgeTool===kind)}
 $('empty').style.display=!doc.features.length&&mode==='3d'?'block':'none';$('notice').textContent=lastError||(dirty?(mode==='2d'?'Skizze aktuell · 3D wird beim Verlassen der Skizze aktualisiert.':'3D zeigt den letzten berechneten Stand. Bitte aktualisieren.'):'');draw();
}
function bound3(){return mesh?.vertices.length?mesh.bounds:[-50,50,-50,50,-30,30]}
function camera(){const b=bound3();return {center:[(b[0]+b[1])/2,(b[2]+b[3])/2,(b[4]+b[5])/2],span:Math.max(60,b[1]-b[0],b[3]-b[2],b[5]-b[4])}}
function scale3(){return Math.min(W,H)*.62/camera().span*zoom}
let projectionCache=null,screenCache=null;const lightingCache=new WeakMap();
function projection(){const old=projectionCache;if(old&&old.mesh===mesh&&old.w===W&&old.h===H&&old.zoom===zoom&&old.px===pan[0]&&old.py===pan[1]&&old.yaw===yaw&&old.pitch===pitch)return old;const c=camera();projectionCache={mesh,w:W,h:H,zoom,px:pan[0],py:pan[1],yaw,pitch,center:c.center,scale:Math.min(W,H)*.62/c.span*zoom,cy:Math.cos(yaw),sy:Math.sin(yaw),cp:Math.cos(pitch),sp:Math.sin(pitch),range:c.span*2};return projectionCache;}
function project(p){const c=projection(),x=p[0]-c.center[0],y=p[1]-c.center[1],z=p[2]-c.center[2],a=x*c.cy-y*c.sy,b=x*c.sy+y*c.cy;return[W/2+c.px+a*c.scale,H/2+c.py+(b*c.sp-z*c.cp)*c.scale,b*c.cp+z*c.sp]}
function screenVertices(){const p=projection();if(!screenCache||screenCache.projection!==p)screenCache={projection:p,points:(mesh?.vertices||[]).map(project)};return screenCache.points;}
function meshLighting(){let lights=lightingCache.get(mesh);if(!lights){const sun=norm([.3,.5,1]);lights=mesh.triangles.map(t=>.62+.3*Math.abs(dot(norm(cross(sub(mesh.vertices[t[1]],mesh.vertices[t[0]]),sub(mesh.vertices[t[2]],mesh.vertices[t[0]]))),sun)));lightingCache.set(mesh,lights)}return lights;}
function acceptBuiltResult(result){if(result.sketchOnly){acceptSketchResult(result);return}mesh=result;doc=result.document;dirty=false;lastError='';stash();syncContext();if(selectedFace&&!mesh.faces.some(f=>f.key===selectedFace))selectedFace=null;$('stats').textContent=mesh.vertices.length?`Gültiger Körper · ${mesh.volume.toFixed(2)} mm³ · ${mesh.faces.filter(f=>f.selectable).length} ebene referenzierbare Flächen`:'Noch kein Volumenkörper · Skizze erstellen und aufpolstern';render();}

function clip(p){return [2*p[0]/W-1,1-2*p[1]/H,-p[2]/projection().range]}
function send(vertices,kind){if(!vertices.length)return;gl.useProgram(shader);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.DYNAMIC_DRAW);for(const [name,off] of [['p',0],['c',12]]){gl.enableVertexAttribArray(loc[name]);gl.vertexAttribPointer(loc[name],3,gl.FLOAT,false,24,off)}gl.drawArrays(kind,0,vertices.length/6)}
function draw3(){
 if(!gl){drawOriginPlanes();ctx.fillStyle='#ffbb9e';ctx.fillText('WebGL nicht verfügbar. Hardwarebeschleunigung im Browser aktivieren.',20,110);return}
 gl.viewport(0,0,glCanvas.width,glCanvas.height);gl.clearColor(.045,.08,.12,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
 if(mesh?.vertices.length){const out=[],ps=screenVertices().map(clip),lights=meshLighting();mesh.triangles.forEach((t,i)=>{const fid=mesh.triangleFaces[i],face=mesh.faces[fid];let light=lights[i],color=selectedFace&&face.key===selectedFace?[.96,.67,.29]:fid===hoverFace?[.45,.84,.75]:[.23,.64,.58];color=color.map(c=>c*light);for(const vi of t)out.push(...ps[vi],...color)});send(out,gl.TRIANGLES)}
 const lines=[];function line3(a,b,c){for(const p of [a,b])lines.push(...clip(project(p)),...c)}
 for(const f of doc.features.filter(f=>f.op==='sketch')){const l=layout(f);if(!l)continue;const to3=p=>add(l.frame.o,add(mul(l.frame.u,p[0]),mul(l.frame.v,p[1])));const gs=f.shape==='multi'?f.geometry:[{type:f.shape,x:l.x,y:l.y,a:f.a,b:f.b}];for(const g of gs){if(['ellipse','spline'].includes(g.type)){for(const [a,b] of curveSegments(g))line3(to3(a),to3(b),[.4,.95,.77]);}else if(g.type==='arc'){for(const [a,b] of arcSegments(g))line3(to3(a),to3(b),[.4,.95,.77]);}else if(g.type==='circle'){let prev=[g.x+g.a/2,g.y];for(let i=1;i<=64;i++){const p=[g.x+g.a/2*Math.cos(i*Math.PI/32),g.y+g.a/2*Math.sin(i*Math.PI/32)];line3(to3(prev),to3(p),[.4,.95,.77]);prev=p}}else for(const [a,b] of Object.values(mSegments(g)))line3(to3(a),to3(b),[.4,.95,.77])}}
 for(const l of mesh?.layouts||[])if(l.helix){const used=doc.features.some(f=>isSweep(f)&&f.path===l.id);if(used&&selected!==l.id&&!helixDraft&&!sweepDraft)continue;for(let i=1;i<l.points.length;i++)line3(l.points[i-1],l.points[i],selected===l.id?[1,.75,.3]:[.5,.7,1]);line3(...l.axisPoints,[.4,.5,.6]);}
 const extent=mesh?.vertices.length?camera().span*.25:55;const axes=[[[extent,0,0],[.93,.34,.35],'X'],[[0,extent,0],[.38,.83,.51],'Y'],[[0,0,extent],[.35,.62,.97],'Z']];axes.forEach(([p,c])=>line3([0,0,0],p,c));send(lines,gl.LINES);
 // View orientation triad stays readable even when origin axes are behind the body.
 const base=[W-65,H-70];ctx.font='bold 12px system-ui';for(const [p,c,label] of axes){const a=project([0,0,0]),b=project(p),dx=(b[0]-a[0])/(extent*scale3())*33,dy=(b[1]-a[1])/(extent*scale3())*33;line(base,[base[0]+dx,base[1]+dy],`rgb(${c.map(x=>Math.round(x*255))})`,2);ctx.fillStyle=`rgb(${c.map(x=>Math.round(x*255))})`;ctx.fillText(label,base[0]+dx+3,base[1]+dy-3)}
 drawBodyEdges();
 drawOriginPlanes();
 ctx.font='12px system-ui';if(dirty){ctx.fillStyle='#f0bf7d';ctx.fillText('Aktualisierung offen',20,95)}
}
function sketchBounds(){let b=context?.info.bounds||[-50,50,-50,50];const f=context?.id&&doc.features.find(x=>x.id===context.id);if(f){const p=profilePosition(f),rx=f.a/2,ry=f.shape==='circle'?rx:f.b/2;b=[Math.min(b[0],p.x-rx),Math.max(b[1],p.x+rx),Math.min(b[2],p.y-ry),Math.max(b[3],p.y+ry)]}return b}
function scale2(){const b=sketchBounds();return Math.min((W-100)/Math.max(40,b[1]-b[0]),(H-150)/Math.max(40,b[3]-b[2]))*.85*zoom}
function xy(x,y){const b=sketchBounds(),s=scale2();return[W/2+pan[0]+(x-(b[0]+b[1])/2)*s,H/2+pan[1]-(y-(b[2]+b[3])/2)*s]}
function world(x,y){const b=sketchBounds(),s=scale2();return[(x-W/2-pan[0])/s+(b[0]+b[1])/2,(H/2+pan[1]-y)/s+(b[2]+b[3])/2]}
function profilePosition(f){let x=f.x,y=f.y;const l=(context?.id===f.id?context.info:layout(f));for(const axis of ['x','y']){const r=f['r'+axis],t=r&&l?.targets[r.role];if(t){const n=t.coordinate+r.distance*(['left','bottom'].includes(r.role)?1:-1);if(axis==='x')x=n;else y=n}}return{x,y}}
function line(a,b,color,width=1){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}
// Display preferences are independent of model geometry and undo history.
const sketchView={otherLevels:false,hidden:false};
let sketchEdgeCache=null;
function sketchViewPanel(){
 const title=document.createElement('h2');title.textContent='Skizzenansicht';$('edit').append(title);
 for(const [key,label] of [['otherLevels','Kanten anderer Höhenebenen'],['hidden','Verdeckte Kanten']]){
  const row=document.createElement('label');row.style.display='flex';row.style.gap='8px';
  const box=document.createElement('input');box.type='checkbox';box.id='sketchView_'+key;box.style.width='auto';box.checked=sketchView[key];
  box.onchange=()=>{sketchView[key]=box.checked;draw()};row.append(box,document.createTextNode(label));$('edit').append(row);
 }
 note('Verdeckte Körperkanten erscheinen gestrichelt. Die aktive Skizze und ihre Auflage bleiben sichtbar. Eindeutige Referenzkanten und Kreismittelpunkte sind für Maße und Bedingungen auswählbar.');
}
function sketchBodySegments(){
 const source=context?.info.referenceBody||mesh;const frame=context?.info.frame;if(!frame||!source?.edges?.length)return [];
 const key=JSON.stringify(frame);if(sketchEdgeCache?.source===source&&sketchEdgeCache.key===key)return sketchEdgeCache.segments;
 const local=p=>{const d=sub(p,frame.o);return [dot(d,frame.u),dot(d,frame.v),dot(d,frame.n)]};
 const vertices=source.vertices.map(local),triangles=source.triangles.map(t=>t.map(i=>vertices[i]));
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(const p of vertices){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1])}
 const span=Math.max(maxX-minX,maxY-minY,1),cell=span/32,buckets=new Map();
 const cellX=x=>Math.floor((x-minX)/cell),cellY=y=>Math.floor((y-minY)/cell);
 for(const t of triangles){
  if(Math.abs((t[1][0]-t[0][0])*(t[2][1]-t[0][1])-(t[1][1]-t[0][1])*(t[2][0]-t[0][0]))<1e-7)continue;
  for(let x=cellX(Math.min(...t.map(p=>p[0])));x<=cellX(Math.max(...t.map(p=>p[0])));x++)
   for(let y=cellY(Math.min(...t.map(p=>p[1])));y<=cellY(Math.max(...t.map(p=>p[1])));y++){
    const k=x+','+y;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(t);
   }
 }
 const segments=[],epsilon=Math.max(1e-5,span*1e-7);
 for(const edge of source.edges){const points=edge.points.map(local),other=points.some(p=>Math.abs(p[2])>epsilon);
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<epsilon)continue;
   const count=Math.max(1,Math.ceil(length/(span/600)));let runStart=a,previousHidden=null;
   for(let j=0;j<count;j++){
    const at=t=>add(a,mul(sub(b,a),t)),mid=at((j+.5)/count);
    const hidden=(buckets.get(cellX(mid[0])+','+cellY(mid[1]))||[]).some(t=>{const z=triangleDepth(mid,...t);return z!==null&&z>mid[2]+epsilon});
    if(previousHidden!==null&&hidden!==previousHidden){const end=at(j/count);segments.push({a:runStart,b:end,other,hidden:previousHidden,ref:edge.ref});runStart=end}
    previousHidden=hidden;
   }
   segments.push({a:runStart,b,other,hidden:previousHidden,ref:edge.ref});
  }
 }
 sketchEdgeCache={source,key,segments};return segments;
}
function visibleSketchBodySegments(){return sketchBodySegments().filter(s=>(sketchView.otherLevels||!s.other)&&(sketchView.hidden||!s.hidden))}
function drawSketchBodyEdges(){
 // Draw hidden edges first so coincident visible edges retain a solid outline.
 const segments=visibleSketchBodySegments();
 for(const hidden of [true,false]){ctx.setLineDash(hidden?[5,4]:[]);for(const s of segments)if(s.hidden===hidden)line(xy(s.a[0],s.a[1]),xy(s.b[0],s.b[1]),hidden?'#65788b':s.other?'#668ba2':'#9aafc3',hidden?1:1.4)}
 ctx.setLineDash([]);
}

function draw2(){
 if(gl){gl.clearColor(.045,.08,.12,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)}
 const b=sketchBounds(),span=Math.max(b[1]-b[0],b[3]-b[2],40),step=10**Math.floor(Math.log10(span/8));const lo=world(0,H),hi=world(W,0);
 for(let x=Math.ceil(lo[0]/step)*step;x<hi[0]&&Number.isFinite(x);x+=step)line(xy(x,lo[1]),xy(x,hi[1]),Math.abs(x)<1e-7?'#4e9171':'#1f3244');
 for(let y=Math.ceil(lo[1]/step)*step;y<hi[1]&&Number.isFinite(y);y+=step)line(xy(lo[0],y),xy(hi[0],y),Math.abs(y)<1e-7?'#a4565d':'#1f3244');
 drawSketchBodyEdges();
 const info=context?.info;for(const e of info?.edges||[]){for(let i=1;i<e.length;i++)line(xy(...e[i-1]),xy(...e[i]),'#9aafc3',2)}
 if(bind){for(const [role,t] of Object.entries(info?.targets||{})){if((bind==='x')===['left','right'].includes(role))line(xy(...t.points[0]),xy(...t.points.at(-1)),'#ffd080',4)}}
 const f=activeSketch();
 if(f&&f.shape!=='multi'){const p=profilePosition(f),q=xy(p.x,p.y),s=scale2();ctx.strokeStyle='#56e6c6';ctx.fillStyle='#56e6c61a';ctx.lineWidth=2;ctx.beginPath();if(f.shape==='circle')ctx.arc(...q,Math.max(.1,f.a*s/2),0,Math.PI*2);else ctx.rect(q[0]-f.a*s/2,q[1]-f.b*s/2,f.a*s,f.b*s);ctx.fill();ctx.stroke();line([q[0]-5,q[1]],[q[0]+5,q[1]],'#cffff3');line([q[0],q[1]-5],[q[0],q[1]+5],'#cffff3');for(const axis of ['x','y']){const r=f['r'+axis],t=r&&info?.targets[r.role];if(t){const a=axis==='x'?xy(t.coordinate,p.y):xy(p.x,t.coordinate);ctx.setLineDash([5,4]);line(a,q,'#f5c782');ctx.setLineDash([]);ctx.fillStyle='#f5c782';ctx.fillText(axis.toUpperCase()+' '+r.distance+' mm',(a[0]+q[0])/2+7,(a[1]+q[1])/2-8)}}}
 if(drag?.drawing&&tool!=='polyline'){const a=drag.start,b=drag.end;ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.beginPath();if(tool==='circle'){const r=Math.min(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]))/2;ctx.arc((a[0]+b[0])/2,(a[1]+b[1])/2,r,0,Math.PI*2)}else ctx.rect(a[0],a[1],b[0]-a[0],b[1]-a[1]);ctx.stroke();ctx.setLineDash([])}
 if(f)drawConstraintProfile(f);
 drawDimensionOverlay();
 ctx.fillStyle='#93acc2';ctx.fillText('U →',W-60,H-25);ctx.fillText('V ↑',20,100);ctx.fillText('Raster '+step+' mm',20,H-55);
}
function draw(){ctx.clearRect(0,0,W,H);$('mode').textContent=edgeTool?(edgeTool==='fillet'?'Verrundung · Kanten wählen':'Fase · Kanten wählen'):dimensionTool&&mode==='2d'?'Bemaßung · Punkte / Kanten':repair?'Auflage neu wählen':bind?'Referenzkante wählen':mode==='2d'?'Skizze · lokale U/V-Ebene':mesh?.vertices.length?'Volumenkörper':'Ursprung';$('help').textContent=edgeTool?'Kanten anklicken → Maß rechts eingeben → Anwenden · Esc: abbrechen':mode==='3d'?(originVisible?'Ebene anklicken · Doppelklick: neue Skizze · Ziehen: drehen':'Klick: Fläche wählen · Ziehen: drehen · Shift + Ziehen: verschieben · Mausrad: zoomen'):bind?'Gelbe Randkante anklicken · Abstand rechts einstellen':tool==='polyline'?'Punkte anklicken · Startpunkt schließt · Enter/Esc beendet offen':tool?'Profil aufziehen · Shift + Ziehen: Ansicht verschieben':dimensionTool&&angleMode?'Zwei Linien/Achsen wählen · Winkelbogen im gewünschten Sektor platzieren':dimensionTool?'Punkte / Kanten / Achsen wählen → Maß platzieren → direkt tippen · Esc: abbrechen':'Form ziehen: verschieben · Linienpunkt ziehen: ändern · Alt: ganzer Linienzug · Shift: Ansicht · Esc: 3D';mode==='3d'?draw3():draw2()}
function fit(){zoom=1;pan=[0,0];draw()}
function hitFace(x,y){if(!mesh)return null;let best=null,depth=-Infinity;const ps=screenVertices();mesh.triangles.forEach((t,i)=>{const [a,b,c]=t.map(j=>ps[j]),den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-9)return;const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den,v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den,w=1-u-v;if(u>=-1e-6&&v>=-1e-6&&w>=-1e-6){const d=u*a[2]+v*b[2]+w*c[2];if(d>depth){depth=d;best=mesh.triangleFaces[i]}}});return best}
function distSegment(p,a,b){const v=[b[0]-a[0],b[1]-a[1]],n=v[0]*v[0]+v[1]*v[1],t=n?Math.max(0,Math.min(1,((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/n)):0;return Math.hypot(p[0]-a[0]-t*v[0],p[1]-a[1]-t*v[1])}
async function newSketch(){edgeTool=null;edgeSelection=[];hoverEdge=null;if(!selectedFace&&!plane){originVisible=true;waitingPlane=true;mode='3d';render();status('Eine der drei Ursprungsebenen anklicken.');return;}dimensionTool=false;dimensionPicks=[];dimensionCursor=null;closeDimensionEditor();if(dirty&&!(await update()))return;const face=selectedInfo();if(selectedFace&&!face?.selectable){status('Bitte eine eindeutig referenzierbare ebene Fläche auswählen.',true);return}context={support:face?{face:face.key}:{plane},info:face||planeInfo(plane),id:null};selected=null;selectedKind='sketch';originVisible=false;hoverPlane=null;waitingPlane=false;tool='rect';bind=null;mode='2d';fit();render();status('Rechteck aufziehen oder Kreis wählen. Danach aufpolstern.')}
async function editSketch(f){if(isTreatment(f))return false;edgeTool=null;edgeSelection=[];hoverEdge=null;dimensionTool=false;dimensionPicks=[];dimensionCursor=null;closeDimensionEditor();if(dirty&&!(mode==='2d'&&context?.id===f.id&&layout(f)?.solvedFeature===JSON.stringify(f))&&!(await update()))return false;const l=layout(f);if(!l){status('Skizzenauflage kann nicht aufgelöst werden. Auflage neu wählen.',true);return false}selected=f.id;selectedKind='sketch';originVisible=false;hoverPlane=null;context={id:f.id,support:f.support,info:l};mode='2d';tool=bind=null;fit();render();return true}
async function beginRepair(f){if(busy)return;try{const prefix={version:2,features:doc.features.slice(0,doc.features.findIndex(x=>x.id===f.id))};mesh=await (await request('/build',JSON.stringify(prefix))).json();repair=f.id;selectedFace=null;originVisible=true;mode='3d';context=null;tool=bind=null;dirty=true;fit();render();status('Vorgängermodell sichtbar: eine Fläche anklicken oder eine Ursprungsebene wählen.')}catch(e){status('Zuerst vorherige Bearbeitung reparieren: '+e.message,true)}}
async function applyFeature(op){dimensionTool=false;dimensionPicks=[];closeDimensionEditor();const f=cur();if(!f||isTreatment(f))return;mutate(()=>f.op=op);if(await update()){selectedKind='feature';collapsedNodes.delete(f.id);originVisible=false;mode='3d';context=null;tool=bind=null;fit();render()}}
function point(e){const r=overlay.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top]}
overlay.oncontextmenu=e=>e.preventDefault();
overlay.onpointerdown=e=>{if(e.button!==0&&e.button!==1)return;overlay.setPointerCapture(e.pointerId);const p=point(e);if(mode==='2d'&&!e.shiftKey&&e.button===0&&!tool&&dimensionClick(p)){e.preventDefault();return;}if(mode==='2d'&&bind&&cur()){
 const candidates=Object.entries(context.info.targets||{}).filter(([r])=>(bind==='x')===['left','right'].includes(r)).map(([role,t])=>({role,t,d:distSegment(p,xy(...t.points[0]),xy(...t.points.at(-1)))})).sort((a,b)=>a.d-b.d);if(!candidates.length||candidates[0].d>16){status('Keine passende eindeutige gerade Randkante an dieser Stelle.',true);return}
 const f=cur(),pos=profilePosition(f),{role,t}=candidates[0],axis=bind;mutate(()=>f['r'+axis]={role,distance:Number(((pos[axis]-t.coordinate)*(['left','bottom'].includes(role)?1:-1)).toFixed(4))});bind=null;render();return;}
 drag={start:p,end:p,yaw,pitch,pan:[...pan],move:false,panning:e.shiftKey||e.button===1,drawing:mode==='2d'&&!!tool&&!e.shiftKey&&e.button===0};};
overlay.onpointermove=e=>{const p=point(e);if(mode==='2d'&&dimensionTool&&!drag){dimensionHover=hitGeometry(p);dimensionCursor=p;draw();return}if(drag){drag.end=p;const dx=p[0]-drag.start[0],dy=p[1]-drag.start[1];drag.move=drag.move||Math.hypot(dx,dy)>4;if(drag.panning)pan=[drag.pan[0]+dx,drag.pan[1]+dy];else if(mode==='3d'){yaw=drag.yaw-dx*.008;pitch=Math.max(-1.5,Math.min(1.5,drag.pitch+dy*.008))}draw()}else if(mode==='3d'&&edgeTool){const hit=hitBodyEdge(...p);overlay.style.cursor=hit!==null?'pointer':'default';if(hit!==hoverEdge){hoverEdge=hit;draw()}}else if(mode==='3d'){const hp=hitOriginPlane(...p);const hit=hp?null:(!dirty?hitFace(...p):null);overlay.style.cursor=hp||hit!==null?'pointer':'default';if(hp!==hoverPlane||hit!==hoverFace){hoverPlane=hp;hoverFace=hit;draw()}}};
overlay.onpointerleave=()=>{if(!drag){hoverFace=null;hoverPlane=null;hoverEdge=null;draw()}};
overlay.onpointerup=async e=>{if(!drag)return;const d=drag;drag=null;
 if(d.drawing&&d.move){const a=world(...d.start),b=world(...d.end),w=Math.abs(b[0]-a[0]),h=Math.abs(b[1]-a[1]);if(w>.1&&h>.1){const round=n=>Number(n.toFixed(2));const f={id:uid(),name:'Skizze '+(doc.features.length+1),support:structuredClone(context.support),shape:tool,op:'sketch',x:round((a[0]+b[0])/2),y:round((a[1]+b[1])/2),a:round(tool==='circle'?Math.min(w,h):w),b:round(h),depth:10,reverse:false};mutate(()=>{doc.features.push(f);selected=f.id;selectedKind='sketch'});context={...context,id:f.id};tool=null;const ok=await update();render();if(ok)status('Skizze erstellt · Maße einstellen und aufpolstern oder Tasche erzeugen.')}}
 else if(mode==='3d'&&!d.move&&!d.panning){if(edgeTool){const id=hitBodyEdge(...point(e));if(id!==null){const ref=mesh.edges[id].ref;if(edgeSelection.some(r=>edgeSame(r,ref)))edgeSelection=edgeSelection.filter(r=>!edgeSame(r,ref));else edgeSelection.push(ref);render()}else status('Bitte eine sichtbare eindeutig referenzierbare Körperkante anklicken.');return;}const pickedPlane=hitOriginPlane(...point(e));if(pickedPlane){await selectOriginPlane(pickedPlane);return;}if(dirty&&!repair){status('Vor der Flächenauswahl bitte aktualisieren oder rückgängig machen.',true);return}const hit=hitFace(...point(e)),face=hit===null?null:mesh.faces[hit];if(!face){selectedFace=null;render();return}if(!face.selectable){status(face.label,true);return}if(repair){const f=doc.features.find(x=>x.id===repair);mutate(()=>{f.support={face:face.key};delete f.rx;delete f.ry;f.dimensions=(f.dimensions||[]).filter(d=>![d.first?.kind,d.second?.kind].some(k=>k?.startsWith('support-')))});repair=null;await update()}else{selectedFace=face.key;selected=null;waitingPlane=false;originVisible=false;render();status('Fläche ausgewählt · „Skizze auf Auswahl“ startet eine neue Skizze.')}}draw();};
overlay.onpointercancel=()=>{drag=null;draw()};overlay.onwheel=e=>{e.preventDefault();zoom=Math.max(.15,Math.min(8,zoom*Math.exp(-e.deltaY*.001)));draw()};overlay.ondblclick=async e=>{if(mode==='3d'){const p=hitOriginPlane(...point(e));if(p){await selectOriginPlane(p);await newSketch()}else fit()}};
// Sketch dimensions: semantic point/edge references and explicit placement.
let dimensionTool=false,dimensionPicks=[],dimensionAxis='auto',dimensionHover=null,dimensionCursor=null,dimensionLabels=[],editingDimension=null,dimensionDraft=null;
const SAME=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function activeSketch(){return context?.id?doc.features.find(f=>f.id===context.id):null}
function referencePoint(ref,f){const p=profilePosition(f),r=ref.role;if(ref.kind==='origin'||ref.kind==='axis')return[0,0];
 if(ref.kind==='point'||ref.kind==='edge'){const k={bl:[-1,-1],br:[1,-1],tr:[1,1],tl:[-1,1],center:[0,0],left:[-1,0],right:[1,0],bottom:[0,-1],top:[0,1]}[r];return[p.x+k[0]*f.a/2,p.y+k[1]*f.b/2]}
 const t=context.info.targets[r];if(!t)throw Error('Referenzkante nicht mehr vorhanden');const axis=['left','right'].includes(r)?0:1;const ps=[...t.points].sort((a,b)=>a[1-axis]-b[1-axis]);return ref.kind==='support-point'?ps[ref.endpoint]:[(ps[0][0]+ps.at(-1)[0])/2,(ps[0][1]+ps.at(-1)[1])/2];}
function geometryTargets(){const f=activeSketch();if(!f)return[];const out=[{ref:{kind:'origin'},point:[0,0]}];const p=profilePosition(f);
 for(const role of f.shape==='rect'?['bl','br','tr','tl','center']:['center']){const ref={kind:'point',role};out.push({ref,point:referencePoint(ref,f)})}
 if(f.shape==='rect')for(const [role,ends] of [['bottom',['bl','br']],['right',['br','tr']],['top',['tl','tr']],['left',['bl','tl']]])out.push({ref:{kind:'edge',role},points:ends.map(role=>referencePoint({kind:'point',role},f))});
 else out.push({ref:{kind:'circle'},center:[p.x,p.y],radius:f.a/2});
 for(const [role,t] of Object.entries(context.info.targets||{})){out.push({ref:{kind:'support-edge',role},points:t.points});for(const endpoint of [0,1]){const ref={kind:'support-point',role,endpoint};out.push({ref,point:referencePoint(ref,f)})}}
 const lo=world(0,H),hi=world(W,0);out.push({ref:{kind:'axis',role:'vertical'},points:[[0,lo[1]],[0,hi[1]]]},{ref:{kind:'axis',role:'horizontal'},points:[[lo[0],0],[hi[0],0]]});return out;}
function hitGeometry(screen){const targets=geometryTargets(),points=targets.filter(t=>t.point).map(t=>({...t,d:Math.hypot(...sub2(screen,xy(...t.point)))})).sort((a,b)=>a.d-b.d);if(points[0]?.d<10)return points[0].ref;const edges=targets.filter(t=>!t.point).map(t=>({...t,d:targetDistance(t,screen)})).sort((a,b)=>a.d-b.d);return edges[0]?.d<10?edges[0].ref:null;}
function sub2(a,b){return[a[0]-b[0],a[1]-b[1]]}
function makeDimension(position){const f=activeSketch();if(!f||!dimensionPicks.length)return null;let picks=structuredClone(dimensionPicks),axis=dimensionAxis;
 if(picks.length===1){const r=picks[0];if(r.kind==='circle')return{id:uid(),kind:'diameter',value:f.a,position};if(r.kind!=='edge')return null;const map={bottom:['bl','br','x'],top:['tl','tr','x'],left:['bl','tl','y'],right:['br','tr','y']}[r.role];picks=[{kind:'point',role:map[0]},{kind:'point',role:map[1]}];axis=map[2];}
 if(picks.some(r=>r.kind==='circle'))throw Error('Kreisrand einzeln für Durchmesser wählen; für Abstände den Mittelpunkt anklicken.');
 const edge=picks.find(r=>r.kind.endsWith('edge')||r.kind==='axis');if(edge){const edgeAxis=r=>{if(!r.external)return ['left','right','vertical'].includes(r.role)?'x':'y';const [a,b]=refLine(r);if(Math.abs(a[0]-b[0])<1e-6)return 'x';if(Math.abs(a[1]-b[1])<1e-6)return 'y';throw Error('Schräge Kante: Skizze zuerst als Mehrfachskizze bearbeiten.');};const forced=edgeAxis(edge);if(axis!=='auto'&&axis!==forced)throw Error('Abstand muss senkrecht zur ausgewählten Kante verlaufen.');axis=forced;for(const r of picks.filter(r=>r.kind.endsWith('edge')||r.kind==='axis'))if(edgeAxis(r)!==axis)throw Error('Bitte parallele Kanten auswählen.');}
 const a=referencePoint(picks[0],f),b=referencePoint(picks[1],f);if(axis==='auto')axis=Math.abs(b[0]-a[0])>=Math.abs(b[1]-a[1])?'x':'y';const delta=b[axis==='x'?0:1]-a[axis==='x'?0:1];return{id:uid(),kind:'linear',axis,first:picks[0],second:picks[1],sign:delta<0?-1:1,value:Math.abs(delta),position};}
function arrow(p,toward,color){const n=norm([toward[0]-p[0],toward[1]-p[1],0]),perp=[-n[1],n[0]];ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(p[0]+n[0]*8+perp[0]*3,p[1]+n[1]*8+perp[1]*3);ctx.lineTo(p[0]+n[0]*8-perp[0]*3,p[1]+n[1]*8-perp[1]*3);ctx.closePath();ctx.fill();}
function drawDimension(d,f,preview=false){const color=preview?'#fff0b8':'#f4cb83';let start,end,label,actualA,actualB;const position=xy(...d.position);
 if(d.kind==='diameter'){const p=profilePosition(f),center=xy(p.x,p.y),delta=sub2(position,center),len=Math.hypot(...delta)||1,r=f.a*scale2()/2;start=[center[0]-delta[0]/len*r,center[1]-delta[1]/len*r];end=[center[0]+delta[0]/len*r,center[1]+delta[1]/len*r];line(end,position,color);label=position;}
 else{const pa=referencePoint(d.first,f),pb=referencePoint(d.second,f);if(d.first.kind==='axis')pa[d.first.role==='vertical'?1:0]=pb[d.first.role==='vertical'?1:0];if(d.second.kind==='axis')pb[d.second.role==='vertical'?1:0]=pa[d.second.role==='vertical'?1:0];actualA=xy(...pa);actualB=xy(...pb);if(d.axis==='x'){start=[actualA[0],position[1]];end=[actualB[0],position[1]];label=[(start[0]+end[0])/2,position[1]]}else{start=[position[0],actualA[1]];end=[position[0],actualB[1]];label=[position[0],(start[1]+end[1])/2]}
 for(const [a,b] of [[actualA,start],[actualB,end]]){const delta=sub2(b,a),len=Math.hypot(...delta)||1;line(a,[b[0]+delta[0]/len*6,b[1]+delta[1]/len*6],color,.8)}}
 line(start,end,color,1.2);arrow(start,end,color);arrow(end,start,color);const text=(d.kind==='diameter'?'Ø ':d.kind==='radius'?'R ':'')+Number(d.value.toFixed(3));ctx.font='13px system-ui';const width=ctx.measureText(text).width+16;ctx.fillStyle='#112231';ctx.fillRect(label[0]-width/2,label[1]-11,width,22);ctx.strokeStyle=color;ctx.strokeRect(label[0]-width/2,label[1]-11,width,22);ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,label[0],label[1]);ctx.textAlign='start';ctx.textBaseline='alphabetic';ctx.font='12px system-ui';if(!preview)dimensionLabels.push({id:d.id,x:label[0],y:label[1],w:width});}
function drawDimensionOverlay(){dimensionLabels=[];const f=activeSketch();if(!f)return;for(const d of f.dimensions||[]){try{drawDimension(d,f)}catch{}}
 if(dimensionTool){for(const t of geometryTargets()){const selected=dimensionPicks.some(r=>SAME(r,t.ref)),hover=SAME(dimensionHover,t.ref),color=selected?'#ffd076':hover?'#fff':t.ref.kind==='point'?((f.shape==='multi'?constraintState(f)?.elements?.[t.ref.element]?.points?.[t.ref.role]:constraintState(f)?.points?.[t.ref.role])?'#69e094':'#a5adb5'):'#83b9c9';if(t.point){const p=xy(...t.point);ctx.beginPath();ctx.arc(...p,selected||hover?5:3,0,Math.PI*2);ctx.fillStyle=color;ctx.fill()}else if(selected||hover){if(t.points)line(xy(...t.points[0]),xy(...t.points.at(-1)),color,3);else{ctx.beginPath();if(t.arc)circlePath(t.arc);else ctx.arc(...xy(...t.center),t.radius*scale2(),0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=3;ctx.stroke()}}}
 if(dimensionCursor){try{const d=makeDimension(world(...dimensionCursor));if(d)drawDimension(d,f,true)}catch{}}}}
function calculateMeasure(text){
 const source=String(text).replace(/,/g,'.').replace(/×/g,'*').replace(/÷/g,'/').replace(/\s+/g,'');
 if(!source||source.length>200)throw Error('Bitte eine Zahl oder Rechnung eingeben.');
 let i=0;function factor(){if(source[i]==='+'){i++;return factor()}if(source[i]==='-'){i++;return -factor()}if(source[i]==='('){i++;const v=expression();if(source[i++]!==')')throw Error('Schließende Klammer fehlt.');return v}const m=source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);if(!m)throw Error('Erlaubt: Zahlen, + − * / und Klammern.');i+=m[0].length;return Number(m[0])}
 function term(){let v=factor();while(source[i]==='*'||source[i]==='/'){const op=source[i++],n=factor();if(op==='/'&&n===0)throw Error('Division durch null ist nicht möglich.');v=op==='*'?v*n:v/n}return v}
 function expression(){let v=term();while(source[i]==='+'||source[i]==='-'){const op=source[i++],n=term();v=op==='+'?v+n:v-n}return v}
 const result=expression();if(i!==source.length)throw Error('Ungültige Rechnung.');if(!Number.isFinite(result)||result<0||result>10000)throw Error('Ergebnis muss zwischen 0 und 10000 mm liegen.');return Number(result.toPrecision(14));
}
function focusMeasure(){const el=$('dimValue');el.focus({preventScroll:true});el.select();setTimeout(()=>{if(!$('dimensionEditor').hidden){el.focus({preventScroll:true});el.select()}},0)}
async function escapeSketch(){if(edgeTool){edgeTool=null;edgeSelection=[];hoverEdge=null;render();status('Kantenbearbeitung abgebrochen.');return;}
 if(!$('dimensionEditor').hidden||dimensionTool||tool||bind||repair||waitingPlane||drag){closeDimensionEditor();dimensionTool=false;dimensionPicks=[];dimensionCursor=null;dimensionHover=null;tool=bind=repair=null;waitingPlane=false;drag=null;render();status('Aktion abgebrochen · Esc erneut: Skizze verlassen.');return}
 if(mode==='2d'){if(geometrySaving||busy)return;if(dirty&&!(await update()))return;mode='3d';context=null;hoverFace=null;fit();render();status('Skizze verlassen · 3D-Ansicht.');}
}
function constraintState(f){return dirty&&layout(f)?.solvedFeature!==JSON.stringify(f)?null:layout(f)?.constraints}
// Keep HSL lightness while reducing saturation to 35% for mirror copies.
function mirrorColor(color){const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)),gray=(Math.max(...rgb)+Math.min(...rgb))/2;return '#'+rgb.map(v=>Math.round(gray+(v-gray)*.35).toString(16).padStart(2,'0')).join('')}
function stateColor(state){return state==='fixed'?'#69e094':state==='partial'?'#77b9ff':'#a5adb5'}
function drawConstraintProfile(f){const p=profilePosition(f),st=constraintState(f);if(f.shape==='circle'){ctx.strokeStyle=stateColor(st?.edges.circle);ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(...xy(p.x,p.y),Math.max(.1,f.a*scale2()/2),0,Math.PI*2);ctx.stroke()}else{for(const [role,a,b] of [['bottom',[-1,-1],[1,-1]],['right',[1,-1],[1,1]],['top',[-1,1],[1,1]],['left',[-1,-1],[-1,1]]])line(xy(p.x+a[0]*f.a/2,p.y+a[1]*f.b/2),xy(p.x+b[0]*f.a/2,p.y+b[1]*f.b/2),stateColor(st?.edges[role]),2.5)}
 ctx.font='12px system-ui';ctx.fillStyle=st?.fully?'#69e094':'#adc4d9';ctx.fillText(st?(st.fully?'Vollständig bestimmt':st.dof+' Freiheitsgrade offen'):'Bestimmtheit nach Aktualisierung verfügbar',20,124);
 const legend=[['#a5adb5','Unbestimmt'],['#77b9ff','Teilbestimmt'],['#69e094','Bestimmt']];let x=20;for(const [color,label] of legend){ctx.fillStyle=color;ctx.fillRect(x,138,8,8);ctx.fillText(label,x+13,146);x+=label.length*7+30}
}

function closeDimensionEditor(){ $('dimensionEditor').hidden=true;editingDimension=null;dimensionDraft=null;}
function openDimensionEditor(d,isNew=false){dimensionDraft=isNew?d:null;editingDimension=isNew?null:d.id;$('dimValue').value=Number(d.value.toFixed(6));$('dimDelete').hidden=isNew;$('dimensionEditor').hidden=false;focusMeasure();$('dimMessage').textContent=isNew?'Direkt tippen · Rechnung möglich · Enter übernimmt':'Rechnung möglich · Enter übernimmt';}
async function saveDimension(){if($('dimApply').disabled)return;let value;try{value=calculateMeasure($('dimValue').value)}catch(e){$('dimMessage').textContent=e.message;return;}const f=activeSketch();if(!f)return;const candidate=structuredClone(doc),target=candidate.features.find(x=>x.id===f.id);target.dimensions??=[];if(dimensionDraft)target.dimensions.push({...dimensionDraft,value});else{const d=target.dimensions.find(x=>x.id===editingDimension);if(!d)return;d.value=value;}
 const before=JSON.stringify(doc);$('dimApply').disabled=true;try{const result=await requestSketchResult(candidate);if(JSON.stringify(doc)!==before)throw Error('Modell wurde zwischenzeitlich geändert. Maß bitte erneut übernehmen.');mutate(()=>doc=candidate);closeDimensionEditor();dimensionPicks=[];dimensionCursor=null;acceptBuiltResult(result);status('Maß übernommen · Maßzahl anklicken zum Ändern.')}catch(e){$('dimMessage').textContent=e.message}finally{$('dimApply').disabled=false}}
async function deleteDimension(){const f=activeSketch();if(!f||!editingDimension||busy||geometrySaving)return;const candidate=structuredClone(doc),target=candidate.features.find(x=>x.id===f.id),before=JSON.stringify(doc);target.dimensions=target.dimensions.filter(d=>d.id!==editingDimension);geometrySaving=true;try{const result=await requestSketchResult(candidate);if(JSON.stringify(doc)!==before)throw Error('Modell wurde geändert.');mutate(()=>doc=candidate);closeDimensionEditor();acceptBuiltResult(result)}catch(e){$('dimMessage').textContent=e.message}finally{geometrySaving=false}}

async function startDimension(){const f=cur();if(!f){status('Zuerst eine Skizze zeichnen oder im Modellbaum auswählen.',true);return}if(await editSketch(f)){dimensionTool=true;dimensionPicks=[];dimensionCursor=null;tool=null;render();status('Kante/Kreis wählen oder zwei Punkte bzw. parallele Kanten wählen. Danach ins Freie klicken, um das Maß zu platzieren.')}}
function dimensionClick(p){const label=dimensionLabels.find(d=>Math.abs(p[0]-d.x)<d.w/2+3&&Math.abs(p[1]-d.y)<14);if(label){const d=activeSketch()?.dimensions.find(x=>x.id===label.id);if(d){openDimensionEditor(d);return true}}
 if(!dimensionTool)return false;if(dimensionPicks.length===2){try{const d=makeDimension(world(...p));openDimensionEditor(d,true)}catch(e){status(e.message,true)}return true}
 const ref=hitGeometry(p);if(ref){if(dimensionPicks.some(r=>SAME(r,ref))){status('Bitte ein zweites Element oder eine freie Stelle für die Maßlinie wählen.');return true}dimensionPicks.push(ref);dimensionCursor=null;draw();status(dimensionPicks.length===2?'Freie Stelle anklicken: Maßlinie platzieren.':ref.kind==='edge'||ref.kind==='circle'?'Freie Stelle: Länge/Ø platzieren. Oder zweite parallele Kante für Abstand wählen.':'Zweiten Punkt oder eine passende Kante auswählen.');return true}
 try{const d=makeDimension(world(...p));if(d)openDimensionEditor(d,true);else status('Für einen Abstand bitte zwei Punkte oder Punkt und Kante auswählen.')}catch(e){status(e.message,true)}return true;}
$('dimension').onclick=startDimension;$('dimAxis').onchange=e=>{dimensionAxis=e.target.value;draw()};$('dimApply').onclick=saveDimension;$('dimCancel').onclick=()=>{closeDimensionEditor();dimensionPicks=[];dimensionCursor=null;draw()};$('dimDelete').onclick=deleteDimension;$('dimValue').oninput=()=>{try{$('dimMessage').textContent='= '+calculateMeasure($('dimValue').value)+' mm · Enter übernimmt'}catch(e){$('dimMessage').textContent=e.message}};$('dimValue').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();saveDimension()}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();escapeSketch()}};

let edgeTool=null,edgeSelection=[],hoverEdge=null,edgeAmount=1,edgeApplying=false;
const isTreatment=f=>f&&['fillet','chamfer'].includes(f.op);
const edgeSame=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function drawBodyEdges(){if(!gl||!mesh?.edges)return;const out=[];for(const e of mesh.edges){const picked=edgeSelection.some(r=>edgeSame(r,e.ref));const color=picked?[1,.72,.3]:(e.id===hoverEdge||(e.ref&&edgeSame(e.ref,mesh.edges[hoverEdge]?.ref)))?[.8,1,.95]:edgeTool?[.4,.62,.71]:[.09,.23,.25];for(let i=1;i<e.points.length;i++){for(const p of [e.points[i-1],e.points[i]]){const c=clip(project(p));c[2]-=.00002;out.push(...c,...color)}}}send(out,gl.LINES)}
function hitBodyEdge(x,y){if(!mesh?.edges)return null;const screen=screenVertices(),triangles=mesh.triangles.map(t=>t.map(i=>screen[i]));let best=null,bestDistance=10,bestDepth=-Infinity;
 for(const e of mesh.edges){if(!e.selectable)continue;const points=e.points.map(project);for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],n=dx*dx+dy*dy,t=n?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/n)):0,q=[a[0]+t*dx,a[1]+t*dy],distance=Math.hypot(x-q[0],y-q[1]);if(distance>bestDistance+.01)continue;const depth=a[2]+t*(b[2]-a[2]);let surface=-Infinity;for(const tri of triangles){const d=triangleDepth(q,...tri);if(d!==null)surface=Math.max(surface,d)}if(depth<surface-.15)continue;if(distance<bestDistance-.01||depth>bestDepth){best=e.id;bestDistance=distance;bestDepth=depth}}}return best;}
async function startEdgeTool(kind){if(busy)return;if(dirty&&!(await update()))return;if(!mesh?.vertices.length){status('Zuerst einen Körper erzeugen.',true);return}edgeTool=kind;edgeSelection=[];hoverEdge=null;selected=null;selectedFace=null;context=null;originVisible=false;dimensionTool=false;tool=bind=null;closeDimensionEditor();mode='3d';render();status('Eine oder mehrere Kanten anklicken, Maß eingeben und anwenden.');}
function edgeDraftPanel(){note(edgeTool==='fillet'?'Kantenverrundung':'Symmetrische Fase');note(edgeSelection.length+' Kante(n) / Lochrand ausgewählt. Erneuter Klick entfernt die Auswahl.');const label=document.createElement('label');label.textContent=edgeTool==='fillet'?'Radius (mm)':'Fasenmaß je Seite (mm)';const input=document.createElement('input');input.id='edgeValue';input.type='number';input.min='0.01';input.step='.5';input.value=edgeAmount;input.oninput=()=>{edgeAmount=Number(input.value)};input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();applyEdges()}};$('edit').append(label,input);button('Anwenden',applyEdges).disabled=!edgeSelection.length||edgeApplying;button('Abbrechen',()=>{edgeTool=null;edgeSelection=[];hoverEdge=null;render()});note('Einheitlicher Radius bzw. gleiches Fasenmaß auf beiden Seiten. Tangential zusammenhängende Kanten können gemeinsam bearbeitet werden.');}
async function applyEdges(){if(edgeApplying||busy||!edgeTool||!edgeSelection.length)return;const amount=Number($('edgeValue').value);if(!(amount>0&&amount<=10000)){status('Bitte ein positives Maß bis 10000 mm eingeben.',true);return}const kind=edgeTool,f={id:uid(),name:kind==='fillet'?'Verrundung':'Fase',op:kind,amount,edges:structuredClone(edgeSelection)},candidate=structuredClone(doc);candidate.features.push(f);const before=JSON.stringify(doc);edgeApplying=true;try{const result=await (await request('/build',JSON.stringify(candidate))).json();if(JSON.stringify(doc)!==before)throw Error('Modell wurde zwischenzeitlich geändert. Bitte erneut anwenden.');mutate(()=>{doc=candidate;selected=f.id;selectedKind='feature';edgeTool=null;edgeSelection=[];hoverEdge=null});acceptBuiltResult(result);status('Kantenbearbeitung erstellt. Maß rechts weiterhin editierbar.')}catch(e){status(e.message,true)}finally{edgeApplying=false;render()}}
$('filletTool').onclick=()=>startEdgeTool('fillet');$('chamferTool').onclick=()=>startEdgeTool('chamfer');

async function request(path,snapshot){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:snapshot});if(!r.ok){const x=await r.json();throw Error(x.error||'Berechnung fehlgeschlagen')}return r}
function autoUpdate(){if(busy){pending=true;return}return update()}
async function update(){if(busy)return false;busy=true;render();status('Open Cascade berechnet …');const snapshot=JSON.stringify(doc);try{const r=await request('/build',snapshot),result=await r.json();mesh=result;dirty=JSON.stringify(doc)!==snapshot;if(!dirty){doc=result.document;stash();}lastError='';syncContext();if(selectedFace&&!mesh.faces.some(f=>f.key===selectedFace))selectedFace=null;$('stats').textContent=mesh.vertices.length?`Gültiger Körper · ${mesh.volume.toFixed(2)} mm³ · ${mesh.faces.filter(f=>f.selectable).length} ebene referenzierbare Flächen`:'Noch kein Volumenkörper · Skizze erstellen und aufpolstern';status(dirty?'Weitere Änderungen offen.':'Aktuell · Referenzen aufgelöst.');return !dirty}catch(e){lastError=e.message;dirty=true;status(e.message,true);return false}finally{busy=false;render();if(pending){pending=false;setTimeout(autoUpdate,0)}}}
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function exportModel(format){
 if(busy)return;
 busy=true;render();const snapshot=JSON.stringify(doc),stl=format==='stl';
 try{
  status(stl?'Drucknetz wird erstellt · 0,02 mm / 0,1 rad …':'STEP-Export wird neu berechnet …');
  const r=await request('/'+format,snapshot);
  download(await r.arrayBuffer(),'MetricCAD.'+format,stl?'model/stl':'application/step');
  status((stl?'STL exportiert · in Bambu Studio als mm öffnen.':'STEP-Datei exportiert.')+(JSON.stringify(doc)!==snapshot?' Export enthält den Stand beim Klick.':''));
 }catch(e){status(e.message,true)}finally{busy=false;render();if(pending){pending=false;setTimeout(autoUpdate,0)}}
}
$('update').onclick=update;$('export').onclick=()=>exportModel('step');$('exportStl').onclick=()=>exportModel('stl');
$('save').onclick=()=>download(JSON.stringify(doc,null,2),'MetricCAD.json','application/json');$('open').onclick=()=>$('file').click();$('file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>200000)throw Error('Projektdatei zu groß');const raw=await file.text();const response=await request('/validate',raw),d=await response.json();mutate(()=>{edgeTool=null;edgeSelection=[];hoverEdge=null;doc=d;selected=null;selectedFace=null;context=null;mesh=null;originVisible=!d.features.length;waitingPlane=false;plane=null;collapsedNodes.clear()});mode='3d';fit();await update()}catch(e){status(e.message,true)}$('file').value=''};
$('new').onclick=()=>{if(doc.features.length&&!confirm('Neues leeres Projekt starten? Vorher bei Bedarf speichern.'))return;mutate(()=>{dimensionTool=false;dimensionPicks=[];closeDimensionEditor();edgeTool=null;edgeSelection=[];hoverEdge=null;doc=fresh();selected=null;selectedFace=null;context=null;mesh=null;tool=bind=repair=null;plane=null;originVisible=true;waitingPlane=false;hoverPlane=null;collapsedNodes.clear();selectedKind='sketch'});mode='3d';fit();update()};
$('newSketch').onclick=newSketch;
for(const t of ['rect','circle'])$(t).onclick=async()=>{if(mode!=='2d'||!context||context.id){await newSketch()}if(context&&!context.id){tool=t;render()}};
$('origins').onclick=async()=>{if(geometrySaving||busy)return;if(dirty&&!(await update()))return;originVisible=!originVisible;hoverPlane=null;mode='3d';dimensionTool=false;closeDimensionEditor();render()};$('editSketchTool').onclick=()=>{if(cur())editSketch(cur())};$('padTool').onclick=()=>applyFeature('pad');$('pocketTool').onclick=()=>applyFeature('pocket');
$('view3').onclick=async()=>{if(geometrySaving||busy)return;if(dirty&&!(await update()))return;dimensionTool=false;closeDimensionEditor();mode='3d';tool=bind=null;fit();render()};$('view2').onclick=()=>cur()?editSketch(cur()):newSketch();$('fit').onclick=fit;
async function undo(redo=false){
 const from=redo?future:history,to=redo?history:future;if(!from.length||busy||geometrySaving)return;
 const before=JSON.stringify(doc),saved=from.at(-1),candidate=JSON.parse(saved),sketchID=mode==='2d'?context?.id:null;
 const keepSketch=sketchID&&candidate.features.some(f=>f.id===sketchID&&!isTreatment(f));
 const view=keepSketch?{center:world(W/2,H/2),scale:scale2()}:null,oldSelection=selected,oldKind=selectedKind;
 busy=true;render();
 try{
  const result=await(await request(keepSketch?'/sketch-solve':'/build',JSON.stringify(keepSketch?{document:candidate,sketch:sketchID}:candidate))).json();
  if(JSON.stringify(doc)!==before||from.at(-1)!==saved)throw Error('Modell wurde geändert. Bitte erneut versuchen.');
  to.push(before);if(to.length>60)to.shift();from.pop();
  edgeTool=null;edgeSelection=[];hoverEdge=null;hoverPlane=null;hoverFace=null;waitingPlane=false;selectedFace=null;tool=bind=repair=drag=null;
  dimensionTool=false;dimensionPicks=[];dimensionCursor=dimensionHover=null;closeDimensionEditor();clearRelationsUI();multiReset();
  doc=result.document;
  if(keepSketch){
   selected=sketchID;selectedKind='sketch';mode='2d';originVisible=false;
   const f=doc.features.find(f=>f.id===sketchID);context={id:sketchID,support:f.support,info:result.layout};
   acceptSketchResult(result);
   // Preserve the actual world-to-screen mapping even when sketch bounds change.
   zoom*=view.scale/scale2();const b=sketchBounds();pan=[((b[0]+b[1])/2-view.center[0])*view.scale,(view.center[1]-(b[2]+b[3])/2)*view.scale];
  }else{
   mode='3d';context=null;originVisible=!doc.features.length;selected=doc.features.some(f=>f.id===oldSelection)?oldSelection:null;selectedKind=oldKind;
   acceptBuiltResult(result);
  }
  stash();status(redo?'Wiederhergestellt.':'Rückgängig gemacht.');
 }catch(e){status(e.message,true)}finally{busy=false;render()}
}
$('undo').onclick=()=>undo();$('redo').onclick=()=>undo(true);
window.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();escapeSketch();return;}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();undo(e.shiftKey)}});
// Multiple geometry elements share one sketch and one feature operation.
let polyDraft=[],polyCursor=null,polyEdit=null,activeElement=null,angleMode=false,geometrySaving=false;
const mSigns={bl:[-1,-1],br:[1,-1],tr:[1,1],tl:[-1,1],center:[0,0]};
const mEnds={bottom:['bl','br'],right:['br','tr'],top:['tl','tr'],left:['bl','tl']};
function mPoints(g){if(['polyline','spline'].includes(g.type))return Object.fromEntries(g.points.map(p=>[p.id,[p.x,p.y]]));const c=[g.x,g.y];if(g.type==='ellipse'){const p={center:c,major:ellipsePoint(g,0),minor:ellipsePoint(g,Math.PI/2)};if(!curveClosed(g)){p.start=curvePoint(g,0);p.end=curvePoint(g,1)}return p;}if(g.type==='arc')return {center:c,start:arcPoint(g,g.start),end:arcPoint(g,g.start+g.sweep)};if(g.type==='circle')return {center:c};const t=g.angle||0;return Object.fromEntries(Object.entries(mSigns).map(([key,[sx,sy]])=>{const x=sx*g.a/2,y=sy*g.b/2;return[key,[c[0]+x*Math.cos(t)-y*Math.sin(t),c[1]+x*Math.sin(t)+y*Math.cos(t)]]}))}
function mSegments(g){const p=mPoints(g);if(['circle','arc','ellipse','spline'].includes(g.type))return {};if(g.type==='rect')return Object.fromEntries(Object.entries(mEnds).map(([r,[a,b]])=>[r,[p[a],p[b]]]));return Object.fromEntries(g.points.slice(0,g.closed?g.points.length:-1).map((a,i)=>[a.id,[p[a.id],p[g.points[(i+1)%g.points.length].id]]]))}
function multiConvert(f){if(f.shape==='multi')return;const g={id:'legacy',type:f.shape,x:f.x,y:f.y,a:f.a};if(f.shape==='rect'){g.b=f.b;g.angle=0}f.geometry=[g];for(const d of f.dimensions||[]){if(d.kind==='diameter')d.element='legacy';for(const key of ['first','second'])if(!d[key]?.external&&['point','edge','circle'].includes(d[key]?.kind))d[key].element='legacy'}f.shape='multi';}
function multiReset(){polyDraft=[];polyCursor=null;polyEdit=null;activeElement=null;angleMode=false;}
const oldSketchBounds=sketchBounds;
sketchBounds=function(){const f=activeSketch();if(f?.shape!=='multi')return oldSketchBounds();const b=[...(context?.info.bounds||[-50,50,-50,50])];for(const g of f.geometry){const ps=['ellipse','spline'].includes(g.type)?curveSegments(g).flat():['circle','arc'].includes(g.type)?[[g.x-g.a/2,g.y-g.a/2],[g.x+g.a/2,g.y+g.a/2]]:Object.values(mPoints(g));for(const p of ps){b[0]=Math.min(b[0],p[0]);b[1]=Math.max(b[1],p[0]);b[2]=Math.min(b[2],p[1]);b[3]=Math.max(b[3],p[1])}}return b;};
const oldReferencePoint=referencePoint;
referencePoint=function(ref,f){if(f.shape!=='multi')return oldReferencePoint(ref,f);if(ref.kind==='origin'||ref.kind==='axis')return[0,0];if(ref.kind.startsWith('support-'))return oldReferencePoint(ref,{...f,shape:'rect',x:0,y:0,a:1,b:1});const g=f.geometry.find(g=>g.id===ref.element);if(!g)throw Error('Skizzenelement fehlt');if(ref.kind==='point')return [...mPoints(g)[ref.role]];if(ref.kind==='curve')return curvePoint(g,.5);if(ref.kind==='circle')return[g.x,g.y];const s=mSegments(g)[ref.role];if(!s)throw Error('Linie fehlt');return[(s[0][0]+s[1][0])/2,(s[0][1]+s[1][1])/2];};
const oldGeometryTargets=geometryTargets;
geometryTargets=function(){const f=activeSketch();if(f?.shape!=='multi')return oldGeometryTargets();const out=[{ref:{kind:'origin'},point:[0,0]}];for(const g of f.geometry){for(const [role,p] of Object.entries(mPoints(g)))out.push({ref:{kind:'point',element:g.id,role},point:p});for(const [role,points] of Object.entries(mSegments(g)))out.push({ref:{kind:'edge',element:g.id,role},points});if(['circle','arc'].includes(g.type))out.push({ref:{kind:'circle',element:g.id},center:[g.x,g.y],radius:g.a/2,...(g.type==='arc'?{arc:g,pickSegments:arcSegments(g)}:{})})}for(const [role,t] of Object.entries(context.info.targets||{})){out.push({ref:{kind:'support-edge',role},points:t.points});for(const endpoint of [0,1]){const ref={kind:'support-point',role,endpoint};out.push({ref,point:referencePoint(ref,f)})}}const lo=world(0,H),hi=world(W,0);out.push({ref:{kind:'axis',role:'vertical'},points:[[0,lo[1]],[0,hi[1]]]},{ref:{kind:'axis',role:'horizontal'},points:[[lo[0],0],[hi[0],0]]});return out;};
function refLine(ref){const target=geometryTargets().find(t=>SAME(t.ref,ref));if(!target?.points)throw Error('Bitte eine gerade Linie oder Achse wählen.');if(ref.kind==='support-edge'){const axis=['left','right'].includes(ref.role)?0:1,points=[...target.points].sort((a,b)=>a[1-axis]-b[1-axis]);return [points[0],points.at(-1)]}return [target.points[0],target.points.at(-1)];}
function angleData(first,second,flipFirst=1,flipSecond=1){const [a,b]=refLine(first),[c,d]=refLine(second);const u=sub2(b,a),v=sub2(d,c),cross=u[0]*v[1]-u[1]*v[0],dot=u[0]*v[0]+u[1]*v[1];if(Math.hypot(...u)<1e-8||Math.hypot(...v)<1e-8)throw Error('Linie ohne Länge');let center=a;if(Math.abs(cross)>1e-9){const ca=sub2(c,a),t=(ca[0]*v[1]-ca[1]*v[0])/cross;center=[a[0]+t*u[0],a[1]+t*u[1]]}return {center,u:u.map(x=>x*flipFirst),v:v.map(x=>x*flipSecond),angle:Math.atan2(cross*flipFirst*flipSecond,dot*flipFirst*flipSecond)};}
const oldHitGeometry=hitGeometry;
hitGeometry=function(screen){if(!angleMode)return oldHitGeometry(screen);const hits=geometryTargets().filter(t=>t.points).map(t=>({ref:t.ref,d:targetDistance(t,screen)})).sort((a,b)=>a.d-b.d);return hits[0]?.d<10?hits[0].ref:null;};
const oldMakeDimension=makeDimension;
makeDimension=function(position){const f=activeSketch();if(!f||!dimensionPicks.length)return null;if(f.shape!=='multi')return oldMakeDimension(position);const picks=structuredClone(dimensionPicks),first=picks[0],second=picks[1];if(angleMode){if(!second)return null;let a=angleData(first,second);const delta=sub2(position,a.center),flipFirst=delta[0]*a.u[0]+delta[1]*a.u[1]<0?-1:1,flipSecond=delta[0]*a.v[0]+delta[1]*a.v[1]<0?-1:1;a=angleData(first,second,flipFirst,flipSecond);return {id:uid(),kind:'angle',first,second,flipFirst,flipSecond,value:Math.abs(a.angle)*180/Math.PI,sign:a.angle<0?-1:1,position};}
 if(!second){if(first.kind==='circle'){const g=f.geometry.find(g=>g.id===first.element);return{id:uid(),kind:g.type==='arc'||radiusMode?'radius':'diameter',element:g.id,value:g.type==='arc'||radiusMode?g.a/2:g.a,position}}if(first.kind!=='edge')return null;const [a,b]=refLine(first);return{id:uid(),kind:'length',first,value:Math.hypot(...sub2(b,a)),position};}
 if(picks.some(r=>r.kind==='circle'))throw Error('Für Abstände den Kreismittelpunkt auswählen.');
 const a=referencePoint(first,f),b=referencePoint(second,f);let axis=dimensionAxis;
 const axes=picks.filter(r=>r.kind==='axis');if(axes.length){const forced=axes[0].role==='vertical'?'x':'y';if(axis!=='auto'&&axis!==forced)throw Error('Abstand muss senkrecht zur Achse verlaufen.');axis=forced;}
 if(axis!=='auto'){const i=axis==='x'?0:1;for(const ref of picks.filter(r=>['edge','support-edge','axis'].includes(r.kind))){const [p,q]=refLine(ref);if(Math.abs(q[i]-p[i])>1e-6)throw Error('Abstand muss senkrecht zur Linie verlaufen. Für schräge Linien Auto oder Winkel wählen.')}const delta=b[i]-a[i];return{id:uid(),kind:'linear',axis,first,second,sign:delta<0?-1:1,value:Math.abs(delta),position}}
 const isLine=r=>r.kind==='edge'||r.kind==='support-edge'||r.kind==='axis';let value,sign=1;
 if(!picks.some(isLine))value=Math.hypot(...sub2(b,a));else{const lr=isLine(second)?second:first,other=lr===second?first:second,[p,q]=refLine(lr),v=sub2(q,p),len=Math.hypot(...v);const pt=referencePoint(other,f);if(isLine(other)){const [r,s]=refLine(other),w=sub2(s,r);if(Math.abs(v[0]*w[1]-v[1]*w[0])>1e-5*len*Math.hypot(...w))throw Error('Für Abstand parallele Linien wählen; sonst das Winkelwerkzeug verwenden.')}const d=((pt[0]-p[0])*(-v[1])+(pt[1]-p[1])*v[0])/len;value=Math.abs(d);sign=d<0?-1:1;}
 return{id:uid(),kind:'distance',first,second,value,sign,position};};
function measureLabel(d,p,color,preview){const text=(d.kind==='diameter'?'Ø ':d.kind==='radius'?'R ':'')+Number(d.value.toFixed(3))+(d.kind==='angle'?'°':'');ctx.font='13px system-ui';const w=ctx.measureText(text).width+16;ctx.fillStyle='#112231';ctx.fillRect(p[0]-w/2,p[1]-11,w,22);ctx.strokeStyle=color;ctx.strokeRect(p[0]-w/2,p[1]-11,w,22);ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,...p);ctx.textAlign='start';ctx.textBaseline='alphabetic';if(!preview)dimensionLabels.push({id:d.id,x:p[0],y:p[1],w});}
const oldDrawDimension=drawDimension;
drawDimension=function(d,f,preview=false){if(f.shape!=='multi')return oldDrawDimension(d,f,preview);if(d.kind==='linear')return oldDrawDimension(d,f,preview);const color=preview?'#fff0b8':'#f4cb83',pos=xy(...d.position);let a,b;
 if(d.kind==='angle'){const v=angleData(d.first,d.second,d.flipFirst||1,d.flipSecond||1),c=xy(...v.center),radius=Math.max(22,Math.hypot(...sub2(pos,c))),start=Math.atan2(-v.u[1],v.u[0]),sweep=-v.angle,end=start+sweep;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.arc(c[0],c[1],radius,start,end,sweep<0);ctx.stroke();for(const t of [start,end])line(c,[c[0]+Math.cos(t)*(radius+8),c[1]+Math.sin(t)*(radius+8)],color,.7);const pa=[c[0]+Math.cos(start)*radius,c[1]+Math.sin(start)*radius],pb=[c[0]+Math.cos(end)*radius,c[1]+Math.sin(end)*radius],mid=start+sweep/2;arrow(pa,[c[0]+Math.cos(start+sweep*.08)*radius,c[1]+Math.sin(start+sweep*.08)*radius],color);arrow(pb,[c[0]+Math.cos(end-sweep*.08)*radius,c[1]+Math.sin(end-sweep*.08)*radius],color);measureLabel(d,[c[0]+Math.cos(mid)*radius,c[1]+Math.sin(mid)*radius],color,preview);return;}
 if(d.kind==='diameter'){const g=f.geometry.find(g=>g.id===d.element),c=xy(g.x,g.y),v=sub2(pos,c),len=Math.hypot(...v)||1,r=g.a*scale2()/2;a=[c[0]-v[0]/len*r,c[1]-v[1]/len*r];b=[c[0]+v[0]/len*r,c[1]+v[1]/len*r];line(b,pos,color);}
 else{let pa,pb;if(d.kind==='length')[pa,pb]=refLine(d.first);else{pa=referencePoint(d.first,f);pb=referencePoint(d.second,f);const isLine=r=>['edge','support-edge','axis'].includes(r.kind);if(isLine(d.first)||isLine(d.second)){const lr=isLine(d.second)?d.second:d.first,pt=referencePoint(lr===d.second?d.first:d.second,f),[x,y]=refLine(lr),v=sub2(y,x),t=((pt[0]-x[0])*v[0]+(pt[1]-x[1])*v[1])/(v[0]*v[0]+v[1]*v[1]);pa=pt;pb=[x[0]+t*v[0],x[1]+t*v[1]]}}const p=xy(...pa),q=xy(...pb),v=sub2(q,p),len=Math.hypot(...v)||1,n=[-v[1]/len,v[0]/len],offset=(pos[0]-p[0])*n[0]+(pos[1]-p[1])*n[1];a=[p[0]+n[0]*offset,p[1]+n[1]*offset];b=[q[0]+n[0]*offset,q[1]+n[1]*offset];line(p,a,color,.8);line(q,b,color,.8);}
 line(a,b,color);arrow(a,b,color);arrow(b,a,color);measureLabel(d,d.kind==='diameter'?pos:[(a[0]+b[0])/2,(a[1]+b[1])/2],color,preview);
};
const oldConstraintProfile=drawConstraintProfile;
drawConstraintProfile=function(f){if(f.shape!=='multi')return oldConstraintProfile(f);const st=constraintState(f),copies=new Set((f.relations||[]).filter(r=>r.kind==='mirror').map(r=>r.second?.element));for(const g of f.geometry){const color=c=>copies.has(g.id)?mirrorColor(c):c;ctx.setLineDash(g.construction?[6,4]:[]);const states=st?.elements?.[g.id];if(['circle','arc','ellipse','spline'].includes(g.type)){ctx.beginPath();circlePath(g);ctx.strokeStyle=activeElement===g.id?'#ffcf80':color(stateColor(states?.edges[['ellipse','spline'].includes(g.type)?'curve':'circle']));ctx.lineWidth=2.5;ctx.stroke()}else for(const [role,[a,b]] of Object.entries(mSegments(g)))line(xy(...a),xy(...b),activeElement===g.id?'#ffcf80':color(stateColor(states?.edges[role])),2.5);for(const [role,p] of Object.entries(mPoints(g))){ctx.beginPath();ctx.arc(...xy(...p),3,0,Math.PI*2);ctx.fillStyle=color(states?.points[role]?'#69e094':'#a5adb5');ctx.fill()}}ctx.setLineDash([]);ctx.fillStyle=st?.fully?'#69e094':'#adc4d9';ctx.fillText(st?(st.fully?'Vollständig bestimmt':st.dof+' Freiheitsgrade offen'):'Aktualisierung offen',20,124);ctx.fillText('Grau: unbestimmt · Blau: teilbestimmt · Grün: bestimmt',20,146);};
const oldDraw2=draw2;
draw2=function(){oldDraw2();if(polyDraft.length){ctx.setLineDash([5,4]);for(let i=1;i<polyDraft.length;i++)line(xy(polyDraft[i-1].x,polyDraft[i-1].y),xy(polyDraft[i].x,polyDraft[i].y),'#ffcf80',2);if(polyCursor)line(xy(polyDraft.at(-1).x,polyDraft.at(-1).y),xy(...polyCursor),'#fff',1.5);ctx.setLineDash([]);for(const p of polyDraft){ctx.beginPath();ctx.arc(...xy(p.x,p.y),4,0,Math.PI*2);ctx.fillStyle='#ffcf80';ctx.fill()}}};
function snapPoint(screen){let p=world(...screen),snap=null;if(Math.hypot(...sub2(screen,xy(0,0)))<9)return {p:[0,0],snap:{kind:'origin'}};const targets=geometryTargets().filter(t=>t.point&&t.ref.kind!=='support-point');const nearest=targets.map(t=>({...t,d:Math.hypot(...sub2(screen,xy(...t.point)))})).sort((a,b)=>a.d-b.d)[0];if(nearest?.d<9){p=[...nearest.point];snap={...nearest.ref};if(!snap.external&&activeSketch()?.shape!=='multi'&&['point','edge','circle'].includes(snap.kind))snap.element='legacy'}else if(Math.abs(xy(0,p[1])[0]-screen[0])<7){p[0]=0;snap={kind:'axis',role:'vertical'}}else if(Math.abs(xy(p[0],0)[1]-screen[1])<7){p[1]=0;snap={kind:'axis',role:'horizontal'}}return {p:p.map(n=>Number(n.toFixed(5))),snap};}
async function commitGeometry(g,replaceID=null,options={}){if(busy||geometrySaving||!context)return false;const candidate=structuredClone(doc);let target=candidate.features.find(f=>f.id===context.id);if(!target){target={id:uid(),name:'Skizze '+(doc.features.filter(f=>!isTreatment(f)).length+1),support:structuredClone(context.support),shape:'multi',op:'sketch',geometry:[],dimensions:[],depth:10,reverse:false};candidate.features.push(target)}else multiConvert(target);if(replaceID)target.geometry=target.geometry.map(x=>x.id===replaceID?g:x);else target.geometry.push(g);target.dimensions??=[];
 if(!replaceID&&g.type==='rect'&&options.horizontal){target.relations??=[];target.relations.push({id:uid(),kind:'horizontal',first:{kind:'edge',element:g.id,role:'bottom'}});}
 target.relations??=[];
 for(const p of g.points||[]){if(p.snap&&p.snap.element!==g.id)target.relations.push({id:uid(),kind:'coincident',first:{kind:'point',element:g.id,role:p.id},second:p.snap});delete p.snap;}
 if(g.type==='arc'){for(const role of ['start','end'])if(g.snaps?.[role])target.relations.push({id:uid(),kind:'coincident',first:{kind:'point',element:g.id,role},second:g.snaps[role]});delete g.snaps;}

 const before=JSON.stringify(doc);geometrySaving=true;try{const result=await requestSketchResult(candidate);if(JSON.stringify(doc)!==before)throw Error('Modell wurde geändert. Bitte Zeichnung erneut übernehmen.');mutate(()=>{doc=candidate;selected=target.id;selectedKind='sketch';context={...context,id:target.id}});activeElement=null;acceptBuiltResult(result);return true}catch(e){status(e.message,true);return false}finally{geometrySaving=false}}
async function finishPolyline(closed=false){if(polyDraft.length<(closed?3:2)){polyDraft=[];polyCursor=null;polyEdit=null;draw();return true}const g={id:polyEdit||uid(),type:'polyline',closed,points:structuredClone(polyDraft)};if(await commitGeometry(g,polyEdit)){polyDraft=[];polyCursor=null;polyEdit=null;render();return true}return false;}
async function selectDrawingTool(kind){if(busy||geometrySaving)return;if(polyDraft.length&&!(await finishPolyline(false)))return;if(mode!=='2d'||!context){if(cur()&&!isTreatment(cur()))await editSketch(cur());else await newSketch()}if(!context||mode!=='2d')return;dimensionTool=false;angleMode=false;dimensionPicks=[];closeDimensionEditor();activeElement=null;tool=kind;render();status(kind==='polyline'?'Linienzug: Punkte anklicken · Startpunkt schließt · Enter/Esc beendet offen.':'Form aufziehen · Weitere Formen gehören zur selben Skizze · Esc beendet das Werkzeug.');}
for(const t of ['rect','circle','polyline'])$(t).onclick=()=>selectDrawingTool(t);
const oldNewSketch=newSketch;newSketch=async function(){multiReset();return oldNewSketch()};$('newSketch').onclick=newSketch;
const oldEditSketch=editSketch;editSketch=async function(f){multiReset();return oldEditSketch(f)};
const oldStartDimension=startDimension;startDimension=async function(){if(polyDraft.length&&!(await finishPolyline(false)))return;angleMode=false;await oldStartDimension()};$('dimension').onclick=startDimension;
$('angleDimension').onclick=async()=>{if(polyDraft.length&&!(await finishPolyline(false)))return;const f=cur();if(!f||isTreatment(f)){status('Zuerst eine Skizze zeichnen.',true);return}if(!(await editSketch(f)))return;if(cur().shape!=='multi'){mutate(()=>multiConvert(cur()));if(!(await update()))return}angleMode=true;dimensionTool=true;dimensionPicks=[];dimensionCursor=null;tool=null;render();status('Winkel: erste Linie/Achse, zweite Linie, dann Winkelbogen platzieren.');};
const oldOpenDimensionEditor=openDimensionEditor;openDimensionEditor=function(d,isNew=false){oldOpenDimensionEditor(d,isNew);$('dimValueLabel').textContent=d.kind==='angle'?'Winkel in Grad (0–180°)':'Maßwert in mm';};
$('dimValue').oninput=()=>{try{const d=dimensionDraft||activeSketch()?.dimensions?.find(d=>d.id===editingDimension);$('dimMessage').textContent='= '+calculateMeasure($('dimValue').value)+(d?.kind==='angle'?'°':' mm')+' · Enter übernimmt'}catch(e){$('dimMessage').textContent=e.message}};
const oldPointerDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{if(busy||geometrySaving)return;if(mode==='2d'&&tool==='polyline'&&!e.shiftKey&&e.button===0){e.preventDefault();const screen=point(e);if(polyDraft.length>=3&&Math.hypot(...sub2(screen,xy(polyDraft[0].x,polyDraft[0].y)))<10){await finishPolyline(true);return}const {p,snap}=snapPoint(screen);if(polyDraft.length&&Math.hypot(p[0]-polyDraft.at(-1).x,p[1]-polyDraft.at(-1).y)<1e-5)return;polyDraft.push({id:uid(),x:p[0],y:p[1],...(snap?{snap}:{})});polyCursor=p;render();return;}if(mode==='2d'&&!tool&&!dimensionTool&&!e.shiftKey&&e.button===0){const label=dimensionLabels.some(d=>Math.abs(point(e)[0]-d.x)<d.w/2+3&&Math.abs(point(e)[1]-d.y)<14);if(!label){const ref=hitGeometry(point(e));activeElement=ref?.element||null;render()}}return oldPointerDown(e);};
const oldPointerMove=overlay.onpointermove;overlay.onpointermove=e=>{if(mode==='2d'&&tool==='polyline'&&!drag){polyCursor=snapPoint(point(e)).p;draw();return}oldPointerMove(e);};
const oldPointerUp=overlay.onpointerup;overlay.onpointerup=async e=>{if(mode==='2d'&&drag?.drawing&&['rect','circle'].includes(tool)){const d=drag;drag=null;if(!d.move)return;const a=world(...d.start),b=world(...d.end),w=Math.abs(b[0]-a[0]),h=Math.abs(b[1]-a[1]);if(w<.1||h<.1)return;const round=n=>Number(n.toFixed(4)),g={id:uid(),type:tool,x:round((a[0]+b[0])/2),y:round((a[1]+b[1])/2),a:round(tool==='circle'?Math.min(w,h):w)};if(tool==='rect'){g.b=round(h);g.angle=0}if(await commitGeometry(g,null,{horizontal:g.type==='rect'})){status('Element zur Skizze hinzugefügt · Weiterzeichnen oder Esc.');render()}return}return oldPointerUp(e);};
const oldEscapeSketch=escapeSketch;escapeSketch=async function(){if(mode==='2d'&&tool==='polyline'&&polyDraft.length){if(!(await finishPolyline(false)))return;tool=null;render();return}polyDraft=[];polyCursor=null;polyEdit=null;angleMode=false;return oldEscapeSketch()};
window.addEventListener('keydown',e=>{if(e.key==='Enter'&&tool==='polyline'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();finishPolyline(false)}if(e.key==='Backspace'&&tool==='polyline'&&polyDraft.length&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();polyDraft.pop();draw()}});
async function removeElement(id){const f=activeSketch();if(!f||f.shape!=='multi')return;if(f.geometry.length===1){status('Letztes Element: die gesamte Skizze über das Skizzenmenü löschen.',true);return}const candidate=structuredClone(doc),target=candidate.features.find(x=>x.id===f.id);target.geometry=target.geometry.filter(g=>g.id!==id);target.dimensions=target.dimensions.filter(d=>d.element!==id&&d.first?.element!==id&&d.second?.element!==id);target.relations=(target.relations||[]).filter(r=>![r.first,r.second,r.axis,r.center].some(ref=>ref?.element===id));const before=JSON.stringify(doc);try{const result=await requestSketchResult(candidate);if(JSON.stringify(doc)!==before)throw Error('Modell wurde geändert.');mutate(()=>doc=candidate);activeElement=null;acceptBuiltResult(result)}catch(e){status(e.message,true)}}
const oldRender=render;render=function(){oldRender();$('polyline').disabled=busy||geometrySaving||(!context&&!plane&&!selectedFace);$('polyline').classList.toggle('active',tool==='polyline');$('angleDimension').disabled=busy||!cur()||isTreatment(cur());$('angleDimension').classList.toggle('active',angleMode&&dimensionTool);const f=activeSketch();if(mode==='2d'&&f?.shape==='multi'){note(f.geometry.length+' Elemente · Konturen schließen, bevor du aufpolsterst.');for(const g of f.geometry){const name=g.construction?'Hilfslinie':g.type==='rect'?'Rechteck':g.type==='circle'?'Kreis':g.type==='arc'?'Kreisbogen':g.type==='ellipse'?'Ellipse':g.type==='spline'?'Bézier-Spline':g.closed?'Geschlossener Linienzug':'Offener Linienzug';const b=button(name,()=>{activeElement=g.id;tool=null;render()});b.className='tree'+(activeElement===g.id?' selected':'')}if(activeElement){button('Element löschen',()=>removeElement(activeElement)).className='danger';const g=f.geometry.find(g=>g.id===activeElement);if(g?.type==='polyline'&&!g.closed)button('Linienzug fortsetzen / schließen',()=>{polyDraft=structuredClone(g.points);polyEdit=g.id;tool='polyline';dimensionTool=false;angleMode=false;render()})}}if(tool==='polyline'){note('Startpunkt anklicken: schließen · Enter/Esc: offen beenden · Rücktaste: letzten Entwurfspunkt entfernen.');if(polyDraft.length>=2)button('Linienzug offen beenden',()=>finishPolyline(false));}};
const oldApplyFeature=applyFeature;applyFeature=async function(op){if(polyDraft.length){status('Linienzug zuerst schließen oder mit Enter offen übernehmen.',true);return}angleMode=false;return oldApplyFeature(op)};
for(const id of ['new','open','view3','origins']){const old=$(id).onclick;$(id).onclick=async e=>{if(polyDraft.length&&!(await finishPolyline(false)))return;multiReset();return old(e)}}

const multiOldUndo=undo;undo=async function(redo=false){multiReset();return multiOldUndo(redo)};
// Drag previews live outside the document; release commits one undoable change.
let sketchMove=null,moveTimer=null;
function insidePolygon(p,points){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function moveHit(screen,f,whole=false){const clone=structuredClone(f);multiConvert(clone);const gs=clone.geometry;let nearest=null,best=9;
 for(const g of gs)for(const [role,p] of Object.entries(mPoints(g))){const d=Math.hypot(...sub2(screen,xy(...p)));if(d<best){best=d;nearest={element:g.id,point:['polyline','spline'].includes(g.type)&&!whole?role:null}}}
 if(nearest)return nearest;
 for(const g of [...gs].reverse()){if(['ellipse','spline'].includes(g.type)){if(curveSegments(g).some(([a,b])=>distSegment(screen,xy(...a),xy(...b))<8))return {element:g.id,point:null};}else if(g.type==='arc'){if(arcSegments(g).some(([a,b])=>distSegment(screen,xy(...a),xy(...b))<8))return {element:g.id,point:null};}else if(g.type==='circle'){const d=Math.hypot(...sub2(screen,xy(g.x,g.y)));if(d<=g.a*scale2()/2+7)return {element:g.id,point:null}}else{if(Object.values(mSegments(g)).some(([a,b])=>distSegment(screen,xy(...a),xy(...b))<8))return {element:g.id,point:null};if(g.type==='rect'||g.closed){const ps=g.type==='rect'?['bl','br','tr','tl'].map(k=>mPoints(g)[k]):g.points.map(p=>[p.x,p.y]);if(insidePolygon(world(...screen),ps))return {element:g.id,point:null}}}}return null;
}
const beforeMoveActiveSketch=activeSketch;activeSketch=function(){const f=beforeMoveActiveSketch();return sketchMove?.preview?.feature&&f?.id===sketchMove.sketch?sketchMove.preview.feature:f};
const beforeMoveBounds=sketchBounds;sketchBounds=function(){return sketchMove?sketchMove.bounds:beforeMoveBounds()};
const beforeMoveConstraint=constraintState;constraintState=function(f){return sketchMove?.preview?.constraints&&f?.id===sketchMove.sketch?sketchMove.preview.constraints:beforeMoveConstraint(f)};
function cancelSketchMove(){if(!sketchMove)return false;sketchMove.cancelled=true;sketchMove=null;if(moveTimer!==null)clearTimeout(moveTimer);moveTimer=null;draw();status('Verschieben abgebrochen.');return true;}
async function solveSketchMove(m){if(m.cancelled||sketchMove!==m)return;if(m.flight)return m.flight;if(m.done===m.revision)return;
 const revision=m.revision,delta=[...m.delta];m.flight=(async()=>{try{const r=await request('/sketch-drag',JSON.stringify({document:m.document,sketch:m.sketch,element:m.element,point:m.point,delta}));const result=await r.json();if(sketchMove===m&&!m.cancelled){m.preview=result;m.error=null;draw();status('Verschieben · Maße bleiben erhalten · Loslassen übernimmt · Esc bricht ab.');}}catch(e){if(sketchMove===m&&revision===m.revision){m.error=e.message;status(e.message,true)}}finally{m.done=revision;m.flight=null;}})();await m.flight;
 if(sketchMove===m&&!m.cancelled&&m.done!==m.revision)return solveSketchMove(m);
}
// Keep the scheduled frame during continuous input; one request consumes the latest position.
function queueSketchMove(m){if(moveTimer!==null||m.flight||m.cancelled)return;moveTimer=setTimeout(()=>{moveTimer=null;if(sketchMove===m)solveSketchMove(m)},60)}
function setMovePosition(m,p){m.delta=[(p[0]-m.start[0])/m.scale,-(p[1]-m.start[1])/m.scale];m.revision++;m.moved=m.moved||Math.hypot(...sub2(p,m.start))>3;}
function motionSize(a,b){if(typeof a==='number')return Math.abs(a-b);if(a&&typeof a==='object')return Math.max(0,...Object.keys(a).map(k=>motionSize(a[k],b?.[k])));return 0;}
async function finishSketchMove(m){if(moveTimer!==null)clearTimeout(moveTimer);moveTimer=null;if(!m.moved){sketchMove=null;render();return}geometrySaving=true;
 try{await solveSketchMove(m);while(sketchMove===m&&!m.cancelled&&m.done!==m.revision)await solveSketchMove(m);if(sketchMove!==m||m.cancelled)return;if(m.error)throw Error(m.error);if(!m.preview)throw Error('Verschiebung konnte nicht berechnet werden.');
  const original=m.document.features.find(f=>f.id===m.sketch);if(motionSize(original.geometry,m.preview.feature.geometry)<1e-6){status('In dieser Richtung keine Bewegung möglich: Die Maße oder Bedingungen halten die Geometrie fest.');sketchMove=null;render();return}
  if(JSON.stringify(doc)!==m.before)throw Error('Modell wurde zwischenzeitlich geändert. Bitte erneut verschieben.');
  const candidate=structuredClone(m.document);candidate.features[candidate.features.findIndex(f=>f.id===m.sketch)]=m.preview.feature;
  busy=true;status('Verschiebung wird übernommen …');const result=await requestSketchResult(candidate);if(sketchMove!==m||m.cancelled)return;if(JSON.stringify(doc)!==m.before)throw Error('Modell wurde zwischenzeitlich geändert. Bitte erneut verschieben.');sketchMove=null;mutate(()=>doc=candidate);acceptBuiltResult(result);status('Verschoben · Maße und Bedingungen erhalten.');
 }catch(e){if(sketchMove===m){sketchMove=null;draw();status(e.message,true)}}finally{busy=false;geometrySaving=false;render();if(pending){pending=false;setTimeout(autoUpdate,0)}}
}
const beforeMoveDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{if(sketchMove)return;if(mode==='2d'&&context?.id&&!tool&&!dimensionTool&&!bind&&!repair&&!busy&&!geometrySaving&&!e.shiftKey&&e.button===0){const p=point(e),onLabel=dimensionLabels.some(d=>Math.abs(p[0]-d.x)<d.w/2+3&&Math.abs(p[1]-d.y)<14);const f=activeSketch();if(f&&!onLabel){const hit=moveHit(p,f,e.altKey);if(hit){const bounds=[...sketchBounds()],scale=scale2(),candidate=structuredClone(doc);multiConvert(candidate.features.find(x=>x.id===f.id));sketchMove={...hit,sketch:f.id,document:candidate,before:JSON.stringify(doc),start:p,scale,bounds,delta:[0,0],revision:0,done:-1,moved:false,cancelled:false,flight:null,preview:null,error:null};drag=null;activeElement=hit.element;overlay.setPointerCapture(e.pointerId);e.preventDefault();render();return}}}return beforeMoveDown(e);};
const beforeMovePointer=overlay.onpointermove;overlay.onpointermove=e=>{if(sketchMove){setMovePosition(sketchMove,point(e));if(sketchMove.moved)queueSketchMove(sketchMove);return}return beforeMovePointer(e);};
const beforeMoveUp=overlay.onpointerup;overlay.onpointerup=async e=>{if(sketchMove){const m=sketchMove;setMovePosition(m,point(e));return finishSketchMove(m)}return beforeMoveUp(e);};
const beforeMoveCancel=overlay.onpointercancel;overlay.onpointercancel=e=>{if(!cancelSketchMove())beforeMoveCancel(e)};
const beforeMoveEscape=escapeSketch;escapeSketch=async function(){if(cancelSketchMove())return;return beforeMoveEscape()};
const beforeMoveWheel=overlay.onwheel;overlay.onwheel=e=>{if(sketchMove){e.preventDefault();return}beforeMoveWheel(e)};
// Navigation cancels a transient drag and late responses cannot overwrite the model.
for(const id of ['new','open','view3','view2','newSketch','editSketchTool','origins','undo','redo']){const old=$(id).onclick;$(id).onclick=e=>{cancelSketchMove();return old(e)}}
const beforeMoveUndo=undo;undo=async function(redo=false){cancelSketchMove();return beforeMoveUndo(redo)};

// Geometric relations are independent of numeric dimensions.
const relationNames={coincident:'Koinzidenz',perpendicular:'Rechtwinklig',concentric:'Konzentrisch',horizontal:'Horizontal',vertical:'Vertikal',equal:'Gleichheit',tangent:'Tangentialität',mirror:'Spiegeln mit Bindung',rotation:'Kreismuster'};
const relationIcons={coincident:'⊙',perpendicular:'⊥',concentric:'◎',horizontal:'─',vertical:'│',equal:'=',tangent:'⏜',mirror:'◁│▷',rotation:'⟳'};
let relationTool=null,relationPicks=[],mirrorAxisPhase=false,relationLabels=[],selectedRelation=null,relationHover=null,rotationPhase='elements',rotationCenter=null;
function clearRelationsUI(){rotationPhase='elements';rotationCenter=null;$('rotationEditor').hidden=true;relationHover=null;relationTool=null;relationPicks=[];mirrorAxisPhase=false;selectedRelation=null;}
function localRef(ref){const r=structuredClone(ref);if(!r.external&&activeSketch()?.shape!=='multi'&&['point','edge','circle'].includes(r.kind))r.element='legacy';return r;}
function relationHit(p){const targets=geometryTargets().filter(t=>{
 const ref=localRef(t.ref),first=relationPicks[0],isLine=!!t.points,isPoint=!!t.point,isCircle=ref.kind==='circle';
 if(relationTool==='rotation')return rotationPhase==='elements'?!!ref.element:isPoint&&!relationPicks.some(r=>r.element&&r.element===ref.element);
 if(relationTool==='mirror')return mirrorAxisPhase?isLine&&!relationPicks.some(r=>r.element&&r.element===ref.element):!!ref.element;
 if(first&&!first.element&&!ref.element)return false;
 if(['horizontal','vertical'].includes(relationTool))return isLine&&!!ref.element;
 if(relationTool==='perpendicular')return isLine;
 if(relationTool==='tangent')return first?(first.kind==='circle'?(isLine||isCircle):isCircle):(isLine||isCircle);
 if(relationTool==='concentric')return isCircle;
 if(relationTool==='equal')return first?(first.kind==='circle'?isCircle:isLine):(isLine||isCircle);
 if(relationTool==='coincident')return first&&['edge','axis','support-edge'].includes(first.kind)?isPoint:(isPoint||isLine);
 return true;
 });const hits=targets.map(t=>({...t,d:targetDistance(t,p)})).sort((a,b)=>a.d-b.d);const hit=relationTool&&!['mirror','rotation'].includes(relationTool)&&relationPicks.length?hits.find(t=>t.d<10&&!relationPicks.some(r=>SAME(r,localRef(t.ref))))||hits[0]:hits[0];return hit?.d<10?localRef(hit.ref):null;}

async function commitRelations(change){if(busy||geometrySaving)return false;const f=activeSketch();if(!f)return false;const candidate=structuredClone(doc),target=candidate.features.find(g=>g.id===f.id),before=JSON.stringify(doc);multiConvert(target);target.relations??=[];geometrySaving=true;busy=true;
 try{change(target);const result=await requestSketchResult(candidate);if(JSON.stringify(doc)!==before)throw Error('Modell wurde geändert. Bitte erneut versuchen.');mutate(()=>doc=candidate);clearRelationsUI();acceptBuiltResult(result);status('Bedingung übernommen · Maße und Bindungen werden gemeinsam gelöst.');return true}catch(e){status(e.message,true);return false}finally{geometrySaving=false;busy=false;render()}}
async function applyPickedRelation(){const kind=relationTool,picks=structuredClone(relationPicks);if(!kind||['mirror','rotation'].includes(kind))return;const needed=['horizontal','vertical'].includes(kind)?1:2;if(picks.length!==needed)return;
 const r={id:uid(),kind,first:picks[0]};if(needed===2)r.second=picks[1];
 if(kind==='tangent'){
  const lineRef=picks.find(r=>r.kind!=='circle'),circleRef=picks.find(r=>r.kind==='circle');
  if(lineRef&&circleRef){const [a,b]=refLine(lineRef),t=geometryTargets().find(t=>SAME(localRef(t.ref),circleRef)),v=sub2(b,a);r.orientation=((t.center[0]-a[0])*(-v[1])+(t.center[1]-a[1])*v[0])<0?-1:1;}
 }
 if(kind==='perpendicular'){const [a,b]=refLine(picks[0]),[c,d]=refLine(picks[1]),u=sub2(b,a),v=sub2(d,c);r.orientation=u[0]*v[1]-u[1]*v[0]<0?-1:1;}
 await commitRelations(f=>{if((f.relations||[]).some(x=>x.kind===kind&&SAME(x.first,r.first)&&SAME(x.second,r.second)))throw Error('Diese Bedingung ist bereits vorhanden.');f.relations.push(r)});
}
async function startRelation(kind){if(busy||geometrySaving)return;cancelSketchMove();const saved=structuredClone(relationPicks);if(polyDraft.length&&!(await finishPolyline(false)))return;if(mode!=='2d'){const f=cur();if(!f||isTreatment(f)||!(await editSketch(f)))return}if(!activeSketch()){status('Zuerst Geometrie zeichnen.',true);return}clearRelationsUI();relationTool=kind;relationPicks=saved;tool=null;dimensionTool=false;angleMode=false;dimensionPicks=[];drag=null;closeDimensionEditor();activeElement=null;render();
 status(kind==='mirror'?'Spiegeln: Elemente anklicken, dann „Achse wählen“ und eine Achse oder gerade Linie anklicken.':relationNames[kind]+': '+(['horizontal','vertical'].includes(kind)?'eine Linie auswählen.':'zwei passende Geometrien auswählen.'));
 if(kind==='rotation')status('Kreismuster: Elemente auswählen, dann Mittelpunkt wählen.');else if(kind!=='mirror')await applyPickedRelation();
}
function reflectPoint(p,a,b){const v=sub2(b,a),len2=v[0]*v[0]+v[1]*v[1];if(len2<1e-12)throw Error('Spiegelachse ohne Länge');const d=sub2(p,a),t=(d[0]*v[0]+d[1]*v[1])/len2;return[a[0]+2*t*v[0]-d[0],a[1]+2*t*v[1]-d[1]];}
async function createMirror(axis){const ids=[...new Set(relationPicks.map(r=>r.element).filter(Boolean))];if(!ids.length)return;const [a,b]=refLine(axis);await commitRelations(f=>{
 if(ids.includes(axis.element))throw Error('Eine unabhängige Linie oder Grundachse als Spiegelachse wählen.');
 for(const id of ids){const original=f.geometry.find(g=>g.id===id);if(!original)throw Error('Spiegelelement fehlt');const g=structuredClone(original);g.id=uid();
 if(['polyline','spline'].includes(g.type))g.points=g.points.map(p=>{const q=reflectPoint([p.x,p.y],a,b);return{id:uid(),x:q[0],y:q[1]}});
 else{[g.x,g.y]=reflectPoint([g.x,g.y],a,b);if(g.type==='ellipse'){g.start=-g.start;g.sweep=-g.sweep;}if(g.type==='arc'){g.start=2*Math.atan2(b[1]-a[1],b[0]-a[0])-g.start;g.sweep=-g.sweep;}if(['rect','ellipse'].includes(g.type))g.angle=2*Math.atan2(b[1]-a[1],b[0]-a[0])-(g.angle||0);}
 // Reject coincident copies, including rectangles/circles centered on the axis.
 const same=g.type==='circle'?Math.hypot(g.x-original.x,g.y-original.y)<1e-6:Object.values(mPoints(g)).every(p=>Object.values(mPoints(original)).some(q=>Math.hypot(...sub2(p,q))<1e-6));
 const duplicate=f.geometry.some(other=>other.type===g.type&&(g.type==='circle'?Math.hypot(g.x-other.x,g.y-other.y)<1e-6&&Math.abs(g.a-other.a)<1e-6:Object.keys(mPoints(g)).length===Object.keys(mPoints(other)).length&&Object.values(mPoints(g)).every(p=>Object.values(mPoints(other)).some(q=>Math.hypot(...sub2(p,q))<1e-6))));
 if(same||duplicate)throw Error('Das Spiegelbild liegt bereits auf vorhandener Geometrie. Doppelte Geometrie wird nicht erzeugt.');
 f.geometry.push(g);f.relations.push({id:uid(),kind:'mirror',first:{kind:'geometry',element:id},second:{kind:'geometry',element:g.id},axis:structuredClone(axis)});
 }
 });}
for(const kind of Object.keys(relationNames))$('rel-'+kind).onclick=()=>startRelation(kind);
$('mirror-axis').onclick=()=>{if(relationTool!=='mirror'||!relationPicks.length)return;relationHover=null;mirrorAxisPhase=true;render();status('Jetzt horizontale/vertikale Grundachse oder eine unabhängige gerade Linie auswählen.');};
$('relation-clear').onclick=()=>{clearRelationsUI();render()};
const relDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{
 if(mode==='2d'&&!busy&&!geometrySaving&&e.button===0&&!e.shiftKey){const p=point(e);
 if(relationTool||e.ctrlKey||e.metaKey){relationHover=null;e.preventDefault();const ref=relationHit(p);if(!ref)return;if(relationTool==='mirror'&&mirrorAxisPhase){await createMirror(ref);return}const key=['mirror','rotation'].includes(relationTool)?'element':null,idx=relationPicks.findIndex(r=>key?r[key]===ref[key]:SAME(r,ref));if(idx>=0)relationPicks.splice(idx,1);else relationPicks.push(ref);render();if(relationTool&&!['mirror','rotation'].includes(relationTool))await applyPickedRelation();return}
 const label=relationLabels.find(l=>Math.abs(p[0]-l.x)<17&&Math.abs(p[1]-l.y)<12);if(label&&!tool&&!dimensionTool){selectedRelation=label.id;overlay.tabIndex=0;overlay.focus({preventScroll:true});render();status('Bedingung ausgewählt · Entf zum Löschen.');return}
 }return relDown(e);
};
const relUp=overlay.onpointerup;overlay.onpointerup=e=>{if(relationTool)return;return relUp(e)};
function relationAnchor(ref,f){if(ref?.kind==='geometry'){const g=f.geometry.find(g=>g.id===ref.element);if(!g)return[0,0];if(!['polyline','spline'].includes(g.type))return[g.x,g.y];return[g.points[0].x,g.points[0].y]}return referencePoint(ref,f);}
function highlightRelationRef(ref,f,color='#ffce78'){if(ref.kind==='geometry'){const g=f.shape==='multi'?f.geometry.find(g=>g.id===ref.element):{...f,type:f.shape};if(!g)return;if(['circle','arc'].includes(g.type))ref={kind:'circle',element:g.id};else{for(const [a,b] of Object.values(mSegments(g)))line(xy(...a),xy(...b),color,4);return}}
 if(ref.kind==='circle'){const g=f.geometry?.find(g=>g.id===ref.element)||f;ctx.beginPath();circlePath(g);ctx.strokeStyle=color;ctx.lineWidth=4;ctx.stroke();}
 else if(['edge','axis','support-edge'].includes(ref.kind)){const [a,b]=refLine(ref);line(xy(...a),xy(...b),color,4)}else{ctx.beginPath();ctx.arc(...xy(...referencePoint(ref,f)),6,0,Math.PI*2);ctx.strokeStyle=color;ctx.stroke()}}
const relDraw=draw2;draw2=function(){relDraw();relationLabels=[];const f=activeSketch();if(!f)return;for(const r of relationPicks){try{highlightRelationRef(['mirror','rotation'].includes(relationTool)?{kind:'geometry',element:r.element}:r,f)}catch{}}
 for(const [i,r] of (f.relations||[]).entries()){const p=xy(...relationAnchor(r.second||r.first,f)),x=p[0]+20+(i%3)*32,y=p[1]-20-Math.floor(i/3)%3*24;ctx.fillStyle=r.id===selectedRelation?'#8a5d25':'#173f45';ctx.fillRect(x-16,y-11,32,22);ctx.fillStyle='#a1efdc';ctx.font='15px system-ui';ctx.textAlign='center';ctx.fillText(relationIcons[r.kind],x,y+5);ctx.textAlign='start';relationLabels.push({id:r.id,x,y});if(r.id===selectedRelation)for(const ref of [r.first,r.second,r.axis,r.center].filter(Boolean)){try{highlightRelationRef(ref,f)}catch{}}}
};
const relRender=render;render=function(){relRender();const f=activeSketch(),disabled=busy||geometrySaving||!f;for(const k of Object.keys(relationNames)){$('rel-'+k).disabled=disabled;$('rel-'+k).classList.toggle('active',relationTool===k)}$('mirror-axis').hidden=relationTool!=='mirror';$('mirror-axis').disabled=disabled||!relationPicks.length||mirrorAxisPhase;$('relation-clear').hidden=!relationTool&&!relationPicks.length;$('relation-hint').textContent=relationTool?relationNames[relationTool]+' · '+relationPicks.length+' ausgewählt':'Strg + Klick: Geometrien vorauswählen';
 if(mode==='2d'&&f){for(const [i,r] of (f.relations||[]).entries()){button(r.kind==='mirror'?'◁│▷ Spiegelpaar '+((f.relations||[]).filter(x=>x.kind==='mirror').findIndex(x=>x.id===r.id)+1)+' · Original → Spiegelbild':relationIcons[r.kind]+' '+relationNames[r.kind]+' '+(i+1),()=>{selectedRelation=r.id;render()}).className='tree'+(selectedRelation===r.id?' selected':'')}
 if(selectedRelation)button('Bedingung löschen',deleteSelectedRelation).className='danger';}
};
const relEscape=escapeSketch;escapeSketch=async function(){if(relationTool||relationPicks.length||selectedRelation){clearRelationsUI();render();return}return relEscape()};
const relReset=multiReset;multiReset=function(){clearRelationsUI();return relReset()};
const relDrawing=selectDrawingTool;selectDrawingTool=async function(k){clearRelationsUI();return relDrawing(k)};
const relDimension=startDimension;startDimension=async function(){clearRelationsUI();return relDimension()};$('dimension').onclick=startDimension;
for(const id of ['angleDimension','view3','view2','new','open','origins']){const old=$(id).onclick;$(id).onclick=e=>{clearRelationsUI();return old(e)}}

// Hover uses exactly the same eligible targets as clicking a condition.
const relationPointerMove=overlay.onpointermove;
overlay.onpointermove=e=>{
 relationHover=mode==='2d'&&relationTool&&!busy&&!geometrySaving&&!e.shiftKey?relationHit(point(e)):null;
 relationPointerMove(e);
 if(mode==='2d'&&relationTool)draw();
};
const relationPointerLeave=overlay.onpointerleave;
overlay.onpointerleave=e=>{relationHover=null;relationPointerLeave?.(e);draw()};
function mirrorBadges(f){
 const mirrors=(f.relations||[]).filter(r=>r.kind==='mirror');
 if(!mirrors.length)return;
 ctx.font='12px system-ui';ctx.fillStyle='#adc4d9';ctx.fillText('Spiegelpaare: O = Original · S = Spiegelbild · Nummer verbindet das Paar',20,168);
 for(const [i,r] of mirrors.entries()){
  for(const [ref,prefix,color] of [[r.first,'O','#7ecfff'],[r.second,'S','#d6a3ff']]){
   const anchor=xy(...relationAnchor(ref,f)),occupied=[...dimensionLabels,...relationLabels];
   const offsets=[[28,22],[-28,22],[28,46],[-28,46],[60,22],[-60,22],[28,70],[-28,70]];
   const offset=offsets.find(([dx,dy])=>!occupied.some(l=>Math.abs(anchor[0]+dx-l.x)<((l.w||32)/2+20)&&Math.abs(anchor[1]+dy-l.y)<25))||[28,22+24*i];
   const x=anchor[0]+offset[0],y=anchor[1]+offset[1];
   line(anchor,[x,y],color,1);ctx.fillStyle='#162333';ctx.fillRect(x-17,y-11,34,22);ctx.strokeStyle=color;ctx.lineWidth=r.id===selectedRelation?2:1;ctx.strokeRect(x-17,y-11,34,22);ctx.fillStyle=color;ctx.font='12px system-ui';ctx.textAlign='center';ctx.fillText(prefix+(i+1),x,y+4);ctx.textAlign='start';relationLabels.push({id:r.id,x,y,w:34});
  }
  if(r.id===selectedRelation){highlightRelationRef(r.first,f,'#7ecfff');highlightRelationRef(r.second,f,'#d6a3ff');highlightRelationRef(r.axis,f,'#ffce78');}
 }
}
const hoverRelationDraw=draw2;draw2=function(){hoverRelationDraw();const f=activeSketch();if(!f)return;
 if(relationHover&&relationTool){const whole=relationTool==='mirror'&&!mirrorAxisPhase||relationTool==='rotation'&&rotationPhase==='elements';const picked=relationPicks.some(r=>whole?r.element===relationHover.element:SAME(r,relationHover));if(!picked){const ref=whole?{kind:'geometry',element:relationHover.element}:relationHover;highlightRelationRef(ref,f,'#75e7ff');}}
 mirrorBadges(f);
};

function externalItem(ref){const items=context?.info.external||[],matches=items.filter(t=>SAME(t.ref,ref.external));if(matches.length!==1)throw Error('Externe Referenz fehlt. Modell aktualisieren oder Bedingung neu zuordnen.');return matches[0];}
function externalPoint(ref){const t=externalItem(ref);if(t.type==='circle')return [...t.center];if(ref.kind==='point'){const i=t.vertices.findIndex(v=>SAME(v,ref.vertex));if(i<0)throw Error('Externer Endpunkt fehlt');return [...t.points[i]]}return t.points[0].map((x,i)=>(x+t.points[1][i])/2);}
const extReferencePoint=referencePoint;referencePoint=function(ref,f){if(ref.kind==='fixed-point')return [...ref.position];return ref.external?externalPoint(ref):extReferencePoint(ref,f)};
const extGeometryTargets=geometryTargets;
geometryTargets=function(){const out=extGeometryTargets();if(!activeSketch())return out;const segments=visibleSketchBodySegments(),byRef=new Map();for(const s of segments){if(!s.ref)continue;const key=JSON.stringify(s.ref);if(!byRef.has(key))byRef.set(key,[]);byRef.get(key).push(s)}
 const items=[...(context?.info.external||[])].sort((a,b)=>(b.depth??Math.max(...b.depths))-(a.depth??Math.max(...a.depths)));
 for(const t of items){const visible=byRef.get(JSON.stringify(t.ref));if(!visible?.length)continue;const external=t.ref,pickSegments=visible.map(s=>[s.a.slice(0,2),s.b.slice(0,2)]);
 if(t.type==='circle'){out.push({ref:{kind:'circle',external},center:t.center,radius:t.radius,pickSegments});out.push({ref:{kind:'point',role:'center',external},point:t.center});}
 else{out.push({ref:{kind:'edge',external},points:t.points,pickSegments});for(let i=0;i<2;i++){const p=t.points[i];if(visible.some(s=>distSegment(p,s.a,s.b)<1e-5))out.push({ref:{kind:'point',external,vertex:t.vertices[i]},point:p})}}
 }
 return out;
};
function targetDistance(t,p){if(t.point)return Math.hypot(...sub2(p,xy(...t.point)));if(t.pickSegments)return Math.min(...t.pickSegments.map(([a,b])=>distSegment(p,xy(...a),xy(...b))));return t.center?Math.abs(Math.hypot(...sub2(p,xy(...t.center)))-t.radius*scale2()):distSegment(p,xy(...t.points[0]),xy(...t.points.at(-1)));}
// Stable reference geometry remains resolvable even if its display is switched off.
const extRefLine=refLine;refLine=function(ref){if(ref.external){const t=externalItem(ref);if(t.type!=='line')throw Error('Gerade Referenzkante auswählen');return t.points.map(p=>[...p])}return extRefLine(ref)};
const extHighlight=highlightRelationRef;highlightRelationRef=function(ref,f,color='#ffce78'){if(!ref.external)return extHighlight(ref,f,color);const t=externalItem(ref);if(ref.kind==='point'){ctx.beginPath();ctx.arc(...xy(...externalPoint(ref)),6,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke()}else if(t.type==='circle'){ctx.beginPath();if(t.arc)circlePath(t.arc);else ctx.arc(...xy(...t.center),t.radius*scale2(),0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=3;ctx.stroke()}else line(xy(...t.points[0]),xy(...t.points[1]),color,3);};
const extMakeDimension=makeDimension;makeDimension=function(position){if(dimensionPicks.some(r=>r.external)&&!dimensionPicks.some(r=>!r.external&&['point','edge','circle'].includes(r.kind)))throw Error('Mindestens ein Element der aktiven Skizze auswählen.');return extMakeDimension(position)};
const extDraw=draw2;draw2=function(){extDraw();if(!relationTool)return;for(const t of geometryTargets()){if(!t.ref.external||!t.point)continue;const r=t.ref;if(relationTool!=='coincident')continue;const p=xy(...t.point);ctx.beginPath();ctx.arc(...p,3,0,Math.PI*2);ctx.fillStyle='#83b9c9';ctx.fill()}};

// Construction lines participate in constraints, but not in extrusion contours.
let constructionDraft=[];
$('construction').onclick=async()=>{await selectDrawingTool('construction');if(tool==='construction'){constructionDraft=[];status('Hilfslinie: Start- und Endpunkt anklicken. Sie bleibt beim Aufpolstern unberücksichtigt.')}};
function rotatedGeometry(original,center,degrees,newID=true){const g=structuredClone(original),a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);const rotate=p=>{const x=p[0]-center[0],y=p[1]-center[1];return[center[0]+c*x-s*y,center[1]+s*x+c*y]};if(newID)g.id=uid();if(['polyline','spline'].includes(g.type))g.points=g.points.map(p=>{const [x,y]=rotate([p.x,p.y]);return {...p,id:newID?uid():p.id,x,y}});else{[g.x,g.y]=rotate([g.x,g.y]);if(g.type==='arc')g.start+=a;if(['rect','ellipse'].includes(g.type))g.angle=(g.angle||0)+a}return g;}
function sameSketchGeometry(a,b){if(a.type!==b.type)return false;if(a.type==='circle')return Math.hypot(a.x-b.x,a.y-b.y)<1e-6&&Math.abs(a.a-b.a)<1e-6;const ap=Object.values(mPoints(a)),bp=Object.values(mPoints(b));return ap.length===bp.length&&ap.every(p=>bp.some(q=>Math.hypot(...sub2(p,q))<1e-6));}
function patternSettings(){const count=calculateMeasure($('rotationCount').value),sweep=calculateMeasure($('rotationSweep').value);if(!Number.isInteger(count)||count<2||count>24)throw Error('Anzahl: ganze Zahl von 2 bis 24, einschließlich Original.');if(!(sweep>0&&sweep<=360))throw Error('Gesamtwinkel: größer 0 bis 360°.');return {count,sweep,step:sweep/(Math.abs(sweep-360)<1e-8?count:count-1)};}
async function createRotation(){let settings;try{settings=patternSettings()}catch(e){$('rotationMessage').textContent=e.message;return}const ids=[...new Set(relationPicks.map(r=>r.element).filter(Boolean))],center=structuredClone(rotationCenter);if(!center||!ids.length)return;const origin=referencePoint(center,activeSketch()),pattern=uid();
 if(await commitRelations(f=>{if(ids.includes(center.element))throw Error('Musterzentrum muss unabhängig von den ausgewählten Elementen sein.');if(f.geometry.length+ids.length*(settings.count-1)>60)throw Error('Muster würde mehr als 60 Skizzenelemente erzeugen.');const originals=ids.map(id=>f.geometry.find(g=>g.id===id));for(const original of originals){if(!original)throw Error('Originalelement fehlt');for(let i=1;i<settings.count;i++){const angle=i*settings.step,g=rotatedGeometry(original,origin,angle);if(f.geometry.some(other=>sameSketchGeometry(g,other)))throw Error('Eine Musterkopie liegt auf vorhandener Geometrie. Mittelpunkt, Anzahl oder Winkel ändern.');f.geometry.push(g);f.relations.push({id:uid(),kind:'rotation',pattern,index:i,count:settings.count,sweep:settings.sweep,angle,first:{kind:'geometry',element:original.id},second:{kind:'geometry',element:g.id},center:structuredClone(center)});}}}))status('Kreismuster erstellt · Position und Größe bleiben an das Original gebunden.');
}
$('rotation-center').onclick=()=>{if(relationTool!=='rotation'||!relationPicks.length)return;rotationPhase='center';relationHover=null;render();status('Musterzentrum: Ursprung, unabhängigen Punkt oder freie Position anklicken.');};
$('rotationApply').onclick=createRotation;$('rotationCancel').onclick=()=>{clearRelationsUI();render()};
for(const id of ['rotationCount','rotationSweep']){$(id).oninput=()=>{try{const s=patternSettings();$('rotationMessage').textContent='Winkelschritt: '+Number(s.step.toFixed(3))+'°'}catch(e){$('rotationMessage').textContent=e.message}};$(id).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();createRotation()}if(e.key==='Escape'){e.preventDefault();clearRelationsUI();render()}};}
const patternDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{if(busy||geometrySaving)return;if(mode==='2d'&&e.button===0&&!e.shiftKey){const p=point(e);
 if(tool==='construction'){e.preventDefault();const snapped=snapPoint(p);if(!constructionDraft.length){polyCursor=snapped.p;constructionDraft=[{id:uid(),x:snapped.p[0],y:snapped.p[1],...(snapped.snap?{snap:snapped.snap}:{})}];draw();return}if(Math.hypot(constructionDraft[0].x-snapped.p[0],constructionDraft[0].y-snapped.p[1])<1e-5)return;const g={id:uid(),type:'polyline',closed:false,construction:true,points:[...constructionDraft,{id:uid(),x:snapped.p[0],y:snapped.p[1],...(snapped.snap?{snap:snapped.snap}:{})}]};if(await commitGeometry(g)){constructionDraft=[];render();status('Hilfslinie erstellt · Weitere zeichnen oder Esc.');}return;}
 if(relationTool==='rotation'&&rotationPhase==='center'){e.preventDefault();const hit=relationHit(p);rotationCenter=hit||{kind:'fixed-point',position:world(...p)};rotationPhase='settings';relationHover=null;$('rotationEditor').hidden=false;$('rotationCount').value='6';$('rotationSweep').value='360';$('rotationMessage').textContent='Anzahl einschließlich Original · 360° ergibt einen geschlossenen Teilkreis.';$('rotationCount').focus();$('rotationCount').select();draw();return;}
 if(relationTool==='rotation'&&rotationPhase==='settings')return;
 }return patternDown(e);};
const patternMove=overlay.onpointermove;overlay.onpointermove=e=>{if(mode==='2d'&&tool==='construction'){polyCursor=world(...point(e));draw();return}return patternMove(e)};
const patternUp=overlay.onpointerup;overlay.onpointerup=e=>{if(tool==='construction'||relationTool==='rotation')return;return patternUp(e)};
const patternDraw=draw2;draw2=function(){patternDraw();if(constructionDraft.length&&polyCursor){ctx.setLineDash([6,4]);line(xy(constructionDraft[0].x,constructionDraft[0].y),xy(...polyCursor),'#ffcf80',2);ctx.setLineDash([])}if(rotationCenter&&relationTool==='rotation')highlightRelationRef(rotationCenter,activeSketch(),'#ffcf80');};
const patternRender=render;render=function(){patternRender();$('construction').disabled=busy||geometrySaving||(!context&&!plane&&!selectedFace);$('construction').classList.toggle('active',tool==='construction');$('rotation-center').hidden=relationTool!=='rotation';$('rotation-center').disabled=busy||geometrySaving||!relationPicks.length||rotationPhase!=='elements';const f=activeSketch();if(mode==='2d'&&f){const groups=[...new Set((f.relations||[]).filter(r=>r.kind==='rotation').map(r=>r.pattern))];for(const id of groups){const r=f.relations.find(r=>r.pattern===id);note('Kreismuster: '+r.count+' Instanzen · '+r.sweep+'° · Original enthalten.');button('Musterbindung lösen',()=>commitRelations(target=>{target.relations=target.relations.filter(x=>x.kind!=='rotation'||x.pattern!==id)}));}}};
const patternReset=multiReset;multiReset=function(){constructionDraft=[];return patternReset()};
const patternEscape=escapeSketch;escapeSketch=async function(){if(tool==='construction'){constructionDraft=[];polyCursor=null;tool=null;render();return}return patternEscape()};
const patternDrawing=selectDrawingTool;selectDrawingTool=async function(kind){constructionDraft=[];return patternDrawing(kind)};

// Revolved solids and cuts: settings stay in a draft until a successful build.
let revolveDraft=null;
function isRevolve(f){return ['revolve','revolve-pocket'].includes(f?.op)}
function revolveAxes(f){const axes=[{label:'Horizontale Skizzenachse',ref:{kind:'axis',role:'horizontal'}},{label:'Vertikale Skizzenachse',ref:{kind:'axis',role:'vertical'}}];for(const g of f.geometry||[])if(g.construction&&g.type==='polyline')for(let i=0;i<g.points.length-1;i++)axes.push({label:'Hilfslinie '+g.id+' · '+(i+1),ref:{kind:'edge',element:g.id,role:g.points[i].id}});return axes}
async function beginRevolve(op){if(busy||geometrySaving)return;const f=cur();if(!f||isTreatment(f))return;if(polyDraft.length||constructionDraft.length){status('Bitte zuerst den Linienzug abschließen.',true);return}await editSketch(f);clearRelationsUI();dimensionTool=false;closeDimensionEditor();tool=null;revolveDraft={id:f.id,op,axis:structuredClone(f.revolveAxis||{kind:'axis',role:'vertical'}),angle:f.revolveAngle||360,reverse:!!f.reverse};render();status('Rotationsachse und Winkel wählen, anschließend Rotation übernehmen.');}
async function commitRevolve(){if(!revolveDraft||busy||geometrySaving)return;const draft=structuredClone(revolveDraft),candidate=structuredClone(doc),f=candidate.features.find(x=>x.id===draft.id),before=JSON.stringify(doc);if(!f)return;busy=true;geometrySaving=true;
 try{multiConvert(f);f.op=draft.op;f.revolveAxis=draft.axis;f.revolveAngle=calculateMeasure(String(draft.angle));f.reverse=draft.reverse;const result=await(await request('/build',JSON.stringify(candidate))).json();if(JSON.stringify(doc)!==before)throw Error('Modell wurde geändert. Bitte erneut versuchen.');mutate(()=>doc=candidate);revolveDraft=null;acceptBuiltResult(result);selected=f.id;selectedKind='feature';collapsedNodes.delete(f.id);mode='3d';context=null;originVisible=false;fit();status('Rotation erstellt. Winkel und Richtung werden bei Änderungen automatisch aktualisiert.');}catch(e){status(e.message,true)}finally{busy=false;geometrySaving=false;render()}}
function revolvePanel(){const f=cur();if(!f||revolveDraft.id!==f.id){revolveDraft=null;return}const d=revolveDraft;$('edit').replaceChildren();note(d.op==='revolve'?'Rotationskörper':'Rotationstasche');const select=document.createElement('select');select.id='revolveAxis';const axes=revolveAxes(f);for(let i=0;i<axes.length;i++){const o=document.createElement('option');o.value=String(i);o.textContent=axes[i].label;select.append(o)}select.value=String(axes.findIndex(a=>SAME(a.ref,d.axis)));select.onchange=()=>{d.axis=structuredClone(axes[Number(select.value)].ref);draw()};$('edit').append(select);const label=document.createElement('label');label.textContent='Rotationswinkel (°)';const angle=document.createElement('input');angle.id='revolveAngle';angle.type='text';angle.value=String(d.angle);angle.oninput=()=>d.angle=angle.value;angle.onkeydown=e=>{if(e.key==='Enter')commitRevolve()};label.append(angle);$('edit').append(label);const reverse=document.createElement('input');reverse.type='checkbox';reverse.checked=d.reverse;reverse.onchange=()=>d.reverse=reverse.checked;const l=document.createElement('label');l.append(reverse,document.createTextNode('Richtung umkehren'));$('edit').append(l);note('360° = volle Umdrehung. Profil auf einer Seite der Achse zeichnen.');button('Rotation übernehmen',commitRevolve);button('Abbrechen',()=>{revolveDraft=null;render()});}
$('revolveTool').onclick=()=>beginRevolve('revolve');$('revolvePocketTool').onclick=()=>beginRevolve('revolve-pocket');
const revolveRender=render;render=function(){revolveRender();const f=cur();for(const id of ['revolveTool','revolvePocketTool'])$(id).disabled=busy||geometrySaving||!f||isTreatment(f);if(revolveDraft)revolvePanel();else if(isRevolve(f)&&selectedKind==='feature')button('Rotationsachse / Winkel bearbeiten',()=>beginRevolve(f.op));};
const revolveDraw=draw2;draw2=function(){revolveDraw();if(revolveDraft&&activeSketch()?.id===revolveDraft.id)highlightRelationRef(revolveDraft.axis,activeSketch(),'#ffcf80');};
const revolveReset=multiReset;multiReset=function(){revolveDraft=null;return revolveReset()};
const revolveEscape=escapeSketch;escapeSketch=async function(){if(revolveDraft){revolveDraft=null;render();return}return revolveEscape()};
const revolveDrawing=selectDrawingTool;selectDrawingTool=async function(kind){revolveDraft=null;return revolveDrawing(kind)};


async function requestSketchResult(candidate){
 const id=context?.id||candidate.features.at(-1)?.id;
 if(mode!=='2d'||!id)return (await request('/build',JSON.stringify(candidate))).json();
 return (await request('/sketch-solve',JSON.stringify({document:candidate,sketch:id}))).json();
}
function acceptSketchResult(result){
 doc=result.document;dirty=true;lastError='';const l=result.layout;
 l.solvedFeature=JSON.stringify(doc.features.find(f=>f.id===l.id));
 mesh={...mesh,layouts:[...(mesh?.layouts||[]).filter(x=>x.id!==l.id),l]};
 stash();syncContext();render();
}

// Annotation layout changes never change model geometry or its dirty state.
let dimensionMove=null;
function dimensionLabelHit(p){return [...dimensionLabels].reverse().find(d=>Math.abs(p[0]-d.x)<d.w/2+3&&Math.abs(p[1]-d.y)<14)}
function cancelDimensionMove(){if(!dimensionMove)return false;dimensionMove=null;overlay.style.cursor='default';draw();return true}
function dimensionLayoutKey(document){const clone=structuredClone(document);for(const f of clone.features)for(const d of f.dimensions||[]){delete d.position;delete d.layout;}return JSON.stringify(clone)}
function syncDimensionLayout(before){for(const f of doc.features){const l=layout(f),old=before.features.find(x=>x.id===f.id);if(l&&old&&l.solvedFeature===JSON.stringify(old))l.solvedFeature=JSON.stringify(f)}if(mesh&&!dirty)mesh.document=doc;stash();syncContext();render()}
function moveDimensionLabel(e){const m=dimensionMove,p=point(e),dx=p[0]-m.start[0],dy=p[1]-m.start[1];if(Math.hypot(dx,dy)>4)m.moved=true;if(m.moved){m.position=[m.anchor[0]+dx/m.scale,m.anchor[1]-dy/m.scale].map(v=>Math.max(-10000,Math.min(10000,v)));draw()}}
const annotationDraw=drawDimension;drawDimension=function(d,f,preview=false){const m=dimensionMove;return annotationDraw(m?.moved&&m.sketch===f.id&&m.id===d.id?{...d,position:m.position}:d,f,preview)};
const annotationDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{if(dimensionMove)return;if(mode==='2d'&&e.button===0&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!tool&&!relationTool&&!revolveDraft&&!bind&&!repair&&!busy&&!geometrySaving&&!sketchMove&&$('dimensionEditor').hidden){const p=point(e),hit=dimensionLabelHit(p),f=activeSketch();if(hit&&f){dimensionMove={id:hit.id,sketch:f.id,start:p,anchor:world(hit.x,hit.y),scale:scale2(),before:JSON.stringify(doc),moved:false,position:null};overlay.setPointerCapture(e.pointerId);overlay.style.cursor='grabbing';e.preventDefault();return}}return annotationDown(e)};
const annotationMove=overlay.onpointermove;overlay.onpointermove=e=>{if(dimensionMove){moveDimensionLabel(e);return}const result=annotationMove(e);if(mode==='2d'&&!tool&&!relationTool&&!busy&&!geometrySaving&&!sketchMove)overlay.style.cursor=dimensionLabelHit(point(e))?'grab':'default';return result};
const annotationUp=overlay.onpointerup;overlay.onpointerup=async e=>{if(!dimensionMove)return annotationUp(e);moveDimensionLabel(e);const m=dimensionMove;dimensionMove=null;overlay.style.cursor='default';if(JSON.stringify(doc)!==m.before||context?.id!==m.sketch){draw();return}const f=doc.features.find(x=>x.id===m.sketch),d=f?.dimensions?.find(x=>x.id===m.id);if(!d)return;if(!m.moved){openDimensionEditor(d);draw();return}if(m.position.every((v,i)=>Math.abs(v-d.position[i])<1e-9)){draw();return}history.push(m.before);if(history.length>60)history.shift();future=[];d.position=m.position;d.layout={mode:'manual'};syncDimensionLayout(JSON.parse(m.before));status('Maßdarstellung verschoben · Geometrie unverändert.');};
const annotationCancel=overlay.onpointercancel;overlay.onpointercancel=e=>{if(!cancelDimensionMove())return annotationCancel?.(e)};
const annotationLost=overlay.onlostpointercapture;overlay.onlostpointercapture=e=>{if(!cancelDimensionMove())return annotationLost?.(e)};
const annotationWheel=overlay.onwheel;overlay.onwheel=e=>{if(dimensionMove){e.preventDefault();return}return annotationWheel(e)};
const annotationEscape=escapeSketch;escapeSketch=async function(){if(cancelDimensionMove())return;return annotationEscape()};
const annotationUndo=undo;undo=async function(redo=false){cancelDimensionMove();const from=redo?future:history,to=redo?history:future;if(!from.length||busy||geometrySaving)return;const target=JSON.parse(from.at(-1));if(JSON.stringify(target)!==JSON.stringify(doc)&&dimensionLayoutKey(target)===dimensionLayoutKey(doc)){const before=structuredClone(doc);to.push(JSON.stringify(doc));from.pop();doc=target;closeDimensionEditor();syncDimensionLayout(before);status(redo?'Maßposition wiederhergestellt.':'Maßposition zurückgesetzt.');return}return annotationUndo(redo)};
for(const id of ['new','open','view3','view2','newSketch','editSketchTool','origins','undo','redo']){const previous=$(id).onclick;$(id).onclick=e=>{cancelDimensionMove();return previous(e)}}
const annotationEdit=editSketch;editSketch=async function(f){cancelDimensionMove();return annotationEdit(f)};
const annotationSelect=selectNode;selectNode=async function(f,kind){cancelDimensionMove();return annotationSelect(f,kind)};


async function deleteSelectedRelation(){
 const f=activeSketch(),id=selectedRelation;
 if(mode!=='2d'||busy||geometrySaving||!f||!id||!(f.relations||[]).some(r=>r.id===id))return false;
 const ok=await commitRelations(target=>{target.relations=target.relations.filter(r=>r.id!==id)});
 if(ok)status('Bedingung gelöscht · Rückgängig mit Strg+Z.');
 return ok;
}
window.addEventListener('keydown',e=>{
 const focus=document.activeElement;
 if(e.key!=='Delete'||e.repeat||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.defaultPrevented)return;
 if(['INPUT','TEXTAREA','SELECT'].includes(focus?.tagName)||focus?.isContentEditable)return;
 if(mode!=='2d'||!selectedRelation||busy||geometrySaving||tool||dimensionTool||relationTool||revolveDraft||dimensionMove||sketchMove)return;
 e.preventDefault();deleteSelectedRelation();
});

// Circular arcs use centre/diameter/start/signed sweep (angles in radians).
let arcDraft=[],arcCursor=null,radiusMode=false,closePicks=[];
function arcPoint(g,t){return [g.x+g.a/2*Math.cos(t),g.y+g.a/2*Math.sin(t)];}
function arcSegments(g){const count=Math.max(12,Math.ceil(Math.abs(g.sweep)*24));return Array.from({length:count},(_,i)=>[arcPoint(g,g.start+g.sweep*i/count),arcPoint(g,g.start+g.sweep*(i+1)/count)]);}
function circlePath(g){if(['ellipse','spline'].includes(g.type)){const ss=curveSegments(g);ctx.moveTo(...xy(...ss[0][0]));for(const [a,b] of ss)ctx.lineTo(...xy(...b));return;}if(g.type==='arc')ctx.arc(...xy(g.x,g.y),g.a*scale2()/2,-g.start,-g.start-g.sweep,g.sweep>0);else ctx.arc(...xy(g.x,g.y),g.a*scale2()/2,0,Math.PI*2);}
function arcThrough(a,m,b){
 const u=sub2(m,a),v=sub2(b,a),det=2*(u[0]*v[1]-u[1]*v[0]);if(Math.abs(det)<1e-7*Math.max(1,Math.hypot(...u)*Math.hypot(...v)))throw Error('Die drei Bogenpunkte dürfen nicht auf einer Geraden liegen.');
 const uu=u[0]**2+u[1]**2,vv=v[0]**2+v[1]**2,c=[a[0]+(uu*v[1]-vv*u[1])/det,a[1]+(u[0]*vv-v[0]*uu)/det],r=Math.hypot(...sub2(a,c));
 if(r<1e-5||r>5000)throw Error('Bogenradius außerhalb des Zeichenbereichs.');
 const start=Math.atan2(a[1]-c[1],a[0]-c[0]),end=Math.atan2(b[1]-c[1],b[0]-c[0]),mid=Math.atan2(m[1]-c[1],m[0]-c[0]),tau=2*Math.PI,positive=t=>(t%tau+tau)%tau;
 let sweep=positive(end-start);if(positive(mid-start)>sweep)sweep-=tau;if(Math.abs(sweep)<1e-5||Math.abs(sweep)>tau-1e-5)throw Error('Bogen braucht zwei verschiedene Endpunkte.');
 return {id:uid(),type:'arc',x:c[0],y:c[1],a:2*r,start,sweep};
}
function openEndpoints(f){
 if(f?.shape!=='multi')return [];const endpoints=[];
 for(const g of f.geometry.filter(g=>!g.construction)){
  const roles=g.type==='arc'||g.type==='ellipse'&&!curveClosed(g)?['start','end']:['polyline','spline'].includes(g.type)&&!g.closed?[g.points[0].id,g.points.at(-1).id]:[];
  for(const role of roles)endpoints.push({ref:{kind:'point',element:g.id,role},point:mPoints(g)[role]});
 }
 return endpoints.filter(p=>endpoints.filter(q=>Math.hypot(...sub2(p.point,q.point))<1e-6).length===1);
}
const arcReset=multiReset;multiReset=function(){arcDraft=[];arcCursor=null;closePicks=[];radiusMode=false;return arcReset();};
const arcSelectDrawing=selectDrawingTool;selectDrawingTool=async function(kind){if(arcDraft.length&&kind!=='arc'){arcDraft=[];arcCursor=null;}closePicks=[];radiusMode=false;return arcSelectDrawing(kind);};
$('arc').onclick=async()=>{await selectDrawingTool('arc');if(tool==='arc')status('Kreisbogen: Startpunkt, Punkt auf dem Bogen, Endpunkt anklicken. Endpunkte rasten ein.');};
$('closeProfile').onclick=async()=>{if(polyDraft.length&&!(await finishPolyline(false)))return;const f=cur();if(!f||isTreatment(f)||!(await editSketch(f)))return;clearRelationsUI();dimensionTool=false;tool='close-profile';closePicks=[];render();status('Zwei rot markierte offene Endpunkte wählen. Eine gebundene Verbindungslinie schließt die Lücke.');};
const arcDimensionStart=startDimension;startDimension=async function(){radiusMode=false;return arcDimensionStart();};$('dimension').onclick=startDimension;
$('radiusDimension').onclick=async()=>{await startDimension();if(dimensionTool){radiusMode=true;status('Kreis oder Bogen wählen, dann die Radiusmaßlinie platzieren.');}};
const arcMakeDimension=makeDimension;makeDimension=function(position){if(radiusMode&&dimensionPicks[0]?.kind!=='circle')throw Error('Für ein Radiusmaß einen Kreis oder Kreisbogen auswählen.');return arcMakeDimension(position);};
const arcDrawDimension=drawDimension;drawDimension=function(d,f,preview=false){
 if(d.kind!=='radius')return arcDrawDimension(d,f,preview);const g=f.geometry.find(g=>g.id===d.element);if(!g)return;
 const pos=xy(...d.position),c=xy(g.x,g.y),delta=sub2(d.position,[g.x,g.y]);let t=Math.atan2(delta[1],delta[0]);
 if(g.type==='arc'){const tau=2*Math.PI,along=((t-g.start)*Math.sign(g.sweep)%tau+tau)%tau;if(along>Math.abs(g.sweep))t=g.start+g.sweep/2;}
 const p=xy(...arcPoint(g,t)),color=preview?'#fff0b8':'#f4cb83';line(c,p,color);arrow(p,c,color);line(p,pos,color);measureLabel(d,pos,color,preview);
};
const arcDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{
 if(busy||geometrySaving)return;if(mode==='2d'&&e.button===0&&!e.shiftKey&&tool==='arc'){
  e.preventDefault();const p=snapPoint(point(e));if(arcDraft.some(q=>Math.hypot(...sub2(q.p,p.p))<1e-6))return;arcDraft.push(p);
  if(arcDraft.length===3){try{const g=arcThrough(...arcDraft.map(q=>q.p));g.snaps={start:arcDraft[0].snap,end:arcDraft[2].snap};if(await commitGeometry(g)){arcDraft=[];arcCursor=null;render();status('Bogen erstellt. Mit Linien und weiteren Bögen eine Kontur schließen.');}else arcDraft.pop();}catch(error){arcDraft.pop();status(error.message,true);}}else{status(arcDraft.length===1?'Punkt auf dem Bogen wählen.':'Endpunkt wählen.');draw();}return;
 }
 if(mode==='2d'&&e.button===0&&!e.shiftKey&&tool==='close-profile'){
  const p=point(e),end=openEndpoints(activeSketch()).map(t=>({...t,d:Math.hypot(...sub2(p,xy(...t.point)))})).sort((a,b)=>a.d-b.d)[0];if(!end||end.d>10)return;
  if(closePicks.some(r=>SAME(r.ref,end.ref)))return;closePicks.push(end);
  if(closePicks.length===2){const g={id:uid(),type:'polyline',closed:false,points:closePicks.map(t=>({id:uid(),x:t.point[0],y:t.point[1],snap:t.ref}))};if(await commitGeometry(g)){closePicks=[];render();status('Verbindung erstellt. Weitere offene Enden schließen oder Esc.');}else closePicks=[];}draw();return;
 }
 return arcDown(e);
};
const arcMove=overlay.onpointermove;overlay.onpointermove=e=>{if(mode==='2d'&&tool==='arc'&&!drag){arcCursor=snapPoint(point(e)).p;draw();return;}return arcMove(e);};
const arcUp=overlay.onpointerup;overlay.onpointerup=e=>{if(tool==='arc'||tool==='close-profile')return;return arcUp(e);};
const arcDraw2=draw2;draw2=function(){arcDraw2();if(mode!=='2d')return;
 if(tool==='arc'&&arcDraft.length){ctx.setLineDash([5,4]);if(arcDraft.length===2&&arcCursor){try{const g=arcThrough(arcDraft[0].p,arcDraft[1].p,arcCursor);ctx.beginPath();circlePath(g);ctx.strokeStyle='#ffcf80';ctx.lineWidth=2;ctx.stroke();}catch{line(xy(...arcDraft[0].p),xy(...arcCursor),'#ffcf80',1);}}else if(arcCursor)line(xy(...arcDraft[0].p),xy(...arcCursor),'#ffcf80',1);ctx.setLineDash([]);}
 for(const t of openEndpoints(activeSketch())){ctx.beginPath();ctx.arc(...xy(...t.point),5,0,Math.PI*2);ctx.strokeStyle=closePicks.some(p=>SAME(p.ref,t.ref))?'#ffe596':'#f08f79';ctx.lineWidth=1.5;ctx.stroke();}
};
const arcEscape=escapeSketch;escapeSketch=async function(){if(tool==='arc'||tool==='close-profile'){arcDraft=[];arcCursor=null;closePicks=[];tool=null;render();return;}return arcEscape();};
const arcApply=applyFeature;applyFeature=async function(op){if(arcDraft.length){status('Bogen zuerst fertig zeichnen oder mit Esc abbrechen.',true);return;}return arcApply(op);};
const arcRender=render;render=function(){arcRender();$('arc').disabled=$('polyline').disabled;$('arc').classList.toggle('active',tool==='arc');$('radiusDimension').disabled=$('dimension').disabled;$('closeProfile').disabled=busy||geometrySaving||!cur()||isTreatment(cur());$('closeProfile').classList.toggle('active',tool==='close-profile');};

// Exact parametric curves; tessellation is used only for interaction and display.
let curveDraft=[],curveCursor=null,trimHover=null;
const curveTools=['ellipse','spline','trim'];
function ellipsePoint(g,t){const a=g.angle||0,x=g.a/2*Math.cos(t),y=g.b/2*Math.sin(t);return[g.x+x*Math.cos(a)-y*Math.sin(a),g.y+x*Math.sin(a)+y*Math.cos(a)];}
function curveClosed(g){return g.type==='circle'||g.type==='ellipse'&&Math.abs(g.sweep)>=2*Math.PI-1e-5;}
function curvePoint(g,t){if(g.type==='spline'){let ps=g.points.map(p=>[p.x,p.y]);while(ps.length>1)ps=ps.slice(0,-1).map((p,i)=>p.map((v,j)=>(1-t)*v+t*ps[i+1][j]));return ps[0];}if(g.type==='ellipse')return ellipsePoint(g,g.start+g.sweep*t);if(g.type==='circle'||g.type==='arc')return arcPoint(g,(g.start||0)+(g.sweep||2*Math.PI)*t);return g.points[0].map((x,i)=>x+t*(g.points[1][i]-x));}
function curveSegments(g,count=96){return Array.from({length:count},(_,i)=>[curvePoint(g,i/count),curvePoint(g,(i+1)/count)]);}
function curvePrimitives(f){const out=[];for(const g of f.geometry||[]){if(['circle','arc','ellipse','spline'].includes(g.type))out.push({g,source:g.id});else for(const [role,points] of Object.entries(mSegments(g)))out.push({g:{type:'line',points},source:g.id,role});}return out;}
function nearestCurve(screen){let best=null;for(const c of curvePrimitives(activeSketch()||{})){const ss=curveSegments(c.g,c.g.type==='line'?1:96);for(let i=0;i<ss.length;i++){const a=xy(...ss[i][0]),b=xy(...ss[i][1]),v=sub2(b,a),l=v[0]**2+v[1]**2,t=Math.max(0,Math.min(1,l?((screen[0]-a[0])*v[0]+(screen[1]-a[1])*v[1])/l:0)),d=Math.hypot(screen[0]-a[0]-t*v[0],screen[1]-a[1]-t*v[1]);if(!best||d<best.d)best={...c,t:(i+t)/ss.length,d};}}return best?.d<10?best:null;}
function curveIntersections(a,b){
 const na=a.type==='line'?1:96,nb=b.type==='line'?1:96,A=curveSegments(a,na),B=curveSegments(b,nb),out=[],cross=(u,v)=>u[0]*v[1]-u[1]*v[0];
 for(let i=0;i<na;i++)for(let j=0;j<nb;j++){
  const p=A[i][0],q=B[j][0],u=sub2(A[i][1],p),v=sub2(B[j][1],q),det=cross(u,v);if(Math.abs(det)<1e-12)continue;
  const d=sub2(q,p),ta=cross(d,v)/det,tb=cross(d,u)/det;if(ta<-.001||ta>1.001||tb<-.001||tb>1.001)continue;
  let t=(i+ta)/na,s=(j+tb)/nb;
  for(let k=0;k<12;k++){const pa=curvePoint(a,t),pb=curvePoint(b,s),r=sub2(pb,pa),h=1e-6,da=sub2(curvePoint(a,t+h),curvePoint(a,t-h)).map(x=>x/(2*h)),db=sub2(curvePoint(b,s+h),curvePoint(b,s-h)).map(x=>x/(2*h)),dd=cross(da,db);if(Math.abs(dd)<1e-12)break;t+=cross(r,db)/dd;s+=cross(r,da)/dd;if(Math.hypot(...r)<1e-9)break;}
  if(t>=-1e-8&&t<=1+1e-8&&s>=-1e-8&&s<=1+1e-8&&Math.hypot(...sub2(curvePoint(a,t),curvePoint(b,s)))<1e-7&&!out.some(x=>Math.abs(x-t)<1e-7))out.push(Math.max(0,Math.min(1,t)));
 }return out.sort((a,b)=>a-b);
}
function splitBezier(ps,t){const left=[ps[0]],right=[ps.at(-1)];while(ps.length>1){ps=ps.slice(0,-1).map((p,i)=>p.map((v,j)=>(1-t)*v+t*ps[i+1][j]));left.push(ps[0]);right.unshift(ps.at(-1));}return[left,right];}
function curveSlice(g,lo,hi,id=uid()){
 if(g.type==='line')return{id,type:'polyline',closed:false,points:[curvePoint(g,lo),curvePoint(g,hi)].map(p=>({id:uid(),x:p[0],y:p[1]}))};
 if(g.type==='spline'){let ps=g.points.map(p=>[p.x,p.y]);if(hi<1)ps=splitBezier(ps,hi)[0];if(lo>0)ps=splitBezier(ps,lo/hi)[1];return {...structuredClone(g),id,points:ps.map(p=>({id:uid(),x:p[0],y:p[1]}))};}
 return{...structuredClone(g),id,type:g.type==='circle'?'arc':g.type,start:(g.start||0)+(g.sweep||2*Math.PI)*lo,sweep:(g.sweep||2*Math.PI)*(hi-lo)};
}
function trimPieces(hit,f){
 const original=f.geometry.find(g=>g.id===hit.source);if(!original)throw Error('Element fehlt.');
 // Never silently remove dimensions or constraint references while changing topology.
 const references=x=>x&&typeof x==='object'&&(x.element===original.id||Object.values(x).some(references));
 if((f.dimensions||[]).some(references)||(f.relations||[]).some(references))throw Error('Dieses Element ist bemaßt oder gebunden. Zugehörige Maße/Bedingungen vor dem Trimmen lösen.');
 let cuts=[];for(const other of curvePrimitives(f)){if(other.source===hit.source&&other.role===hit.role)continue;cuts.push(...curveIntersections(hit.g,other.g));}
 cuts=cuts.sort((a,b)=>a-b).filter((x,i,a)=>!i||x-a[i-1]>1e-7);
 const closed=curveClosed(hit.g);let spans=[];
 if(closed){cuts=cuts.map(t=>t>=1-1e-7?0:t).sort((a,b)=>a-b).filter((x,i,a)=>!i||x-a[i-1]>1e-7);if(cuts.length<2)throw Error('Zum Trimmen einer geschlossenen Kurve sind zwei Schnittpunkte nötig.');let before=cuts.filter(t=>t<hit.t).at(-1)??cuts.at(-1)-1,after=cuts.find(t=>t>hit.t)??cuts[0]+1;spans=[[after,before+1]];}
 else {cuts=cuts.filter(t=>t>1e-7&&t<1-1e-7);if(!cuts.length)throw Error('Kein schneidender Schnittpunkt gefunden. Zum Entfernen das Element löschen.');const lo=cuts.filter(t=>t<hit.t).at(-1)??0,hi=cuts.find(t=>t>hit.t)??1;if(lo>1e-7)spans.push([0,lo]);if(hi<1-1e-7)spans.push([hi,1]);}
 const pieces=spans.map(([a,b])=>curveSlice(hit.g,a,b));
 if(['polyline','rect'].includes(original.type)){for(const [role,ps] of Object.entries(mSegments(original)))if(role!==hit.role)pieces.push(curveSlice({type:'line',points:ps},0,1));}
 pieces.forEach((g,i)=>{g.construction=!!original.construction;if(i===0)g.id=original.id;});return pieces;
}
async function trimAt(hit){if(!hit)return;try{const pieces=trimPieces(hit,activeSketch());if(await commitRelations(f=>{const i=f.geometry.findIndex(g=>g.id===hit.source);f.geometry.splice(i,1,...pieces);})){trimHover=null;render();status('Abschnitt entfernt · Weitere Abschnitte anklicken · Strg+Z macht rückgängig.');}}catch(e){status(e.message,true);}}
function ellipseDraft(points){const [c,a,b]=points,u=sub2(a,c),r=Math.hypot(...u);if(r<1e-4)throw Error('Erste Halbachse ist zu kurz.');const v=sub2(b,c),rb=Math.abs((u[0]*v[1]-u[1]*v[0])/r);if(rb<1e-4)throw Error('Zweite Halbachse ist zu kurz.');return{id:uid(),type:'ellipse',x:c[0],y:c[1],a:2*r,b:2*rb,angle:Math.atan2(u[1],u[0]),start:0,sweep:2*Math.PI};}
for(const kind of curveTools)$(kind).onclick=async()=>{await selectDrawingTool(kind);curveDraft=[];curveCursor=null;status(kind==='ellipse'?'Ellipse: Mittelpunkt → erste Halbachse → zweite Halbachse.':kind==='spline'?'Spline: Startpunkt → erster Kontrollpunkt → zweiter Kontrollpunkt → Endpunkt.':'Trimmen: Abschnitt zwischen schneidenden Kurven anklicken. Gebundene Elemente zuerst lösen.');};
const curveDown=overlay.onpointerdown;overlay.onpointerdown=async e=>{if(busy||geometrySaving)return;if(mode==='2d'&&e.button===0&&!e.shiftKey&&curveTools.includes(tool)){e.preventDefault();if(tool==='trim'){await trimAt(nearestCurve(point(e)));return;}const q=snapPoint(point(e));curveDraft.push(q);const count=tool==='ellipse'?3:4;if(curveDraft.length===count){try{const g=tool==='ellipse'?ellipseDraft(curveDraft.map(q=>q.p)):{id:uid(),type:'spline',closed:false,points:curveDraft.map(q=>({id:uid(),x:q.p[0],y:q.p[1],...(q.snap?{snap:q.snap}:{})}))};if(await commitGeometry(g)){curveDraft=[];curveCursor=null;render();status('Kurve erstellt · Weitere zeichnen oder Esc.');}else curveDraft.pop();}catch(error){curveDraft.pop();status(error.message,true);}}draw();return;}return curveDown(e);};
const curveMove=overlay.onpointermove;overlay.onpointermove=e=>{if(mode==='2d'&&curveTools.includes(tool)&&!drag){if(tool==='trim')trimHover=nearestCurve(point(e));else curveCursor=snapPoint(point(e)).p;draw();return;}return curveMove(e);};
const curveUp=overlay.onpointerup;overlay.onpointerup=e=>{if(curveTools.includes(tool))return;return curveUp(e);};
const curveDraw=draw2;draw2=function(){curveDraw();if(mode!=='2d')return;const f=activeSketch();if(f?.shape==='multi')for(const g of f.geometry.filter(g=>g.type==='spline'&&(activeElement===g.id||!tool))){ctx.setLineDash([3,5]);for(let i=1;i<4;i++)line(xy(g.points[i-1].x,g.points[i-1].y),xy(g.points[i].x,g.points[i].y),'#748491',.7);ctx.setLineDash([]);}
 if(curveDraft.length){const ps=curveDraft.map(q=>q.p);if(curveCursor)ps.push(curveCursor);ctx.setLineDash([5,4]);for(let i=1;i<ps.length;i++)line(xy(...ps[i-1]),xy(...ps[i]),'#9daaba',1);let g=null;try{if(tool==='ellipse'&&ps.length===3)g=ellipseDraft(ps);if(tool==='spline'&&ps.length===4)g={type:'spline',points:ps.map(p=>({x:p[0],y:p[1]}))};}catch{}if(g)for(const [a,b] of curveSegments(g))line(xy(...a),xy(...b),'#ffcf80',2);ctx.setLineDash([]);}
 if(tool==='trim'&&trimHover){for(const [a,b] of curveSegments(trimHover.g))line(xy(...a),xy(...b),'#ff987e',2.5);}
};
const curveRender=render;render=function(){curveRender();for(const k of curveTools){$(k).disabled=k==='trim'?!activeSketch()||busy||geometrySaving:$('polyline').disabled;$(k).classList.toggle('active',tool===k);}};
const curveReset=multiReset;multiReset=function(){curveDraft=[];curveCursor=null;trimHover=null;return curveReset();};
const curveSelect=selectDrawingTool;selectDrawingTool=async function(k){curveDraft=[];curveCursor=null;trimHover=null;return curveSelect(k);};
const curveEscape=escapeSketch;escapeSketch=async function(){if(curveTools.includes(tool)){curveDraft=[];curveCursor=null;trimHover=null;tool=null;render();return;}return curveEscape();};
const curveApply=applyFeature;applyFeature=async function(op){if(curveDraft.length){status('Kurve zuerst fertig zeichnen oder mit Esc abbrechen.',true);return;}return curveApply(op);};
const curveHitGeometry=hitGeometry;hitGeometry=function(p){const ref=curveHitGeometry(p);return dimensionTool&&ref?.kind==='curve'?null:ref;};

const curveTargets=geometryTargets;geometryTargets=function(){const out=curveTargets();for(const g of activeSketch()?.geometry||[])if(['ellipse','spline'].includes(g.type))out.push({ref:{kind:'curve',element:g.id},pickSegments:curveSegments(g)});return out;};
const curveHighlight=highlightRelationRef;highlightRelationRef=function(ref,f,color='#ffce78'){const g=f.geometry?.find(g=>g.id===ref.element);if(g&&['ellipse','spline'].includes(g.type)&&['curve','geometry'].includes(ref.kind)){for(const [a,b] of curveSegments(g))line(xy(...a),xy(...b),color,3);return;}return curveHighlight(ref,f,color);};

const curveMainDraw=draw;draw=function(){curveMainDraw();if(mode==='2d'&&curveTools.includes(tool))$('help').textContent=tool==='ellipse'?'Mittelpunkt → erste Halbachse → zweite Halbachse · Esc: abbrechen':tool==='spline'?'Start → Kontrollpunkt 1 → Kontrollpunkt 2 → Ende · Kontrollpunkte später ziehen · Esc: abbrechen':'Abschnitt zwischen Schnittpunkten anklicken · Gebundene Elemente zuerst lösen · Strg+Z: rückgängig';};

// Helices are independent reference features; profiles keep their helix by ID.
let helixDraft=null,sweepDraft=null;
function isHelix(f){return f?.op==='helix';}
function isSweep(f){return ['sweep','sweep-pocket'].includes(f?.op);}
function pendingProfile(){return polyDraft.length||constructionDraft.length||arcDraft.length||curveDraft.length;}
async function beginHelix(existing=null){if(busy||geometrySaving)return;if(pendingProfile()){status('Bitte den aktuellen Zeichenentwurf abschließen oder abbrechen.',true);return;}if(dirty&&!(await update()))return;cancelSketchMove();clearRelationsUI();dimensionTool=false;closeDimensionEditor();multiReset();context=null;tool=null;mode='3d';sweepDraft=null;helixDraft={editing:existing?.id||null,...structuredClone(existing||{id:uid(),name:'Helix',op:'helix',axis:'Z',origin:[0,0,0],radius:5,pitch:2,height:10,phase:0,leftHand:false,reverse:false})};render();}
function draftField(label,id,value,change){const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.id=id;input.type='text';input.value=String(value);input.oninput=()=>change(input.value);l.append(input);$('edit').append(l);return input;}
function draftSelect(label,id,options,value,change){const l=document.createElement('label');l.textContent=label;const s=document.createElement('select');s.id=id;for(const [v,text] of options){const o=document.createElement('option');o.value=v;o.textContent=text;s.append(o)}s.value=value;s.onchange=()=>change(s.value);l.append(s);$('edit').append(l);return s;}
function draftCheck(label,id,value,change){const l=document.createElement('label'),c=document.createElement('input');c.id=id;c.type='checkbox';c.style.width='auto';c.checked=!!value;c.onchange=()=>change(c.checked);l.append(c,document.createTextNode(label));$('edit').append(l);}
function helixPanel(){const d=helixDraft;$('edit').replaceChildren();note(d.editing?'Helix bearbeiten':'Neue Helix');draftSelect('Achse','helixAxis',[['X','X'],['Y','Y'],['Z','Z']],d.axis,v=>d.axis=v);for(const [k,label] of [['radius','Pfadradius (mm)'],['pitch','Steigung pro Umdrehung (mm)'],['height','Axiale Höhe (mm)'],['phase','Startwinkel (°)']])draftField(label,'helix_'+k,d[k],v=>d[k]=v);for(let i=0;i<3;i++)draftField('Achsenursprung '+['X','Y','Z'][i]+' (mm)','helix_origin'+i,d.origin[i],v=>d.origin[i]=v);draftCheck('Linksgewinde','helixLeft',d.leftHand,v=>d.leftHand=v);draftCheck('Negative Achsrichtung','helixReverse',d.reverse,v=>d.reverse=v);note('Windungszahl = Höhe / Steigung. Die Höhe beschreibt den Pfad; das Profil kann an beiden Enden darüber hinausragen.');button('Helix übernehmen',commitHelix);button('Abbrechen',()=>{helixDraft=null;render()});}
async function commitHelix(){if(!helixDraft||busy||geometrySaving)return;const d=structuredClone(helixDraft);try{for(const k of ['radius','pitch','height','phase'])d[k]=calculateMeasure(String(d[k]));d.origin=d.origin.map(x=>calculateMeasure(String(x)));const candidate=structuredClone(doc),editing=d.editing;delete d.editing;if(editing)candidate.features[candidate.features.findIndex(f=>f.id===editing)]=d;else candidate.features.push(d);if(await commitHelixDocument(candidate,d.id)){helixDraft=null;selectedKind='feature';originVisible=false;fit();render();status('Helix erstellt · „Profil auf Helix zeichnen“ wählen.');}}catch(e){status(e.message,true);}}
async function commitHelixDocument(candidate,id){const before=JSON.stringify(doc);busy=true;geometrySaving=true;try{const result=await(await request('/build',JSON.stringify(candidate))).json();if(JSON.stringify(doc)!==before)throw Error('Modell wurde zwischenzeitlich geändert.');context=null;mode='3d';tool=null;selected=id;mutate(()=>doc=candidate);acceptBuiltResult(result);return true;}catch(e){status(e.message,true);return false;}finally{busy=false;geometrySaving=false;render();}}
function helixProperties(f){note(f.name||'Helix');note('Achse '+f.axis+' · Radius '+f.radius+' mm · Steigung '+f.pitch+' mm');note('Höhe '+f.height+' mm · '+Number((f.height/f.pitch).toFixed(3))+' Windungen · '+(f.leftHand?'Linksgewinde':'Rechtsgewinde'));button('Helixparameter bearbeiten',()=>beginHelix(f));button('Profil auf Helix zeichnen',()=>newHelixProfile(f));button('Dreieckprofil als Start erstellen',()=>newHelixProfile(f,true));button('Helix löschen',async()=>{const users=doc.features.filter(x=>x.support?.helix===f.id||x.path===f.id);if(users.length){status('Zuerst die zugehörigen Sweep-/Profilskizzen löschen.',true);return;}const candidate=structuredClone(doc);candidate.features=candidate.features.filter(x=>x.id!==f.id);await commitHelixDocument(candidate,null);}).className='danger';}
async function newHelixProfile(h,triangle=false){if(busy||geometrySaving)return;if(dirty&&!(await update()))return;const l=layout(h);if(!l)return;multiReset();clearRelationsUI();dimensionTool=false;closeDimensionEditor();edgeTool=null;selected=null;selectedFace=null;plane=null;context={id:null,support:{helix:h.id},info:l};selectedKind='sketch';mode='2d';originVisible=false;tool='polyline';fit();render();if(triangle){const depth=.5*h.pitch,half=depth/Math.sqrt(3),g={id:uid(),type:'polyline',closed:true,points:[[-depth/2,0],[depth/2,-half],[depth/2,half]].map(([x,y])=>({id:uid(),x,y}))};if(await commitGeometry(g)){tool=null;render();}}status('Helixprofil: X radial nach außen, Y axial. Profilhöhe kleiner als Steigung. Danach Sweep + oder Sweep − wählen.');}
async function beginSweep(op){if(busy||geometrySaving)return;const f=cur();if(!f||isHelix(f)||isTreatment(f))return;if(pendingProfile()){status('Profil zuerst fertig zeichnen.',true);return;}const i=doc.features.indexOf(f),paths=doc.features.slice(0,i).filter(isHelix);if(!paths.length){status('Zuerst eine Helix und anschließend deren Profilskizze erstellen.',true);return;}clearRelationsUI();dimensionTool=false;closeDimensionEditor();tool=null;helixDraft=null;sweepDraft={id:f.id,op,path:f.path||f.support?.helix||paths.at(-1).id};render();status('Helix wählen und Sweep übernehmen.');}
function sweepPanel(){const d=sweepDraft,f=cur();if(!f||f.id!==d.id){sweepDraft=null;return;}$('edit').replaceChildren();note(d.op==='sweep'?'Helix-Sweep · Material hinzufügen':'Helix-Sweep · Material abtragen');const paths=doc.features.slice(0,doc.features.indexOf(f)).filter(isHelix);draftSelect('Helix','sweepPath',paths.map(h=>[h.id,(h.name||'Helix')+' · R '+h.radius+' · P '+h.pitch]),d.path,v=>d.path=v);note('Lokale Profilkoordinaten: X radial ab Pfadradius, Y axial ab Pfadstart. Die Ausrichtung folgt der Helix ohne zusätzliche Verdrehung.');note('Eine geschlossene Kontur; Profilhöhe kleiner als Steigung. Anfang und Ende bleiben zunächst gerade abgeschnitten, ohne Gewindeauslauf.');if(f.support?.helix!==d.path)note('Das Profil wird mit seinen lokalen Koordinaten auf die Helixauflage versetzt.');button('Sweep übernehmen',commitSweep);button('Abbrechen',()=>{sweepDraft=null;render()});}
async function commitSweep(){if(!sweepDraft||busy||geometrySaving)return;const d=structuredClone(sweepDraft),candidate=structuredClone(doc),f=candidate.features.find(x=>x.id===d.id);try{if(f.support?.helix!==d.path){const external=x=>x&&typeof x==='object'&&(x.external||String(x.kind).startsWith('support-')||Object.values(x).some(external));if((f.dimensions||[]).some(external)||(f.relations||[]).some(external)||f.rx||f.ry)throw Error('Vor dem Versetzen auf die Helix externe Maße/Bedingungen lösen.');}multiConvert(f);f.support={helix:d.path};f.path=d.path;f.op=d.op;f.reverse=false;f.symmetric=false;if(await commitHelixDocument(candidate,f.id)){sweepDraft=null;selectedKind='feature';originVisible=false;collapsedNodes.delete(f.id);fit();render();status('Helix-Sweep erstellt. Profil und Helix bleiben parametrisch verbunden.');}}catch(e){status(e.message,true);}}
$('helixTool').onclick=()=>beginHelix();$('sweepTool').onclick=()=>beginSweep('sweep');$('sweepPocketTool').onclick=()=>beginSweep('sweep-pocket');
const helixRender=render;render=function(){helixRender();const f=cur();$('helixTool').disabled=busy||geometrySaving;for(const id of ['sweepTool','sweepPocketTool'])$(id).disabled=busy||geometrySaving||!f||isHelix(f)||isTreatment(f)||(id==='sweepPocketTool'&&!mesh?.vertices.length);if(isHelix(f)){for(const id of ['editSketchTool','dimension','radiusDimension','angleDimension','padTool','pocketTool','revolveTool','revolvePocketTool','closeProfile'])$(id).disabled=true;}if(helixDraft)helixPanel();else if(sweepDraft)sweepPanel();else if(isSweep(f)&&selectedKind==='feature')button('Sweep / Helixzuordnung bearbeiten',()=>beginSweep(f.op));};
const helixEdit=editSketch;editSketch=async function(f){if(isHelix(f)){await newHelixProfile(f);return false;}return helixEdit(f);};
const helixNew=newSketch;newSketch=async function(){if(isHelix(cur()))return newHelixProfile(cur());return helixNew();};$('newSketch').onclick=newSketch;
const helixReset=multiReset;multiReset=function(){helixDraft=null;sweepDraft=null;return helixReset();};
const helixEscape=escapeSketch;escapeSketch=async function(){if(helixDraft||sweepDraft){helixDraft=null;sweepDraft=null;render();return;}return helixEscape();};
const helixSelect=selectNode;selectNode=async function(f,k){helixDraft=null;sweepDraft=null;return helixSelect(f,k);};
const helixBound=bound3;bound3=function(){if(!mesh)return helixBound();const ps=(mesh.layouts||[]).filter(l=>l.helix).flatMap(l=>l.points);if(!ps.length)return helixBound();const b=mesh.vertices?.length?[...mesh.bounds]:[Infinity,-Infinity,Infinity,-Infinity,Infinity,-Infinity];for(const p of ps)for(let i=0;i<3;i++){b[2*i]=Math.min(b[2*i],p[i]);b[2*i+1]=Math.max(b[2*i+1],p[i]);}return b;};

$('assemblyWorkspace').onclick=()=>window.open('/assembly','_blank','noopener');
new ResizeObserver(()=>{const r=$('stage').getBoundingClientRect();W=r.width;H=r.height;DPR=Math.min(devicePixelRatio||1,2);for(const c of [overlay,glCanvas]){c.width=Math.round(W*DPR);c.height=Math.round(H*DPR)}ctx.setTransform(DPR,0,0,DPR,0,0);ctx.font='12px system-ui';draw()}).observe($('stage'));
// Assembly editing uses a separate tab and an explicit, validated hand-off.
const assemblyEditToken=new URLSearchParams(location.hash.slice(1)).get('assembly-edit');
let assemblyEditLoaded=false,assemblyEditInvalid=false,assemblyApplyPending=null,assemblyBridgeLoading=false;
function assemblyNotice(text,error=false){$('assemblyEditMessage').textContent=text;$('assemblyEditMessage').style.color=error?'#ffad98':'#9cdecf'}
function sendAssemblyMessage(type,data={}){if(!window.opener||window.opener.closed){assemblyNotice('Die Baugruppe ist geschlossen. Bearbeitung bitte als JSON speichern.',true);return false}window.opener.postMessage({channel:'metriccad-part-edit',token:assemblyEditToken,type,...data},location.origin);return true}
async function loadAssemblyPart(m){if(busy||geometrySaving||assemblyBridgeLoading||assemblyApplyPending){assemblyNotice('Part Design ist beschäftigt. Anschließend „Teil neu laden“ wählen.',true);return}assemblyBridgeLoading=true;$('assemblyApply').disabled=true;try{const r=await request('/build',JSON.stringify(m.document)),result=await r.json();doc=result.document;mesh=result;history=[];future=[];selected=selectedFace=context=tool=bind=repair=null;plane=null;mode='3d';dirty=false;lastError='';originVisible=false;waitingPlane=false;edgeTool=null;edgeSelection=[];dimensionTool=false;dimensionPicks=[];closeDimensionEditor();clearRelationsUI();multiReset();collapsedNodes.clear();assemblyEditLoaded=true;assemblyEditInvalid=false;document.title='MetricCAD · '+(m.name||'Baugruppenteil');$('assemblyEditName').textContent=m.name||'Baugruppenteil';fit();render();assemblyNotice('Verknüpft mit '+m.instances+' Instanz(en). „In Baugruppe übernehmen“ aktualisiert alle.');}catch(e){assemblyNotice(e.message,true)}finally{assemblyBridgeLoading=false;$('assemblyApply').disabled=!assemblyEditLoaded||assemblyEditInvalid;}}
async function applyAssemblyPart(){if(!assemblyEditLoaded||assemblyEditInvalid||assemblyApplyPending||assemblyBridgeLoading)return;if(busy||geometrySaving||sketchMove||dimensionMove||polyDraft.length||constructionDraft.length){assemblyNotice('Bitte die laufende Skizzenbearbeitung abschließen und erneut übernehmen.',true);return}if(!(await update())){assemblyNotice('Teil konnte nicht berechnet werden. Bitte Fehler korrigieren.',true);return}const snapshot=JSON.stringify(doc),requestID=uid();assemblyApplyPending={id:requestID,snapshot};$('assemblyApply').disabled=true;$('assemblyReload').disabled=true;assemblyNotice('Baugruppe und alle Referenzen werden geprüft …');if(!sendAssemblyMessage('apply',{request:requestID,document:JSON.parse(snapshot)})){assemblyApplyPending=null;$('assemblyApply').disabled=false;$('assemblyReload').disabled=false;}else setTimeout(()=>{if(assemblyApplyPending?.id!==requestID)return;assemblyApplyPending=null;$('assemblyApply').disabled=assemblyEditInvalid;$('assemblyReload').disabled=assemblyEditInvalid;assemblyNotice('Noch keine Bestätigung erhalten. Bitte den Baugruppentab prüfen; die Übernahme könnte noch laufen. Bearbeitung bei Bedarf als JSON sichern.',true)},60000);}
async function receiveAssemblyEdit(e){const m=e.data;if(!assemblyEditToken||e.origin!==location.origin||e.source!==window.opener||!m||m.channel!=='metriccad-part-edit'||m.token!==assemblyEditToken)return;if(m.type==='load'){await loadAssemblyPart(m);return}if(m.type==='invalid'){assemblyEditInvalid=true;assemblyApplyPending=null;$('assemblyApply').disabled=true;$('assemblyReload').disabled=true;assemblyNotice(m.error,true);return}if(m.type==='error'){assemblyNotice(m.error,true);return}if(m.type==='result'&&assemblyApplyPending?.id===m.request){const changed=JSON.stringify(doc)!==assemblyApplyPending.snapshot;assemblyApplyPending=null;$('assemblyApply').disabled=false;$('assemblyReload').disabled=false;assemblyNotice(m.ok?'Übernommen: '+m.instances+' Instanz(en).'+(changed?' Weitere Änderungen im Editor sind noch nicht übernommen.':''):m.error,!m.ok);}}
window.addEventListener('message',receiveAssemblyEdit);
if(assemblyEditToken){$('assemblyEditBar').hidden=false;$('assemblyApply').disabled=true;$('assemblyApply').onclick=applyAssemblyPart;$('assemblyReload').onclick=()=>{if(busy||geometrySaving||assemblyBridgeLoading||assemblyApplyPending)return;if(assemblyEditLoaded&&!confirm('Den aktuellen Stand aus der Baugruppe laden? Nicht übernommene Bearbeitungen dieses Tabs werden verworfen.'))return;sendAssemblyMessage('reload')};for(const id of ['new','open']){$(id).hidden=true;$(id).onclick=()=>assemblyNotice('Dieser Tab bearbeitet das verknüpfte Baugruppenteil. Andere Projekte bitte in einem separaten Part-Design-Tab öffnen.',true);}assemblyNotice('Teil wird aus der Baugruppe geladen …');sendAssemblyMessage('ready');}

render();
