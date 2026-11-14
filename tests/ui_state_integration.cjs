/* Real frontend scripts + HTTP backend in jsdom, with a software 2D canvas.
 * Tests synchronization and dialogs, not browser/WebGL rendering.
 * Dev dependencies: jsdom and @napi-rs/canvas.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_MODULE||'jsdom');
const {createCanvas}=require(process.env.CANVAS_MODULE||'@napi-rs/canvas');
const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'metriccad-ui-state-'));
const server=spawn(process.env.METRICCAD_TEST_PYTHON||'python',['-u',path.join(root,'app.py'),'--no-browser','--port','0','--mcp-port','0','--data-dir',directory],{cwd:root,stdio:['ignore','pipe','pipe']});
const errors=[];let dom;
const startup=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('CAD startup timed out')),30000);let log='';
  server.on('error',reject);server.stderr.on('data',data=>process.stderr.write(data));
  server.stdout.on('data',data=>{log+=data;const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
});
async function waitFor(check,label){const until=Date.now()+30000;while(Date.now()<until){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+label+'\n'+errors.join('\n'));}

(async()=>{
  const url=await startup;const token=JSON.parse(fs.readFileSync(path.join(directory,'connection.json'),'utf8')).token;
  async function api(action,arguments_={}){const response=await fetch(url+'/api',{method:'POST',headers:{'Content-Type':'application/json','X-MetricCAD-Token':token},body:JSON.stringify({action,arguments:arguments_})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
  const native=JSON.parse(fs.readFileSync(path.join(root,'examples','plate_with_holes.json'),'utf8'));
  let project=(await api('create_project',{name:'UI state test',document:native})).project;
  const console_=new VirtualConsole();console_.on('jsdomError',e=>errors.push(e.stack||e.message));
  async function load(){
    if(dom)dom.window.close();
    dom=await JSDOM.fromURL(url+'/?project='+project.id,{resources:'usable',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console_,beforeParse(w){
      w.structuredClone=structuredClone;w.fetch=(p,o)=>fetch(new URL(p,url),o);w.AbortSignal=AbortSignal;
      w.confirm=()=>true;w.prompt=()=> 'Neues Testprojekt';
      w.ResizeObserver=class{constructor(callback){this.callback=callback;}observe(){setTimeout(()=>this.callback([]),0);}disconnect(){}};
      w.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,right:1000,bottom:700,width:1000,height:700};};
      w.HTMLElement.prototype.setPointerCapture=function(){};w.HTMLElement.prototype.releasePointerCapture=function(){};
      const canvases=new WeakMap();w.HTMLCanvasElement.prototype.getContext=function(type){if(type!=='2d')return null;if(!canvases.has(this))canvases.set(this,createCanvas(1200,900));return canvases.get(this).getContext('2d');};
    }});
    await waitFor(()=>dom.window.metriccadSync?.project && !dom.window.eval('busy'),'initial project');
  }
  await load();let w=dom.window;
  assert.equal(w.document.getElementById('save').disabled,false);
  assert.match(w.document.getElementById('tree').textContent,/Grundplatte/);
  await waitFor(()=>w.document.getElementById('mcpState').textContent==='MCP aus','initial MCP status');
  w.document.getElementById('mcpToggle').click();
  await waitFor(()=>w.document.getElementById('mcpState').textContent==='MCP aktiv · lokal','MCP start button');
  const mcpUrl=w.document.getElementById('mcpUrl').value;
  assert.match(mcpUrl,/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(w.document.getElementById('mcpUrl').hidden,false);
  w.document.getElementById('mcpCopy').click();
  await waitFor(()=>w.document.activeElement.id==='mcpUrl','copy fallback selects URL');
  assert.equal(w.document.getElementById('mcpUrl').selectionEnd,mcpUrl.length);
  await load();w=dom.window;
  await waitFor(()=>w.document.getElementById('mcpToggle').textContent==='MCP stoppen','MCP persists across reload');
  w.document.getElementById('mcpToggle').click();
  await waitFor(()=>w.document.getElementById('mcpState').textContent==='MCP aus','MCP stop button');
  assert.equal(w.document.getElementById('mcpUrl').hidden,true);

  project=(await api('set_dimension',{project_id:project.id,expected_revision:project.revision,sketch_id:'plate',dimension_id:'width',value:100})).project;
  await waitFor(()=>w.metriccadSync.project.revision===project.revision,'external change');
  assert.equal(w.eval('doc.features[0].dimensions.find(d=>d.id==="width").value'),100);

  w.document.querySelector('#tree button[aria-label="Grundplatte"]').click();
  w.document.getElementById('editSketchTool').click();
  await waitFor(()=>w.eval('mode==="2d" && context?.id==="plate"'),'sketch editor');
  w.eval('openDimensionEditor(cur().dimensions.find(d=>d.id==="width"))');
  w.document.getElementById('dimValue').value='110';w.document.getElementById('dimApply').click();
  await waitFor(()=>w.metriccadSync.project.document.features[0].dimensions.find(d=>d.id==='width').value===110,'saved UI dimension');
  w.document.getElementById('view3').click();
  await waitFor(()=>w.eval('mode==="3d" && !busy'),'3D mode');
  await waitFor(()=>w.metriccadSync.project.pending_sketch===null,'completed sketch rebuild');
  project=(await api('get_project',{project_id:project.id})).project;
  assert.equal(project.document.features[0].dimensions.find(d=>d.id==='width').value,110);

  w.document.getElementById('editSketchTool').click();await waitFor(()=>w.eval('mode==="2d"'),'second sketch edit');
  w.eval('openDimensionEditor(cur().dimensions.find(d=>d.id==="width"))');
  w.document.getElementById('dimValue').value='115';
  project=(await api('set_dimension',{project_id:project.id,expected_revision:project.revision,sketch_id:'plate',dimension_id:'width',value:120})).project;
  w.document.getElementById('dimApply').click();
  await waitFor(()=>w.metriccadSync.conflict,'revision conflict');
  assert.equal(w.eval('doc.features[0].dimensions.find(d=>d.id==="width").value'),115);
  assert.equal((await api('get_project',{project_id:project.id})).project.document.features[0].dimensions.find(d=>d.id==='width').value,120);
  w.document.getElementById('sharedProjectReload').click();await waitFor(()=>!w.metriccadSync.conflict&&!w.document.getElementById('undo').disabled,'conflict reload');
  assert.equal(w.eval('doc.features[0].dimensions.find(d=>d.id==="width").value'),120);
  w.document.getElementById('undo').click();await waitFor(()=>w.metriccadSync.project.document.features[0].dimensions.find(d=>d.id==='width').value===110,'shared undo');
  assert.equal((await api('get_project',{project_id:project.id})).project.document.features[0].dimensions.find(d=>d.id==='width').value,110);
  await load();w=dom.window;
  assert.equal(w.eval('doc.features[0].dimensions.find(d=>d.id==="width").value'),110);
  assert.deepEqual(errors,[]);
  await waitFor(()=>w.document.getElementById('mcpState').textContent==='MCP aus','MCP ready to restart');
  w.document.getElementById('mcpToggle').click();
  await waitFor(()=>w.document.getElementById('mcpState').textContent==='MCP aktiv · lokal','MCP restart');
  const healthUrl=w.document.getElementById('mcpUrl').value.replace(/\/mcp$/,'/health');
  assert.equal((await fetch(healthUrl)).ok,true);
  dom.window.close();dom=null;
  const exited=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('CAD shutdown timed out')),10000);
    server.once('exit',code=>{clearTimeout(timer);resolve(code);});
  });
  server.kill('SIGTERM');
  assert.equal(await exited,0);
  await assert.rejects(fetch(healthUrl));
  assert.equal(fs.existsSync(path.join(directory,'connection.json')),false);
  console.log('PASS: MCP start/stop/status/copy/reload/restart/app shutdown, actual frontend scripts, HTTP service, live updates, dimension dialog, deferred rebuild, conflict preservation, shared undo and reload (DOM environment; no WebGL).');
})().catch(e=>{console.error(e);if(dom)console.error('UI STATE',dom.window.document.getElementById('sharedProjectState')?.textContent,dom.window.document.getElementById('status')?.textContent);process.exitCode=1;}).finally(async()=>{
  if(dom)dom.window.close();server.kill('SIGTERM');
  await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);setTimeout(resolve,3000);});
  fs.rmSync(directory,{recursive:true,force:true});
});
