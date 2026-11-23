// Project navigation and disk round trips using in-memory editors and file handles.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const plate=JSON.parse(fs.readFileSync(path.join(root,'examples/plate_with_holes.json')));
const empty={
  part:{version:2,features:[]},
  assembly:{format:'MetricCAD-assembly',version:1,parts:[],instances:[],joints:[],constraints:[]},
  drawing:{format:'MetricCAD-drawing',version:1,sheets:[],model:null},
  visualizer:{format:'MetricCAD-visualizer',version:1,model:null,materials:{},cameras:[],lights:[]}
};
let pick,openFile,disk='',writes=0,savePicks=0;
function element(){
  return {style:{},children:[],append(e){this.children.push(e);},focus(){},remove(){},setAttribute(){},
    click(){return this.onclick();},showModal(){
      const choice=this.children.find(e=>e.textContent===pick);if(choice)choice.click();
    },close(){this.onclose();}};
}
const body=element(),nodes=new Map();
body.prepend=frame=>{
  let document=structuredClone(empty[frame.src.split('/').pop()]);
  frame.contentWindow={projectEditor:{
    snapshot:()=>document,load(value){if(value)document=value;},
    async link(model,name){document.model=model;document.name=name;},
    async insert(part){
      document.parts.push({id:'board',document:part.data,projectPartId:part.id});
      document.instances.push({part:'board',id:'board1'});
    }
  }};
  queueMicrotask(()=>frame.onload());
};
const document={body,createElement:element,getElementById(id){
  if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);
}};
const ctx=vm.createContext({document,JSON,structuredClone,crypto:require('node:crypto'),URLSearchParams,
  location:{pathname:'/',search:''},setTimeout:()=>0,clearTimeout(){},addEventListener(){},console});
ctx.window=ctx;
const evaluate=s=>vm.runInContext(s,ctx);
for(const script of ['project_model','project_files','project'])
  evaluate(fs.readFileSync(path.join(root,'frontend/js',script+'.js'),'utf8'));
const handle={name:'Werkstatt.json',getFile:async()=>({name:'Werkstatt.json',lastModified:writes,size:disk.length,text:async()=>disk}),
  createWritable:async()=>({write:async s=>{disk=s;},close:async()=>{writes++;}})};
ctx.showSaveFilePicker=async()=>{savePicks++;return handle;};
ctx.showOpenFilePicker=async()=>[openFile||handle];
const file=id=>ctx.metricProject.file(id);
const workspace=kind=>ctx.metricProject.workspace(kind);
(async()=>{
  await new Promise(r=>setImmediate(r));
  const initial=evaluate('entry().id');
  Object.assign(evaluate('current().editor.snapshot()'),structuredClone(plate));pick='Teil';
  await workspace('assembly');await ctx.metricProject.insert();
  const assembly=evaluate('entry().id'),assemblyFrame=evaluate('current().frame');
  await ctx.metricProject.editPart('board');assert.equal(evaluate('active'),initial);
  evaluate('current().editor.snapshot().features[0].depth=17');
  await workspace('assembly');assert.equal(evaluate('current().frame'),assemblyFrame);
  assert.equal(evaluate('current().editor.snapshot().parts[0].document.features[0].depth'),17);
  pick='Baugruppe';await workspace('drawing');await ctx.metricProject.link('assembly');
  evaluate('current().editor.snapshot().sheets.push({id:"Blatt",dims:[]})');
  await workspace('visualizer');await ctx.metricProject.link('assembly');
  evaluate('current().editor.snapshot().materials.board={color:"#ffffff"}');
  await file('save');const first=JSON.parse(disk);
  assert.equal(first.items.length,4);
  for(const item of first.items.filter(i=>['drawing','visualizer'].includes(i.kind))){
    assert.equal(item.source,assembly);assert.equal(item.data.model,undefined);
  }
  assert.equal(first.items[1].data.parts[0].document,undefined);
  await workspace('part');evaluate('current().editor.snapshot().features[0].depth=21');
  await workspace('drawing');assert.equal(evaluate('current().editor.snapshot().model.parts[0].document.features[0].depth'),21);
  await file('save');assert.equal(savePicks,1);
  await file('open');await workspace('visualizer');
  assert.equal(evaluate('current().editor.snapshot().model.parts[0].document.features[0].depth'),21);
  assert.equal(evaluate('current().editor.snapshot().materials.board.color'),'#ffffff');
  await workspace('drawing');assert.equal(evaluate('current().editor.snapshot().sheets[0].id'),'Blatt');
  const count=writes;
  const legacy={...empty.assembly,parts:[{id:'board',document:plate}],instances:[{id:'a',part:'board'},{id:'b',part:'board'}]};
  openFile={getFile:async()=>({name:'Alt.json',text:async()=>JSON.stringify(legacy)})};
  await file('open');assert.equal(evaluate('doc.items.length'),2);
  await file('save');assert.equal(savePicks,2);assert.equal(writes,count+1);
  console.log('PASS · project navigation, shared part, drawing, scene, single file, reopen, legacy import.');
})().catch(e=>{console.error(e);process.exitCode=1;});
