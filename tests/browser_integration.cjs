/* Optional Playwright integration test. Requires `npm install playwright`.
 * METRICCAD_TEST_PYTHON points at a Python with requirements.txt installed.
 */
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

const root=path.resolve(__dirname,'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'metriccad-browser-'));
const output=process.env.METRICCAD_QA_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true});
const python=process.env.METRICCAD_TEST_PYTHON||'python';
const server=spawn(python,['-u',path.join(root,'app.py'),'--no-browser','--port','0','--data-dir',directory],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
const startup=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('CAD server startup timed out')),30000);
  server.once('error',reject);server.once('exit',code=>reject(Error('CAD server exited: '+code)));
  server.stderr.on('data',data=>process.stderr.write(data));
  let log='';server.stdout.on('data',data=>{log+=data;const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
});

(async()=>{
  const url=await startup;
  const token=JSON.parse(fs.readFileSync(path.join(directory,'connection.json'),'utf8')).token;
  async function api(action,arguments_={}){
    const response=await fetch(url+'/api',{method:'POST',headers:{'Content-Type':'application/json','X-MetricCAD-Token':token},body:JSON.stringify({action,arguments:arguments_})});
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
  }
  const document=JSON.parse(fs.readFileSync(path.join(root,'examples','plate_with_holes.json'),'utf8'));
  let project=(await api('create_project',{name:'Browserprüfung',document})).project;
  const launch={headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']};
  if(process.env.METRICCAD_CHROMIUM_EXECUTABLE)launch.executablePath=process.env.METRICCAD_CHROMIUM_EXECUTABLE;
  browser=await chromium.launch(launch);
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.stack||e.message));
  await page.goto(url+'/?project='+project.id);
  await page.waitForFunction(()=>window.metriccadSync?.project && !busy);
  await page.waitForFunction(()=>document.getElementById('sharedProjectState').textContent.startsWith('Synchron'));
  assert.equal(await page.locator('#save').isEnabled(),true);
  assert.match(await page.locator('#tree').textContent(),/Grundplatte/);
  if(output)await page.screenshot({path:path.join(output,'browser-model.png')});

  // External edit becomes visible without reload.
  project=(await api('set_dimension',{project_id:project.id,expected_revision:project.revision,sketch_id:'plate',dimension_id:'width',value:100})).project;
  await page.waitForFunction(revision=>window.metriccadSync.project.revision===revision,project.revision);
  assert.ok(Math.abs(await page.evaluate(()=>mesh.volume)-(100*50*8-4*Math.PI*9*8))<.001);

  // Change a real displayed driving dimension through the existing canvas UI.
  await page.getByRole('button',{name:'Grundplatte',exact:true}).click();
  await page.locator('#editSketchTool').click();
  await page.waitForFunction(()=>mode==='2d'&&context?.id==='plate');
  async function openWidth(){
    const label=await page.evaluate(()=>dimensionLabels.find(d=>d.id==='width'));
    assert.ok(label,'Width label must be visible');
    const bounds=await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x+label.x,bounds.y+label.y);
    await page.locator('#dimValue').waitFor({state:'visible'});
  }
  await openWidth();await page.locator('#dimValue').fill('110');await page.locator('#dimValue').press('Enter');
  await page.waitForFunction(()=>window.metriccadSync.project.document.features[0].dimensions.find(d=>d.id==='width').value===110);
  assert.equal((await api('get_project',{project_id:project.id})).project.document.features[0].dimensions.find(d=>d.id==='width').value,110);
  await page.locator('#view3').click();
  await page.waitForFunction(()=>mode==='3d'&&!busy);
  await page.evaluate(()=>window.metriccadSync.flush());
  project=(await api('get_project',{project_id:project.id})).project;
  assert.equal(project.pending_sketch,null);

  // A stale local edit must not overwrite a newer external one.
  await page.locator('#editSketchTool').click();await page.waitForFunction(()=>mode==='2d');
  await openWidth();await page.locator('#dimValue').fill('115');
  project=(await api('set_dimension',{project_id:project.id,expected_revision:project.revision,sketch_id:'plate',dimension_id:'width',value:120})).project;
  await page.locator('#dimValue').press('Enter');
  await page.waitForFunction(()=>window.metriccadSync.conflict);
  assert.equal(await page.evaluate(()=>doc.features[0].dimensions.find(d=>d.id==='width').value),115);
  assert.equal((await api('get_project',{project_id:project.id})).project.document.features[0].dimensions.find(d=>d.id==='width').value,120);
  if(output)await page.screenshot({path:path.join(output,'browser-conflict.png')});
  page.once('dialog',dialog=>dialog.accept());await page.locator('#sharedProjectReload').click();
  await page.waitForFunction(()=>!window.metriccadSync.conflict && doc.features[0].dimensions.find(d=>d.id==='width').value===120);

  // Reopening restores the shared project; original assembly workspace still loads.
  await page.reload();await page.waitForFunction(()=>window.metriccadSync?.project?.document.features[0].dimensions.find(d=>d.id==='width').value===120);
  const assembly=await browser.newPage();assembly.on('pageerror',e=>errors.push(e.message));
  await assembly.goto(url+'/assembly');await assembly.locator('#demo').click();
  await assembly.waitForFunction(()=>doc.instances.length===3&&!busy);
  assert.equal(await assembly.evaluate(()=>doc.joints.length),2);
  assert.deepEqual(errors,[]);
  console.log('PASS: browser load, live external edit, canvas dimension edit, complete rebuild, conflict preservation, reload, assembly demo.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();server.kill('SIGTERM');
  await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);setTimeout(resolve,3000);});
  fs.rmSync(directory,{recursive:true,force:true});
});
