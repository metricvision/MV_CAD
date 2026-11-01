/* Shared project state for Part Studio. Existing sketch tools remain native.
 * Draft pointer motion stays local; completed edits are committed with a
 * revision check. A remote change can never overwrite an uncommitted draft.
 */
(() => {
  'use strict';
  if (assemblyEditToken) return; // Assembly editor tabs use their explicit hand-off.
  let token = null, project = null, acknowledged = null;
  let applying = false, saving = null, loading = false, conflict = false, ready = false;
  let timer = null, listCounter = 0, polling = false, errorText = '';
  const bar = document.createElement('div');
  bar.id = 'sharedProjectBar';
  bar.innerHTML = '<label>Projekt <select id="sharedProjectSelect" aria-label="Projekt auswählen"></select></label><span id="sharedProjectState" role="status">Projekt wird geladen …</span><button id="sharedProjectReload" hidden>Serverstand laden</button><button id="sharedProjectFork" hidden>Entwurf als neues Projekt</button><button id="sharedProjectBackup" hidden>Entwurf herunterladen</button>';
  document.querySelector('main').before(bar);

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

  async function api(action, arguments_ = {}, retried = false) {
    if (!token) await session();
    const response = await fetch('/api', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-MetricCAD-Token': token},
      body: JSON.stringify({action, arguments: arguments_}), signal: AbortSignal.timeout(120000)
    });
    if (response.status === 403 && !retried) { await session(); return api(action, arguments_, true); }
    const result = await response.json();
    if (!response.ok) { const error = Error(result.error || 'Projekt konnte nicht synchronisiert werden.'); error.details = result.details; throw error; }
    return result;
  }

  function showState() {
    const badge = $('sharedProjectState');
    badge.className = conflict || errorText ? 'sync-error' : '';
    badge.textContent = conflict ? 'Gleichzeitige Änderung erkannt · dein Entwurf bleibt erhalten' :
      errorText || (!ready ? 'Projekt wird geladen …' : saving ? 'Wird gespeichert …' :
        unsaved() ? 'Lokaler Entwurf · noch nicht übernommen' : 'Synchron · Stand ' + project.revision + (project.pending_sketch ? ' · Skizzenbearbeitung' : ''));
    for (const id of ['sharedProjectReload', 'sharedProjectFork', 'sharedProjectBackup']) $(id).hidden = !conflict && !errorText;
    $('sharedProjectSelect').disabled = !ready || loading || !!saving || busy || geometrySaving;
  }

  async function refreshList() {
    const result = await api('list_projects');
    const select = $('sharedProjectSelect'), previous = project?.id;
    select.replaceChildren();
    for (const item of result.projects) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
      select.append(option);
    }
    if (previous) select.value = previous;
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
      window.history.replaceState(null,'','/?project='+encodeURIComponent(project.id));
      stash(); if (reset) fit(); render(); showState();
    } finally { applying = false; }
  }

  async function loadProject(id, reset = true) {
    loading=true;render();
    try { receive(await api('get_project_view',{project_id:id}), reset); await refreshList(); }
    finally { loading=false;render(); }
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
        const result=await api('replace_document',{project_id:project.id,expected_revision:revision,document:candidate,
          sketch_id:annotationOnly?null:sketchID,annotation_only:annotationOnly});
        if(snapshot()===sent && !editing()) receive(result);
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
    if (polling || loading || !ready || conflict || editing() || selecting() || saving) return;
    polling=true;
    try {
      if(unsaved()) { await flush();return; }
      const before=snapshot(), id=project.id;
      const result=await api('get_project',{project_id:id,include_document:false});
      if(result.project.revision!==project.revision) {
        const full=await api('get_project_view',{project_id:id});
        if(project.id===id && snapshot()===before && !editing() && !selecting() && !saving) {
          receive(full);status('Projekt aktualisiert · '+full.project.last_action);
        }
      }
      if(++listCounter%5===0) await refreshList();
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

  $('sharedProjectSelect').onchange=async e=>{
    const id=e.target.value;
    if(editing()||!(await flush())) {e.target.value=project.id;return;}
    try{await loadProject(id);}catch(error){errorText=error.message;showState();}
  };
  $('new').onclick=async()=>{
    if(editing()||!(await flush()))return;
    const name=prompt('Projektname','Neues Projekt');if(!name)return;
    try{const r=await api('create_project',{name});await loadProject(r.project.id);}catch(error){status(error.message,true);}
  };
  $('open').onclick=()=>{if(!editing())$('file').click();};
  $('file').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';if(!file||editing())return;
    if(!(await flush()))return;
    try{
      if(file.size>4_000_000)throw Error('Projektdatei größer als 4 MB.');
      const r=await api('create_project',{name:file.name.replace(/\.json$/i,''),document:JSON.parse(await file.text())});
      await loadProject(r.project.id);
    }catch(error){status(error.message,true);}
  };
  $('save').onclick=async()=>{
    if(!conflict)await flush();
    download(JSON.stringify(doc,null,2),'MetricCAD.json','application/json');
  };
  $('sharedProjectBackup').onclick=()=>download(JSON.stringify(doc,null,2),'MetricCAD-Entwurf.json','application/json');
  $('sharedProjectReload').onclick=async()=>{
    if(editing()||saving)return;
    if(unsaved()&&!confirm('Lokalen Entwurf verwerfen und den Serverstand laden? Du kannst den Entwurf zuvor herunterladen.'))return;
    try{await loadProject(project?.id||'default');}catch(error){errorText=error.message;showState();}
  };
  $('sharedProjectFork').onclick=async()=>{
    if(editing()||saving)return;
    try{const r=await api('create_project',{name:(project?.name||'Projekt')+' · Entwurf',document:structuredClone(doc)});await loadProject(r.project.id);}
    catch(error){errorText=error.message;showState();}
  };

  window.metriccadSync={changed,flush,api,get project(){return project;},get conflict(){return conflict;}};
  window.addEventListener('beforeunload',e=>{if(unsaved()||saving){e.preventDefault();e.returnValue='';}});
  (async()=>{
    busy=true;render();
    try{await session();const id=new URLSearchParams(location.search).get('project')||'default';await loadProject(id);}
    catch(error){errorText=error.message;showState();}
    finally{busy=false;render();setInterval(poll,1000);}
  })();
})();
