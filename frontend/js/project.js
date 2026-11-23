'use strict';
const $=id=>document.getElementById(id);
const model=ProjectModel;
let doc=model.empty(),active=null,frames=new Map(),recent=new Map(),servers=new Map(),working=false,timer;
function status(message,error=false){
  const notice=$('status');
  ($('tree').open?$('tree'):document.body).append(notice);
  clearTimeout(timer);notice.textContent=message;
  timer=setTimeout(()=>{notice.textContent='';},error?10000:3500);
}
function entry(){return model.get(doc,active);}
function current(){return frames.get(active);}
function dirty(){const f=current();return !!f && JSON.stringify(f.editor.snapshot())!==f.snapshot;}
function refreshIndicator(){
  const f=current();
  if(!f)return;
  let changed=files.modified();
  if(dirty()){
    if(changed){
      // Undo can bring the active editor back to disk state after switching workspaces.
      const item={...entry()},candidate={...doc,items:doc.items.map(i=>i.id===active?item:i)};
      model.store(candidate,item,f.editor.snapshot());
      changed=files.modified(candidate);
    }else changed=true;
  }
  f.editor.setDirty?.(changed);
}
let indicatorTimer=null;
function editorChanged(){
  if(indicatorTimer!==null)return;
  indicatorTimer=setTimeout(()=>{indicatorTimer=null;refreshIndicator();},150);
}
async function capture(){
  const f=current();
  if(!f)return;
  if(f.editor.blocked?.())throw Error('Bitte die laufende Bearbeitung zuerst abschließen.');
  await f.editor.flush?.();
  if(f.editor.serverId)servers.set(active,f.editor.serverId());
  if(dirty() || !entry().data){
    model.store(doc,entry(),f.editor.snapshot());
    f.snapshot=JSON.stringify(f.editor.snapshot());
    f.input=JSON.stringify(model.expand(doc,entry()));
  }
}
async function run(action){
  if(working||files.active)return;
  working=true;document.body.inert=true;
  try{await capture();await action();}
  catch(e){if(e.name!=='AbortError')status(e.message,true);}
  finally{document.body.inert=false;working=false;refreshIndicator();}
}
async function openItem(item,serverId=null){
  const value=model.expand(doc,item),input=JSON.stringify(value);
  let f=frames.get(item.id);
  if(!f){
    const frame=document.createElement('iframe');
    frame.title=item.name;frame.style.visibility='hidden';
    frame.src='/editor/'+item.kind;
    const loaded=new Promise(resolve=>frame.onload=resolve);document.body.prepend(frame);
    try{
      await loaded;
      const editor=frame.contentWindow.projectEditor;
      if(!editor)throw Error('Arbeitsbereich konnte nicht gestartet werden.');
      if(await editor.load(value,item.name,serverId||servers.get(item.id))===false)throw Error('Modell konnte nicht geöffnet werden.');
      f={frame,editor,input,snapshot:JSON.stringify(editor.snapshot())};
      frames.set(item.id,f);
    }catch(e){frame.remove();throw e;}
  }else if(f.input!==input){
    if(await (f.editor.refresh||f.editor.load)(value,item.name)===false)throw Error('Modell konnte nicht aktualisiert werden. Bitte Teil und Bedingungen prüfen.');
    f.input=input;f.snapshot=JSON.stringify(f.editor.snapshot());
  }
  // Large models own WebGL contexts. Keep only the last editor of each kind alive.
  const previous=recent.get(item.kind);
  if(previous && previous!==item.id){
    frames.get(previous)?.frame.remove();frames.delete(previous);
  }
  if(current())current().frame.hidden=true;
  active=item.id;recent.set(item.kind,item.id);f.frame.hidden=false;f.frame.style.visibility='';
  model.store(doc,item,f.editor.snapshot());
  f.input=JSON.stringify(model.expand(doc,item));
  f.frame.title=item.name;document.title=item.name+' · MetricCAD';f.frame.focus();
}
async function create(kind,name,serverId=null){
  const item=model.add(doc,kind,name);
  try{await openItem(item,serverId);}
  catch(e){doc.items.splice(doc.items.indexOf(item),1);throw e;}
}
function button(container,label,click){
  const b=document.createElement('button');b.textContent=label;b.onclick=click;container.append(b);return b;
}
function treeLabel(row,kind,name){
  const ns='http://www.w3.org/2000/svg';
  const icon=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');
  icon.setAttribute('class','icon');icon.setAttribute('aria-hidden','true');
  use.setAttribute('href','#icon-'+kind);icon.append(use);
  const label=document.createElement('span');label.textContent=name;
  row.append(icon,label);
}
function toggleBranch(toggle,branch){
  toggle.setAttribute('aria-expanded','true');
  toggle.onclick=()=>{
    branch.hidden=!branch.hidden;
    toggle.setAttribute('aria-expanded',String(!branch.hidden));
  };
}
function tree(){
  $('nameForm').hidden=true;$('treeActions').hidden=false;
  $('openProject').hidden=!!active;$('closeTree').hidden=!active;
  const list=$('entries');list.hidden=false;list.replaceChildren();
  const titles={part:'Teile',assembly:'Baugruppen',drawing:'Zeichnungen',visualizer:'Visualisierungen'};
  function append(parent,tag){
    const el=document.createElement(tag);parent.append(el);return el;
  }
  function node(row,kind,name,open){
    const btn=button(row,'',()=>{$('tree').close();run(open);});
    btn.className='node';btn.title=name;treeLabel(btn,kind,name);
    return btn;
  }
  for(const [kind,title] of Object.entries(titles)){
    const items=doc.items.filter(i=>i.kind===kind);
    const group=append(list,'section'),head=append(group,'header');
    const heading=items.length?button(head,'',null):append(head,'span');
    heading.className='group-title'+(items.length?'':' empty');treeLabel(heading,kind,title);
    const add=button(head,'+',()=>askName(kind));
    add.className='add';add.title=model.labels[kind]+' anlegen';add.setAttribute('aria-label',add.title);
    if(!items.length)continue;
    const branch=append(group,'ul');toggleBranch(heading,branch);
    for(const item of items){
      const leaf=append(branch,'li'),row=append(leaf,'div');row.className='tree-row';
      const sheets=item.data?.sheets||[];
      const toggle=sheets.length?button(row,'',null):null;
      const btn=node(row,kind,item.name,()=>openItem(item));
      if(item.id===active)btn.setAttribute('aria-current','true');
      if(!toggle)continue;
      toggle.className='twist';toggle.setAttribute('aria-label',item.name+' · Zeichenblätter');
      const children=append(leaf,'ul');toggleBranch(toggle,children);
      sheets.forEach((sheet,index)=>{
        const child=append(children,'li'),line=append(child,'div');line.className='tree-row';
        node(line,'drawing',sheet.title||'Blatt '+(index+1),async()=>{
          await openItem(item);await current().editor.sheet(sheet);
        });
      });
    }
  }
  if(!$('tree').open)$('tree').showModal();
}
function askName(kind){
  if(!$('tree').open)tree();
  $('entries').hidden=$('treeActions').hidden=true;
  $('nameForm').hidden=false;$('nameLabel').textContent=model.labels[kind]+' benennen';
  const input=$('objectName');
  const prefix=kind==='part'?'Part':model.labels[kind];
  const used=new Set(doc.items.filter(item=>item.kind===kind).map(item=>item.name.trim().toLowerCase()));
  let n=1;
  while(used.has((prefix+'_'+n).toLowerCase()))n++;
  input.value=prefix+'_'+n;
  input.oninput=()=>{$('confirmName').disabled=!input.value.trim();input.setCustomValidity('');};
  input.oninput();input.focus();input.select();
  $('nameForm').onsubmit=e=>{
    e.preventDefault();
    const name=input.value.trim();
    if(name)return run(async()=>{
      try{await create(kind,name);$('tree').close();}
      catch(error){input.setCustomValidity(error.message);input.reportValidity();}
    });
  };
}
$('cancelName').onclick=tree;
$('tree').oncancel=e=>{
  if(!active||!$('nameForm').hidden){
    e.preventDefault();
    if(!working)tree();
  }
};
$('openProject').onclick=()=>files.open();
function pick(kind){
  const candidates=doc.items.filter(i=>i.kind===kind);
  if(!candidates.length)throw Error('Kein passendes Modell im Projekt. Bitte zuerst anlegen oder importieren.');
  const dialog=document.createElement('dialog'),heading=document.createElement('h2');
  heading.textContent=model.labels[kind]+' auswählen';dialog.append(heading);document.body.append(dialog);
  return new Promise(resolve=>{
    let selected=null;
    for(const i of candidates)button(dialog,i.name,()=>{selected=i;dialog.close();}).className='entry';
    button(dialog,'Abbrechen',()=>dialog.close());
    dialog.onclose=()=>{dialog.remove();resolve(selected);};dialog.showModal();
  });
}
async function link(kind){
  const source=await pick(kind);
  if(!source)return;
  const old=entry();
  if(old.source===source.id)return;
  if(old.source)await create(old.kind,model.labels[old.kind]+' · '+source.name);
  try{
    const f=current();await f.editor.link(model.expand(doc,source),source.name);
    entry().source=source.id;
    if(entry().name===model.labels[entry().kind])entry().name+=' · '+source.name;
    await capture();
  }catch(e){if(old.id!==active){const failed=entry();current().frame.remove();frames.delete(active);doc.items.splice(doc.items.indexOf(failed),1);await openItem(old);}throw e;}
}
async function replace(value,name,serverId=null){
  const old={doc,active,frames,recent,servers};
  let next=model.empty(),first,legacy=false;
  if(value?.format==='MetricCAD-project'){next=model.validate(value);first=next.items.find(i=>i.id===next.lastActive)||next.items[0];}
  else if(value){legacy=true;first=model.importItem(next,value,name.replace(/(?:\.metriccad)?\.json$/i,''));}
  doc=next;active=null;frames=new Map();recent=new Map();servers=new Map();
  try{
    if(first)await openItem(first);
    else if(serverId)await create('part',model.labels.part,serverId);
    if(active){if($('tree').open)$('tree').close();}
    else{document.title='MetricCAD · Projekt';tree();}
  }catch(e){doc=old.doc;active=old.active;frames=old.frames;recent=old.recent;servers=old.servers;throw e;}
  for(const f of old.frames.values())f.frame.remove();
  if(old.active && location.search)window.history.replaceState(null,'',location.pathname);
  return legacy?'imported':true;
}
async function importDocument(value,name){
  const staging=model.empty(),item=model.importItem(staging,value,name);
  model.validate(staging);doc.items.push(...staging.items);
  try{await openItem(item);}catch(e){doc.items.splice(-staging.items.length);throw e;}
}
const files=bindProjectFiles({defaultName:'Projekt.metriccad.json',prepare:capture,documentToSave:()=>({...doc,lastActive:active}),editorDirty:dirty,refreshIndicator,replace});
window.metricProject={
  editorChanged,
  workspace:kind=>run(async()=>{
    const item=doc.items.find(i=>i.id===recent.get(kind))||doc.items.find(i=>i.kind===kind);
    if(item)await openItem(item);else askName(kind);
  }),
  file:id=>{if(!working)return files[id]();},
  tree:()=>run(tree),
  insert:()=>run(async()=>{const part=await pick('part');if(part)await current().editor.insert(part);}),
  editPart:local=>run(()=>openItem(model.get(doc,entry().data.parts.find(p=>p.id===local).projectPartId))),
  link:kind=>run(()=>link(kind)),
  importFile:()=>run(async()=>{
    const [handle]=await showOpenFilePicker({types:[{description:'MetricCAD JSON',accept:{'application/json':['.json']}}]});
    const file=await handle.getFile();
    await importDocument(JSON.parse(await file.text()),file.name.replace(/(?:\.metriccad)?\.json$/i,''));
  }),
  exportFile:()=>run(async()=>{
    const handle=await showSaveFilePicker({suggestedName:entry().name+'.metriccad.json'});
    const out=model.expand(doc,entry());
    function standalone(value){for(const p of value?.parts||[])delete p.projectPartId;}
    standalone(out);standalone(out.model);
    const writer=await handle.createWritable();try{await writer.write(JSON.stringify(out,null,2));await writer.close();}catch(e){await writer.abort().catch(()=>{});throw e;}
  }),
  addDocument:(value,name)=>run(()=>importDocument(value,name)),
  serverPart:(id,name)=>run(()=>{
    const existing=doc.items.find(i=>servers.get(i.id)===id);
    return existing?openItem(existing):create('part',name,id);
  })
};
replace(null,null,new URLSearchParams(location.search).get('project')).then(()=>files.markClean()).catch(e=>{tree();status(e.message,true);});
