// The editors consume standalone documents. The file stores each source exactly once.
const ProjectModel = (() => {
  const formats={assembly:'MetricCAD-assembly',drawing:'MetricCAD-drawing',visualizer:'MetricCAD-visualizer'};
  const labels={part:'Teil',assembly:'Baugruppe',drawing:'Zeichnung',visualizer:'Visualisierung'};
  const empty=()=>({format:'MetricCAD-project',version:1,items:[]});
  function add(project,kind,name,data=null,id=crypto.randomUUID()){
    const item={id,kind,name:name||labels[kind],data};
    project.items.push(item);
    return item;
  }
  function get(project,id){
    const item=project.items.find(i=>i.id===id);
    if(!item)throw Error('Projektverweis fehlt.');
    return item;
  }
  function kindOf(value){
    if(!value?.format && [1,2].includes(value?.version) && Array.isArray(value.features))return 'part';
    const kind=Object.keys(formats).find(k=>formats[k]===value?.format);
    if(kind && value.version===1)return kind;
    throw Error('Unbekanntes MetricCAD-Dateiformat.');
  }
  function store(project,item,document){
    const data=structuredClone(document);
    if(kindOf(data)!==item.kind)throw Error('Dokumenttyp stimmt nicht überein.');
    if(item.kind==='assembly'){
      for(const p of data.parts){
        const previous=item.data?.parts.find(old=>old.id===p.id);
        const id=p.projectPartId||previous?.projectPartId;
        if(id && project.items.some(i=>i.id===id && i.kind==='part'))p.projectPartId=id;
        else{
          if(kindOf(p.document)!=='part')throw Error('Teildefinition fehlt.');
          p.projectPartId=add(project,'part',p.name,p.document,id).id;
        }
        delete p.document;
      }
    }else if(['drawing','visualizer'].includes(item.kind)){
      if(data.model && !item.source)item.source=importItem(project,data.model,data.name||item.name).id;
      delete data.model;
    }
    item.data=data;
  }
  function importItem(project,value,name){
    const item=add(project,kindOf(value),name);
    if(item.kind==='assembly'){
      // Standalone files bring their own definitions, even if exported by another project.
      value=structuredClone(value);
      for(const p of value.parts)delete p.projectPartId;
    }
    store(project,item,value);
    return item;
  }
  function expand(project,item){
    const data=structuredClone(item.data);
    if(!data)return null;
    if(item.kind==='assembly'){
      for(const p of data.parts)p.document=structuredClone(get(project,p.projectPartId).data);
    }else if(['drawing','visualizer'].includes(item.kind)){
      data.model=item.source?expand(project,get(project,item.source)):null;
    }
    return data;
  }
  function validate(project){
    if(project?.format!=='MetricCAD-project'||project.version!==1||!Array.isArray(project.items)||
       new Set(project.items.map(i=>i.id)).size!==project.items.length)throw Error('Ungültiges Projekt.');
    for(const i of project.items){
      if(typeof i.id!=='string'||!i.id||typeof i.name!=='string'||!Object.hasOwn(labels,i.kind)||kindOf(i.data)!==i.kind)
        throw Error('Ungültiger Projekteintrag.');
      if(i.kind==='assembly'&&(!Array.isArray(i.data.instances)||!Array.isArray(i.data.parts)||
         i.data.parts.some(p=>get(project,p.projectPartId).kind!=='part')))throw Error('Ungültiger Baugruppenbezug.');
      if(i.source && !(i.kind==='drawing'?['part','assembly']:i.kind==='visualizer'?['assembly']:[]).includes(get(project,i.source).kind))
        throw Error('Ungültiger Modellbezug.');
    }
    return project;
  }
  return {labels,empty,add,get,store,importItem,expand,validate};
})();
