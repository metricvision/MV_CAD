/* Shared project state for Part Studio. Existing sketch tools remain native.
 * Draft pointer motion stays local; completed edits are committed with a
 * revision check. A remote change can never overwrite an uncommitted draft.
 */
(() => {
  'use strict';
  if (assemblyEditToken) return; // Assembly editor tabs use their explicit hand-off.
  let token = null, project = null, acknowledged = null;
  let applying = false, saving = null, loading = false, conflict = false, ready = false;
  let timer = null, polling = false, errorText = '';
  $('sharedProjectList').hidden=$('mcpMenuButton').hidden=false;
  let mcpRunning=false, mcpRequest=null;

  async function updateMCP(action='status') {
    if(mcpRequest && (action==='status' || mcpRequest.action!=='status'))return;
    const current=mcpRequest={action};
    if(action!=='status')$('mcpToggle').disabled=true;
    if(action!=='status')$('mcpState').textContent=action==='start'?'MCP startet …':'MCP stoppt …';
    try {
      const result=await request('/mcp/'+action,action==='status'?undefined:{},30000);
      if(mcpRequest!==current)return;
      mcpRunning=result.running;
      $('mcpToggle').textContent=mcpRunning?'MCP stoppen':'MCP starten';
      $('mcpUrl').value=result.url;
      $('mcpUrl').hidden=$('mcpCopy').hidden=!mcpRunning;
      $('mcpState').textContent=result.error||(mcpRunning?'MCP aktiv · lokal':'MCP aus');
      $('mcpState').className=result.error?'sync-error':'';
    } catch(error) {if(mcpRequest!==current)return;$('mcpState').textContent=error.message;$('mcpState').className='sync-error';}
    finally {if(mcpRequest===current){mcpRequest=null;$('mcpToggle').disabled=false;}}
  }
  $('mcpToggle').onclick=()=>updateMCP(mcpRunning?'stop':'start');
  $('mcpCopy').onclick=async()=>{
    try {await navigator.clipboard.writeText($('mcpUrl').value);$('mcpState').textContent='Adresse kopiert';}
    catch {$('mcpUrl').focus();$('mcpUrl').select();$('mcpState').textContent='Adresse markieren und kopieren';}
  };

  const snapshot = () => JSON.stringify(doc);
  const needsFinalize = () => !!project?.pending_sketch && mode !== '2d' && !dirty;
  const unsaved = () => acknowledged !== null && (snapshot() !== acknowledged || needsFinalize());
  const editing = () => busy || geometrySaving || !!sketchMove || !!dimensionMove || !!drag ||
    !!edgeApplying || editingDimension !== null || dimensionDraft !== null ||
    !!polyDraft.length || !!constructionDraft.length || !!arcDraft.length || !!curveDraft.length;
  const selecting = () => !!tool || !!relationTool || !!edgeTool || !!helixDraft || !!sweepDraft || !!revolveDraft || dimensionTool;

  async function session() {
    const response = await fetch('/session', {cache: 'no-store'});
    if (!response.ok) throw Error('CAD-Server nicht erreichbar.');
    token = (await response.json()).token;
  }

  async function request(path, payload, timeout=120000, retried=false) {
    if (!token) await session();
    const options = {cache:'no-store', signal:AbortSignal.timeout(timeout)};
    if (payload !== undefined) Object.assign(options, {
      method:'POST', headers:{'Content-Type':'application/json', 'X-MetricCAD-Token':token}, body:JSON.stringify(payload)
    });
    const tracked = ['get_project_view','replace_document','create_project','undo','redo'].includes(payload?.action);
    const response = await (tracked ? fetchWithProgress : fetch)(path, options);
    if (response.status === 403 && !retried) { await session(); return request(path,payload,timeout,true); }
    const result = await response.json();
    if (!response.ok) { const error = Error(result.error || 'CAD-Anfrage fehlgeschlagen.'); error.details = result.details; throw error; }
    return result;
  }
  const api = (action, arguments_={}) => request('/api',{action, arguments:arguments_});

  function showState() {
    const badge = $('sharedProjectState');
    badge.className = conflict || errorText ? 'sync-error' : '';
    badge.textContent = conflict ? 'Gleichzeitige Änderung erkannt · dein Entwurf bleibt erhalten' :
      errorText || (!ready || loading ? 'Projekt wird geladen …' : saving ? 'Arbeitsstand wird synchronisiert …' :
        unsaved() ? 'Lokaler Entwurf · noch nicht übernommen' : !project.id ? 'Neues Teil' : 'Synchron · Stand ' + project.revision + (project.pending_sketch ? ' · Skizzenbearbeitung' : ''));
    for (const id of ['sharedProjectReload', 'sharedProjectFork']) $(id).hidden = !conflict && !errorText;
    $('sharedProjectSelect').disabled = !ready || loading || !!saving || busy || geometrySaving;
  }

  async function refreshList() {
    const result = await api('list_projects');
    const select = $('sharedProjectSelect'), previous = project?.id;
    select.replaceChildren(new Option('Unbenannt', ''));
    for (const item of result.projects) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
      select.append(option);
    }
    select.value = previous || '';
    select.hidden=false;
  }

  function resetTools() {
    cancelSketchMove(); cancelDimensionMove(); clearRelationsUI(); multiReset(); closeDimensionEditor();
    tool = bind = repair = drag = null; edgeTool = null; edgeSelection = []; hoverEdge = null;
    dimensionTool = false; dimensionPicks = []; selectedFace = null; hoverFace = hoverPlane = null;
    waitingPlane = false; lastError = ''; pending = false;
  }

  function receive(result, reset = false) {
    applying = true;
    try {
      const oldSelected = selected, oldMode = mode;
      const view = !reset && oldMode === '2d' && context ? {center: world(W/2,H/2), scale: scale2()} : null;
      project = result.project;
      if (reset) { resetTools(); selected = null; context = null; mode = '3d'; plane = null; history = []; future = []; }
      doc = structuredClone(project.document);
      if (result.preview) {
        acceptBuiltResult(result.preview);
        if (project.pending_sketch) {
          const f = doc.features.find(f => f.id === project.pending_sketch), l = layout(f);
          if (f && l) { selected=f.id; selectedKind='sketch'; context={id:f.id,support:f.support,info:l}; mode='2d'; dirty=true; l.solvedFeature=JSON.stringify(f); }
        } else if (!reset && oldMode === '2d') {
          const f = doc.features.find(f => f.id === oldSelected), l = layout(f);
          if (f && l && !isHelix(f)) { selected=f.id; context={id:f.id,support:f.support,info:l}; mode='2d'; }
          else { context=null; mode='3d'; }
        }
      } else if (result.sketch_result) {
        acceptSketchResult(result.sketch_result);
      }
      originVisible = !doc.features.length;
      if (selected && !doc.features.some(f => f.id === selected)) selected = null;
      acknowledged = snapshot(); conflict = false; errorText = ''; ready = true;
      if (view && mode === '2d') {
        zoom *= view.scale / scale2(); const b=sketchBounds();
        pan=[((b[0]+b[1])/2-view.center[0])*view.scale,(view.center[1]-(b[2]+b[3])/2)*view.scale];
      }
      stash(); if (reset) fit(); render(); showState();
    } finally { applying = false; }
  }

  async function loadProject(target) {
    if(loading)return false;
    const alreadyLocked=document.body.inert;
    document.body.inert=true;loading=true;
    try {
      clearTimeout(timer);
      if(saving)await saving;
      const id=typeof target==='function' ? (await target()).project.id : target;
      if(id)receive(await api('get_project_view',{project_id:id}),true);
      else {
        const document=fresh();
        const preview={document,vertices:[],triangles:[],triangleFaces:[],faces:[],edges:[],layouts:[],
          volume:0,bounds:[-50,50,-50,50,-50,50]};
        collapsedNodes.clear();
        receive({project:{id:null,name:'Unbenannt',revision:0,document},preview},true);
      }
      return true;
    } finally {
      loading=false;document.body.inert=alreadyLocked;
      if(project)$('sharedProjectSelect').value=project.id||'';
      render();
    }
  }

  function changed() {
    if (applying || !ready) return;
    showState(); clearTimeout(timer);
    timer=setTimeout(()=>flush().catch(()=>{}),250);
  }

  async function flush() {
    if (saving) { await saving; if (unsaved() && !conflict) return flush(); return !conflict; }
    if (!ready || conflict || loading) return false;
    if (!unsaved()) return true;
    if (editing()) { clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),250);return false; }
    if (lastError) { errorText='Entwurf noch nicht gültig: '+lastError;showState();return false; }
    const sent=snapshot(), candidate=JSON.parse(sent), revision=project.revision;
    const current=activeSketch();
    const sketchID=mode==='2d'&&current&&layout(current)?.solvedFeature===JSON.stringify(current)?current.id:null;
    const old=JSON.parse(acknowledged);
    const annotationOnly=!needsFinalize() && dimensionLayoutKey(old)===dimensionLayoutKey(candidate);
    saving=(async()=>{
      try {
        if(!project.id)project=(await api('create_project',{name:project.name})).project;
        const result=await api('replace_document',{project_id:project.id,expected_revision:revision,document:candidate,
          sketch_id:annotationOnly?null:sketchID,annotation_only:annotationOnly,allow_partial:true});
        const stillInSketch=!result.sketch_result || (mode==='2d' && context?.id===sketchID);
        if(snapshot()===sent && !editing() && stillInSketch) receive(result);
        else { project=result.project;acknowledged=JSON.stringify(result.project.document); }
        errorText='';return true;
      } catch(error) {
        if(error.details?.code==='revision_conflict') conflict=true;
        else errorText=error.message;
        showState();return false;
      } finally { saving=null;showState(); }
    })();
    showState();return saving;
  }

  async function poll() {
    if (polling || document.body.inert || loading || !ready || conflict || editing() || selecting() || saving) return;
    polling=true;
    try {
      if(unsaved()) { await flush();return; }
      if(!project.id)return;
      const before=snapshot(), id=project.id;
      const result=await api('get_project',{project_id:id,include_document:false});
      if(result.project.revision!==project.revision) {
        const full=await api('get_project_view',{project_id:id});
        if(!document.body.inert && project.id===id && snapshot()===before && !editing() && !selecting() && !saving) {
          receive(full);status('Projekt aktualisiert · '+full.project.last_action);
        }
      }
      errorText='';showState();
    } catch(error) { errorText='Verbindung unterbrochen: '+error.message;showState(); }
    finally { polling=false; }
  }

  const originalRender=render;
  render=function() {
    if(ready) for(const b of document.querySelectorAll('header button,#tools button')) b.disabled=false;
    originalRender();
    if(!ready) { for(const b of document.querySelectorAll('header button,#tools button')) b.disabled=true; }
    else {
      $('undo').disabled=busy||geometrySaving||!!saving||loading||(!project.can_undo&&!unsaved());
      $('redo').disabled=busy||geometrySaving||!!saving||loading||!project.can_redo||unsaved();
      for(const id of ['new','open']) $(id).disabled=busy||geometrySaving||!!saving||loading;
    }
    showState();
  };

  undo=async function(redo=false) {
    if(!ready||editing()||loading)return;
    if(conflict){status('Zuerst den gleichzeitigen Änderungsstand auflösen.',true);return;}
    if(unsaved()&&lastError) {await loadProject(project.id);status('Ungültigen lokalen Entwurf zurückgenommen.');return;}
    if(!(await flush()))return;
    busy=true;render();
    try {receive(await api(redo?'redo':'undo',{project_id:project.id,expected_revision:project.revision}),true);status(redo?'Wiederhergestellt.':'Rückgängig gemacht.');}
    catch(error){if(error.details?.code==='revision_conflict')conflict=true;status(error.message,true);}
    finally{busy=false;render();}
  };
  $('undo').onclick=()=>undo();$('redo').onclick=()=>undo(true);

  const files=bindProjectFiles({
    defaultName:'MetricCAD-Teil.json',blocked:()=>!ready||loading||editing(),
    async replace(value,name) {
      if(value!==null && ![1,2].includes(value?.version))throw Error('Bitte eine Bauteil-JSON wählen.');
      if(value?.format==='MetricCAD-assembly')throw Error('Baugruppen bitte in der Baugruppenansicht öffnen.');
      const ok=await loadProject(value===null ? null : ()=>api('create_project',{name:name.replace(/\.json$/i,''),document:value,allow_partial:true}));
      if(ok)window.history.replaceState(null,'','/');
      return ok;
    }
  });
  $('sharedProjectList').onclick=()=>refreshList().catch(error=>status(error.message,true));
  $('sharedProjectSelect').onchange=async e=>{
    const id=e.target.value;
    $('file-menu').hidePopover?.();
    e.target.value=project.id||'';
    await files.switchTo(async()=>{
      if(!await loadProject(id))return false;
      window.history.replaceState(null,'',id?'/?project='+encodeURIComponent(id):'/');
      return true;
    });
  };
  $('sharedProjectReload').onclick=async()=>{
    if(editing()||saving)return;
    if(unsaved()&&!confirm('Lokalen Entwurf verwerfen und den Serverstand laden? Du kannst ihn zuvor mit „Speichern unter …“ sichern.'))return;
    try{await loadProject(project?.id);}catch(error){errorText=error.message;showState();}
  };
  $('sharedProjectFork').onclick=async()=>{
    if(editing()||saving)return;
    try{await files.switchTo(()=>loadProject(()=>api('create_project',{name:(project?.name||'Projekt')+' · Entwurf',document:structuredClone(doc),allow_partial:true})));}
    catch(error){errorText=error.message;showState();}
  };

  window.metriccadSync={changed,flush,api,get project(){return project;},get conflict(){return conflict;}};
  (async()=>{
    busy=true;render();
    try{await session();await loadProject(new URLSearchParams(location.search).get('project'));files.markClean();}
    catch(error){errorText=error.message;showState();}
    finally{busy=false;render();setInterval(poll,1000);updateMCP();setInterval(updateMCP,3000);}
  })();
})();
