'use strict';
const $=id=>document.getElementById(id);
const defaultSettings=()=>({samples:24,width:1280,environment:'studio'});
const emptyScene=()=>({format:'MetricCAD-visualizer',version:1,model:null,materials:{},overrides:{},lights:[],cameras:[],activeCamera:null,renderSettings:defaultSettings()});
let doc=emptyScene(), selection=null, bounds=null, view=null, rendering=false;
const activeCamera=()=>doc.cameras.find(c=>c.id===doc.activeCamera);
const validColor=s=>typeof s==='string' && /^#[0-9a-f]{6}$/i.test(s);
const inRange=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(x=>inRange(x,-1e9,1e9));
const baseMaterial=i=>({color:validColor(i.color)?i.color:'#bfc9ce',roughness:.5,metallic:0});
const lookup=(map,id)=>Object.hasOwn(map,id)?map[id]:undefined;
const material=i=>lookup(doc.overrides,i.id)||lookup(doc.materials,i.part)||baseMaterial(i);
const current=()=>({camera:activeCamera(),lights:doc.lights,environment:doc.renderSettings.environment,material});
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function select(type,id){selection={type,id};tree();properties();view?.draw();}
function validate(s){
    const mat=m=>m&&validColor(m.color)&&inRange(m.roughness,0,1)&&inRange(m.metallic,0,1)&&inRange(m.transmission??0,0,1);
    const entries=(arr,max,test)=>Array.isArray(arr)&&arr.length<=max&&new Set(arr.map(x=>x?.id)).size===arr.length&&
        arr.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&test(x));
    if(s?.format!=='MetricCAD-visualizer'||s.version!==1||
        !Number.isInteger(s.renderSettings?.samples)||!inRange(s.renderSettings.samples,1,1024)||
        ![640,1280,1920,3840].includes(s.renderSettings.width)||!['studio','room','none'].includes(s.renderSettings.environment)||
        ![s.materials,s.overrides].every(m=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.values(m).every(mat))||
        !entries(s.cameras,100,c=>vec(c.center)&&inRange(c.yaw,-1e6,1e6)&&inRange(c.pitch,-1.57,1.57)&&inRange(c.width,.01,1e9))||
        !entries(s.lights,8,l=>vec(l.position)&&(l.type==='point'||((l.type??'area')==='area'&&vec(l.target)))&&validColor(l.color)&&inRange(l.size,.1,1e7)&&inRange(l.power,0,1e7))||
        (s.model?!s.cameras.some(c=>c.id===s.activeCamera):s.cameras.length||s.lights.length))
        throw Error('Ungültige MetricCAD-Visualisierung.');
}
async function build(model){
    if(model?.format!=='MetricCAD-assembly'||!model.instances?.length)throw Error('Bitte eine Baugruppe mit Bauteilen wählen.');
    const r=await fetch('/assembly/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(model)});
    const data=await r.json();if(!r.ok)throw Error(data.error||'Baugruppe konnte nicht geladen werden.');
    if(!view){
        const response=await fetch('/visualizer/environments');
        if(!response.ok)throw Error('Umgebungen konnten nicht geladen werden.');
        view=sceneViewport($('view'),current,i=>select('part',i.id),()=>{if(selection?.type==='camera')properties();},await response.json());
    }
    return view.load(model,data);
}
function fit(c){c.center=[...bounds.center];c.width=bounds.diameter*2;}
function newLight(s,b,type='area'){
    const d=b.diameter;
    if(type==='point')return {type,id:crypto.randomUUID(),name:'Punktlicht '+(s.lights.length+1),
        position:b.center.map((v,i)=>i===2?v+b.height*.3:v),power:15,size:10,color:'#ffe7c2'};
    return {type,name:'Flächenlicht '+(s.lights.length+1),id:crypto.randomUUID(),target:[...b.center],
        position:b.center.map((v,i)=>v+[.6,-1,1][i]*d),size:Math.max(.1,d*.55),
        power:Math.max(1,Math.min(1e7,500*(d*.001)**2)),color:'#fff4e5'};
}
async function replace(value){
    const s=value??emptyScene();
    if(s.renderSettings===undefined)s.renderSettings=defaultSettings();
    if(s.renderSettings && s.renderSettings.environment===undefined){
        s.renderSettings.environment=s.renderSettings.mat===false?'none':'studio';
        delete s.renderSettings.mat;
    }
    validate(s);
    const next=s.model?await build(s.model):null;
    if(!s.model)view?.load(null,null);
    bounds=next;doc=s;resetUI();return true;
}
function resetUI(){
    selection=activeCamera()?{type:'camera',id:doc.activeCamera}:null;
    $('empty').hidden=!!doc.model;tree();properties();view?.draw();
    status(doc.model?'Ziehen zum Drehen · Mitteltaste zum Verschieben · Mausrad zum Zoomen':'Bereit.');
}
const files=bindProjectFiles({defaultName:'Visualisierung.metriccad.json',blocked:()=>rendering,replace});
async function chooseAssembly(){
    if(!window.showOpenFilePicker)throw Error('Für die Dateiauswahl bitte Chrome oder Edge verwenden.');
    const [handle]=await showOpenFilePicker({types:[{description:'MetricCAD-Baugruppe',accept:{'application/json':['.json']}}]});
    const file=await handle.getFile();return JSON.parse(await file.text());
}
$('source').onclick=()=>files.switchTo(async()=>{
    const model=await chooseAssembly(),b=await build(model),s=emptyScene();
    s.model=model;bounds=b;
    const c={id:crypto.randomUUID(),name:'Kamera 1',yaw:-1.04,pitch:.38};
    fit(c);s.cameras.push(c);s.activeCamera=c.id;s.lights.push(newLight(s,b));doc=s;resetUI();return true;
},true);
$('refresh').onclick=async()=>{
    document.body.inert=true;
    try{
        const model=await chooseAssembly();
        if(!model.instances?.some(i=>doc.model.instances.some(old=>i.id===old.id))&&
            !model.parts?.some(p=>doc.model.parts.some(old=>old.id===p.id)))
            throw Error('Keine übereinstimmenden Teil- oder Instanz-IDs.');
        bounds=await build(model);doc.model=model;
        for(const [map,items] of [[doc.materials,model.parts],[doc.overrides,model.instances]])
            for(const key of Object.keys(map))if(!items.some(i=>i.id===key))delete map[key];
        resetUI();status('Baugruppe aktualisiert.');
    }catch(e){if(e.name!=='AbortError')status(e.message,true);}
    finally{document.body.inert=false;}
};
function element(tag,text,parent){
    const el=document.createElement(tag);if(text!==null)el.textContent=text;parent.append(el);return el;
}
function tree(){
    const root=$('tree'), closed=new Set([...root.querySelectorAll('details:not([open])')].map(d=>d.dataset.group));
    root.replaceChildren();
    function group(key,name,list,type){
        const branch=element('details',null,root);branch.dataset.group=key;branch.open=!closed.has(key);
        element('summary',name,branch);
        const rows=element('div',null,branch);rows.className='tree-branch';
        for(const item of list){
            const btn=element('button',(type==='camera'&&item.id===doc.activeCamera?'● ':'')+(item.name||item.id),rows);
            btn.classList.toggle('active',selection?.id===item.id&&selection.type===type);
            btn.onclick=()=>{if(type==='camera')doc.activeCamera=item.id;select(type,item.id);};
            if(btn.classList.contains('active'))branch.open=true;
        }
    }
    if(doc.model){
        group('assembly',doc.model.name||'Baugruppe',doc.model.instances,'part');
        group('lights','Beleuchtung',doc.lights,'light');group('cameras','Kameras',doc.cameras,'camera');
    }
    for(const id of ['refresh','paint','lamp','pointLamp','renderOptions','camera','fit','render'])$(id).disabled=!doc.model||rendering;
    $('camera').disabled||=doc.cameras.length>=100;$('lamp').disabled||=doc.lights.length>=8;
    $('pointLamp').disabled=$('lamp').disabled;
}
function properties(){
    const panel=$('props');panel.replaceChildren();if(!selection)return;
    const {type,id}=selection;
    const item=(type==='part'?doc.model.instances:type==='light'?doc.lights:doc.cameras).find(i=>i.id===id);
    if(!item&&type!=='settings')return;
    element('h3',item?(item.name||item.id):'Rendereinstellungen',panel);
    function input(title,value,kind,change,range=null,parent=panel){
        const label=element('label',title,parent),el=element('input',null,label);
        el.type=kind;el.value=value;
        if(range){[el.min,el.max]=range;el.step='any';}
        el.onchange=()=>{
            const v=kind==='number'?el.valueAsNumber:el.value;
            if(range&&!inRange(v,...range)){el.value=value;return;}
            change(v);view.draw();tree();properties();
        };
    }
    function coords(label,key){
        element('div',label,panel);const row=element('div',null,panel);row.className='coords';
        item[key].forEach((v,i)=>input('XYZ'[i],v,'number',n=>item[key][i]=n,[-1e9,1e9],row));
    }
    const button=(label,action)=>{element('button',label,panel).onclick=action;};
    if(type==='settings'){
        const settings=doc.renderSettings;
        input('Samples pro Pixel (1–1024)',settings.samples,'number',v=>settings.samples=Math.round(v),[1,1024]);
        const size=element('select',null,element('label','Bildauflösung',panel));
        for(const w of [640,1280,1920,3840]){
            element('option',w+' × '+(w*9/16),size).value=w;
        }
        size.value=settings.width;size.onchange=()=>settings.width=Number(size.value);
        const environment=element('select',null,element('label','Umgebung',panel));
        for(const [key,label] of [['studio','Zeichenstudio'],['room','Raumecke'],['none','Ohne Umgebung']])
            element('option',label,environment).value=key;
        environment.value=settings.environment;
        environment.onchange=()=>{settings.environment=environment.value;view.draw();};
        return;
    }
    if(type==='part'){
        const override=Object.hasOwn(doc.overrides,id),m=material(item);
        const label=element('label','Materialzuordnung',panel),scope=element('select',null,label);
        for(const name of ['Alle Instanzen dieses Teils','Nur diese Instanz'])element('option',name,scope);
        scope.selectedIndex=Number(override);
        function write(map,key,value){Object.defineProperty(map,key,{value,writable:true,configurable:true,enumerable:true});}
        scope.onchange=()=>{
            if(scope.selectedIndex)write(doc.overrides,id,{...m});else delete doc.overrides[id];
            properties();view.draw();
        };
        const set=(key,v)=>write(override?doc.overrides:doc.materials,override?id:item.part,{...m,[key]:v});
        input('Farbe',m.color,'color',v=>set('color',v));
        input('Rauheit (0–1)',m.roughness,'number',v=>set('roughness',v),[0,1]);
        button('Klares Glas',()=>{
            write(override?doc.overrides:doc.materials,override?id:item.part,
                {color:'#ffffff',metallic:0,roughness:.025,transmission:1});
            properties();view.draw();
        });
        input('Lichtdurchlässigkeit (0–1)',m.transmission??0,'number',v=>set('transmission',v),[0,1]);
        input('Metallanteil (0–1)',m.metallic,'number',v=>set('metallic',v),[0,1]);
        return;
    }
    input('Name',item.name,'text',v=>item.name=v.trim()||item.name);
    if(type==='light'){
        coords('Position (mm)','position');if(item.type!=='point')coords('Lichtziel (mm)','target');
        input('Farbe',item.color,'color',v=>item.color=v);
        input('Leistung (W)',item.power,'number',v=>item.power=v,[0,1e7]);
        input(item.type==='point'?'Radius (mm)':'Kantenlänge (mm)',item.size,'number',v=>item.size=v,[.1,1e7]);
    }else{
        coords('Bildmitte (mm)','center');
        input('Bildbreite (mm)',item.width,'number',v=>item.width=v,[.01,1e9]);
        for(const [key,label,limit] of [['yaw','Azimut',360],['pitch','Höhenwinkel',89.9]])
            input(label+' (°)',+(item[key]*180/Math.PI).toFixed(2),'number',v=>item[key]=v*Math.PI/180,[-limit,limit]);
    }
    if(type==='light'||doc.cameras.length>1)button(type==='light'?'Licht entfernen':'Kamera entfernen',()=>{
        if(type==='light')doc.lights=doc.lights.filter(l=>l!==item);
        else{doc.cameras=doc.cameras.filter(c=>c!==item);doc.activeCamera=doc.cameras[0].id;}
        select('camera',doc.activeCamera);
    });
}
$('paint').onclick=()=>select('part',selection?.type==='part'?selection.id:doc.model.instances[0].id);
for(const [id,type] of [['lamp','area'],['pointLamp','point']]){
    $(id).onclick=()=>{const l=newLight(doc,bounds,type);doc.lights.push(l);select('light',l.id);};
}
$('renderOptions').onclick=()=>select('settings',null);
$('camera').onclick=()=>{
    const c={...structuredClone(activeCamera()),id:crypto.randomUUID(),name:'Kamera '+(doc.cameras.length+1)};
    doc.cameras.push(c);doc.activeCamera=c.id;select('camera',c.id);
};
$('fit').onclick=()=>{fit(activeCamera());view.draw();properties();};
async function visualizerRequest(endpoint,body,headers={}){
    const session=await (await fetch('/session')).json();
    const response=await fetch('/visualizer/'+endpoint,{method:'POST',
        headers:{'Content-Type':'application/json','X-MetricCAD-Token':session.token,...headers},body});
    if(!response.ok)throw Error((await response.json()).error);
    return response;
}
async function pathRequest(payload){
    return (await visualizerRequest('blender-path',JSON.stringify(payload))).json();
}
$('blenderSettings').onclick=async()=>{
    const button=$('blenderSettings');button.disabled=true;
    try{
        const settings=await pathRequest({});
        $('blenderPath').value=settings.path;
        $('pathError').textContent='';
        $('pathDialog').showModal();
    }catch(e){status(e.message,true);}
    finally{button.disabled=false;}
};
async function editPath(action){
    const form=$('pathForm');form.inert=true;
    $('pathError').textContent='';
    try{await action();}
    catch(e){$('pathError').textContent=e.message;}
    finally{form.inert=false;}
}
$('pathDialog').oncancel=e=>{if($('pathForm').inert)e.preventDefault();};
$('cancelPath').onclick=()=>$('pathDialog').close();
$('browseBlender').onclick=()=>editPath(async()=>{
    const result=await pathRequest({browse:true});
    if(result.selection)$('blenderPath').value=result.selection;
});
$('pathForm').onsubmit=e=>{
    e.preventDefault();
    editPath(async()=>{
        const result=await pathRequest({path:$('blenderPath').value});
        $('pathDialog').close();
        status(result.path?'Blender-Pfad gespeichert.':'Automatische Blender-Suche aktiviert.');
    });
};
// Keep the exported PNG untouched. All navigation acts on its displayed copy.
const viewport=$('imageViewport'), image=$('image');
let zoom=1, panX=0, panY=0, imageDrag=null;
function positionImage(){
    const clamp=(pos,size)=>{
        const extra=size*(zoom-1);
        return extra<0?-extra/2:Math.max(-extra,Math.min(0,pos));
    };
    panX=clamp(panX,viewport.clientWidth);panY=clamp(panY,viewport.clientHeight);
    image.style.transform='translate('+panX+'px,'+panY+'px) scale('+zoom+')';
    if(image.naturalWidth)
        $('imageScale').value=Math.round(100*zoom*viewport.clientWidth*devicePixelRatio/image.naturalWidth)+' %';
}
function fitImage(){zoom=1;panX=panY=0;positionImage();}
function zoomImage(value,x,y){
    panX=x-(x-panX)*value/zoom;panY=y-(y-panY)*value/zoom;
    zoom=value;positionImage();
}
$('imageFit').onclick=fitImage;
$('imageActual').onclick=()=>zoomImage(image.naturalWidth/(viewport.clientWidth*devicePixelRatio),
    viewport.clientWidth/2,viewport.clientHeight/2);
viewport.addEventListener('wheel',e=>{
    e.preventDefault();
    const rect=viewport.getBoundingClientRect(), pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?rect.height:1);
    const actual=image.naturalWidth/(rect.width*devicePixelRatio);
    zoomImage(Math.min(Math.max(16,actual*8),Math.max(Math.min(1,actual),zoom*Math.exp(-pixels*.0015))),
        e.clientX-rect.left,e.clientY-rect.top);
},{passive:false});
viewport.onpointerdown=e=>{
    if(imageDrag||![0,1].includes(e.button))return;
    e.preventDefault();viewport.setPointerCapture(e.pointerId);
    imageDrag={id:e.pointerId,x:e.clientX,y:e.clientY};
};
viewport.onpointermove=e=>{
    if(imageDrag?.id!==e.pointerId)return;
    panX+=e.clientX-imageDrag.x;panY+=e.clientY-imageDrag.y;
    imageDrag.x=e.clientX;imageDrag.y=e.clientY;positionImage();
};
viewport.onpointerup=viewport.onpointercancel=viewport.onlostpointercapture=()=>{imageDrag=null;};
viewport.onauxclick=e=>{if(e.button===1)e.preventDefault();};
new ResizeObserver(()=>{if($('result').open)positionImage();}).observe(viewport);

function elapsed(start){
    const sec=Math.floor((performance.now()-start)/1000);
    return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
}
function watchRender(id,start){
    const bar=$('renderProgress'),controller=new AbortController();
    let timer,stage=null;
    bar.removeAttribute('value');bar.hidden=false;
    async function poll(){
        try{
            const response=await fetch('/progress/'+id,{signal:controller.signal,cache:'no-store'});
            if(response.ok){
                const next=await response.json();
                if(next?.stage)stage=next;
            }
        }catch{/* The render request reports failures independently. */}
        if(controller.signal.aborted)return;
        let message='Szene vorbereiten …';
        if(stage?.stage==='sampling'){
            bar.max=stage.total;bar.value=stage.sample;
            message='Cycles · '+stage.sample+'/'+stage.total+' Samples ('+Math.round(100*stage.sample/stage.total)+' %)';
            if(stage.remaining)message+=' · Rest ca. '+stage.remaining.replace(/\.\d+$/,'');
        }else{
            bar.removeAttribute('value');
            if(stage?.stage==='starting')message='Cycles wird vorbereitet …';
            if(stage?.stage==='saving')message='Renderbild speichern …';
        }
        status(message+' · Verstrichen '+elapsed(start));
        timer=setTimeout(poll,500);
    }
    poll();
    return ()=>{controller.abort();clearTimeout(timer);bar.hidden=true;};
}
$('render').onclick=async()=>{
    if(rendering)return;
    rendering=true;tree();status('Szene vorbereiten …');
    const width=doc.renderSettings.width,body=JSON.stringify(doc);
    const id=crypto.randomUUID(),start=performance.now(),stop=watchRender(id,start);
    try{
        const r=await visualizerRequest('render',body,{'X-CAD-Progress':id});
        const url=URL.createObjectURL(await r.blob());
        image.src=url;$('download').href=url;$('result').showModal();fitImage();
        status('Rendering fertig · '+width+' × '+(width*9/16)+' Pixel · Dauer '+elapsed(start));
    }catch(e){status(e.message,true);}
    finally{stop();rendering=false;tree();}
};
image.onload=fitImage;
$('result').onclose=()=>{imageDrag=null;URL.revokeObjectURL(image.src);image.removeAttribute('src');$('download').removeAttribute('href');};
$('close').onclick=()=>$('result').close();
resetUI();
