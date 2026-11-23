// One file handle and one saved snapshot per project.
function bindProjectFiles({defaultName, prepare, editorDirty, replace}) {
  let handle=null, stamp=null, saved=JSON.stringify(doc), active=false;
  const types=[{description:'MetricCAD JSON',accept:{'application/json':['.json']}}];
  const modified=()=>JSON.stringify(doc)!==saved;
  const fingerprint=file=>file.lastModified+'-'+file.size;

  async function run(action) {
    if(active)return false;
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
    await prepare();
    const snapshot=JSON.stringify(doc), contents=JSON.stringify(doc,null,2);
    const writer=await target.createWritable();
    try{await writer.write(contents);await writer.close();}
    catch(error){await writer.abort().catch(()=>{});throw error;}
    handle=target;saved=snapshot;stamp=null;
    stamp=fingerprint(await target.getFile());
    status('Gespeichert · '+handle.name);
    return true;
  }

  async function change(action,target=null) {
    await prepare();
    if(modified()){
      const choice=await chooseChanges();
      if(choice==='save')await save();
      else if(choice!=='discard')return false;
    }
    const file=target && await target.getFile();

    const result=await action(file);
    if(!result)return false;
    const imported=result==='imported';
    handle=imported?null:target;stamp=handle&&fingerprint(file);saved=imported?null:JSON.stringify(doc);
    return true;
  }

  async function open(){
    if(!window.showOpenFilePicker)throw Error('Zum Öffnen mit Dateiauswahl bitte Chrome oder Edge verwenden.');
    const [target]=await window.showOpenFilePicker({types});
    return change(async file=>{
      const value=JSON.parse(await file.text());
      if(!value || typeof value!=='object')throw Error('Ungültige Projektdatei.');
      return replace(value,file.name);
    },target);
  }
  window.addEventListener('beforeunload',e=>{if(active||editorDirty()||modified()){e.preventDefault();e.returnValue='';}});
  window.addEventListener('keydown',e=>{
    if(document.body.inert){
      if(!e.target.closest?.('dialog'))e.preventDefault();
      e.stopImmediatePropagation();
    }
  },true);
  return {
    get active(){return active;},
    new:()=>run(()=>change(()=>replace(null))),
    open:()=>run(open),
    save:()=>run(()=>save()),
    saveAs:()=>run(()=>save(true)),
    markClean(){saved=JSON.stringify(doc);}
  };
}
