// A workspace owns editing state. Its parent owns navigation and the project file.
const host=parent.metricProject;
const workspaceNames={part:'Part Studio',assembly:'Baugruppe',drawing:'Zeichnung',visualizer:'Visualisierung'};
function menuButton(container,text,action){
  const button=document.createElement('button');
  button.textContent=text;button.onclick=action;container.append(button);return button;
}
const workspaceMenu=document.getElementById('workspace-menu');
for(const [kind,name] of Object.entries(workspaceNames))menuButton(workspaceMenu,name,()=>host.workspace(kind));
const overview=menuButton(document.querySelector('.cad-header'),'Projekt',()=>host.tree());
document.querySelector('.workspace-switch').after(overview);
for(const id of ['save','open','new','saveAs'])document.getElementById(id).onclick=()=>host.file(id);
const fileMenu=document.getElementById('file-menu');
menuButton(fileMenu,'In Projekt importieren …',()=>host.importFile());
menuButton(fileMenu,'Aktuelles Objekt exportieren …',()=>host.exportFile());
function registerEditor(options){
  window.projectEditor={snapshot:()=>doc,...options};
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
