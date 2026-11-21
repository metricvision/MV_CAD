// Local file ownership is per tab. Server revisions and file saves are independent.
function bindProjectFiles({defaultName, blocked, replace}) {
  let handle=null, stamp=null, saved=JSON.stringify(doc), active=false;
  const types=[{description:'MetricCAD JSON',accept:{'application/json':['.json']}}];
  const modified=()=>JSON.stringify(doc)!==saved;
  const fingerprint=file=>file.lastModified+'-'+file.size;

  async function run(action) {
    if(active||blocked())return false;
    active=true;document.body.inert=true;
    try{return await action();}
    catch(error){if(error.name!=='AbortError')status(error.message,true);return false;}
    finally{document.body.inert=false;active=false;}
  }

  function chooseChanges() {
    const dialog=document.createElement('dialog');
    dialog.innerHTML='<form method="dialog"><p>Änderungen an dieser Datei speichern?</p><button value="save">Speichern</button> <button value="discard">Verwerfen</button> <button value="cancel" autofocus>Abbrechen</button></form>';
    document.body.append(dialog);
    return new Promise(resolve=>{
      dialog.onclose=()=>{dialog.remove();resolve(dialog.returnValue);};
      dialog.showModal();
    });
  }

  async function save(asCopy=false) {
    let target=handle;
    if(!target||asCopy) {
      if(!window.showSaveFilePicker)throw Error('Zum Speichern mit Dateiauswahl bitte Chrome oder Edge verwenden.');
      target=await window.showSaveFilePicker({suggestedName:handle?.name||defaultName,types});
    } else if(stamp!==null && fingerprint(await target.getFile())!==stamp) {
      throw Error('Die Datei wurde außerhalb dieses Tabs geändert. Bitte „Speichern unter …“ verwenden.');
    }
    const snapshot=JSON.stringify(doc), contents=JSON.stringify(doc,null,2);
    const writer=await target.createWritable();
    try{await writer.write(contents);await writer.close();}
    catch(error){await writer.abort().catch(()=>{});throw error;}
    handle=target;saved=snapshot;stamp=null;
    stamp=fingerprint(await target.getFile());
    status('Gespeichert · '+handle.name);
    return true;
  }

  async function change(action,target=null,asDraft=false) {
    if(modified()){
      const choice=await chooseChanges();
      if(choice==='save')await save();
      else if(choice!=='discard')return false;
    }
    const file=target && await target.getFile();
    if(file && file.size>4_000_000)throw Error('Projektdatei größer als 4 MB.');
    if(!await action(file))return false;
    handle=target;stamp=file && fingerprint(file);saved=asDraft ? null : JSON.stringify(doc);
    return true;
  }

  $('save').onclick=()=>run(()=>save());
  $('saveAs').onclick=()=>run(()=>save(true));
  if(replace){
    $('new').onclick=()=>run(()=>change(()=>replace(null)));
    $('open').onclick=()=>run(async()=>{
      if(!window.showOpenFilePicker)throw Error('Zum Öffnen mit Dateiauswahl bitte Chrome oder Edge verwenden.');
      const [target]=await window.showOpenFilePicker({types});
      return change(async file=>{
        const value=JSON.parse(await file.text());
        if(!value || typeof value!=='object')throw Error('Ungültige Projektdatei.');
        return replace(value,file.name);
      },target);
    });
  }
  window.addEventListener('beforeunload',e=>{if(active||modified()){e.preventDefault();e.returnValue='';}});
  window.addEventListener('keydown',e=>{
    if(document.body.inert){
      if(!e.target.closest?.('dialog'))e.preventDefault();
      e.stopImmediatePropagation();
    }
  },true);
  return {
    get active(){return active;},
    switchTo:(action,asDraft=false)=>run(()=>change(action,null,asDraft)),
    markClean(){handle=null;stamp=null;saved=JSON.stringify(doc);},
    transferred(){if(!handle)saved=JSON.stringify(doc);}
  };
}

// Keep the command menus aligned even when the compact header scrolls.
for(const trigger of document.querySelectorAll('.cad-header [popovertarget]')){
  const menu=document.getElementById(trigger.getAttribute('popovertarget'));
  menu.addEventListener('toggle',()=>{
    const open=menu.matches(':popover-open');
    trigger.setAttribute('aria-expanded',String(open));
    if(!open)return;
    const rect=trigger.getBoundingClientRect();
    menu.style.top=rect.bottom+2+'px';
    const width=document.documentElement.clientWidth;
    if(rect.left>width/2)menu.style.right=Math.max(0,width-rect.right)+'px';
    else menu.style.left=Math.max(0,rect.left)+'px';
    menu.style[rect.left>width/2?'left':'right']='auto';
  });
  menu.addEventListener('click',e=>{
    if(e.target.closest('button,a') && !['sharedProjectList','mcpToggle','mcpCopy'].includes(e.target.id))menu.hidePopover?.();
  });
}
