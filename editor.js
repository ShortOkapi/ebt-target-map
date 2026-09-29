/* Standalone editor. Leaflet and dataset operations are bundled in this file. */
(async function(){
'use strict';
const APP_VERSION='1.2.0-rc1';
const C=TargetCore, G=C.GRID, $=id=>document.getElementById(id);
document.title=`EBT Dot Safari · Target map editor · v${APP_VERSION}`;
$('draft-status').textContent=`Standalone editor · v${APP_VERSION}`;
$('help-app-version').textContent=`v${APP_VERSION}`;
let initial = null;
try {
  const response = await fetch('euro-use-master-map.json');
  if (!response.ok) throw new Error('Could not load euro-use-master-map.json');
  initial = await response.json();
} catch (error) {
  $('status').textContent = 'Error: The map data file could not be loaded. Please ensure euro-use-master-map.json exists.';
  $('status').classList.add('error');
  throw error; // Stop the script if the data is missing
}
const DRAFT_KEY='ebt-target-editor:euro-use:v1';
let overlayOpacity=.35, ready=false, importing=false;
let editor=new C.Editor(initial), selected=null, rows=new Map();
let exportedRevision=initial.revision, draftAvailable=false, recoveryError=false;
let storedData=editor.export();
let startingMap=captureStartingMap(initial);

function referenceDate(value){
  if(typeof value!=='string')return null;
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(value);
  if(!dateOnly&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;
  const date=new Date(dateOnly?value+'T00:00:00Z':value);
  if(!Number.isFinite(date.getTime()))return null;
  if(dateOnly)return date.toISOString().slice(0,10)===value?value:null;
  return date.toISOString();
}
function captureStartingMap(data){
  return {datasetId:data.datasetId,revision:data.revision,timestamp:referenceDate(data.updatedAt)||referenceDate(data.createdAt)};
}
function restoreStartingMap(value,data){
  if(!value||value.datasetId!==data.datasetId||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>data.revision)return null;
  return {datasetId:value.datasetId,revision:value.revision,timestamp:referenceDate(value.timestamp)};
}
function startingMapLabel(){
  if(!startingMap)return 'Starting map: not recorded in this older draft';
  const stamp=startingMap.timestamp;
  const date=stamp?(stamp.length===10?stamp:stamp.slice(0,16).replace('T',' ')+' UTC'):'date not recorded';
  return `Starting map: ${date} · revision ${startingMap.revision}`;
}
function showStartingMap(){$('starting-map').textContent=startingMapLabel();}
const regionDisplayOrder = [
  { id: 'workbook-11', name: 'Main European cluster' },
  { id: 'workbook-07', name: 'Finland & Baltic' },
  { id: 'workbook-08', name: 'Ireland' },
  { id: 'workbook-06', name: 'Azores, Madeira & Canaries' },
  { id: 'workbook-03', name: 'Cyprus' },
  { id: 'workbook-05', name: 'French Caribbean & Guiana' },
  { id: 'workbook-10', name: 'French Indian Ocean areas' },
  { id: 'workbook-02', name: 'St-Pierre & Miquelon' },
  { id: 'workbook-09', name: 'French Antarctic Ocean areas\u00A0\u00A0' },
  { id: 'workbook-04', name: 'Terre d’Adélie' },
  { id: 'workbook-01', name: 'Clipperton' }
];
const map=L.map('map',{center:[49,10],zoom:5,minZoom:2,maxZoom:18,zoomControl:true,worldCopyJump:false});
const osm=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,referrerPolicy:'strict-origin-when-cross-origin',attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'});
const esri=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community'});
let background=osm.addTo(map);
// The selected background always stays selected, even if tiles cannot load.
for(const sourceLayer of [osm,esri]){
  sourceLayer.on('tileerror',()=>{
    if(background!==sourceLayer)return;
    $('map-message').textContent='Some map imagery could not load. The grid, editing and exports still work. You can try another background above.';
    $('map-message').hidden=false;
  });
  sourceLayer.on('tileload',()=>{if(background===sourceLayer)$('map-message').hidden=true;});
}

function rebuildRows(){rows=new Map();for(const c of editor.cells.values()){if(!rows.has(c.i))rows.set(c.i,[]);rows.get(c.i).push(c);}}
rebuildRows();

// Crossed lines retain contrast at low opacity; zero still hides the overlay.
function drawExcludedHatch(ctx,r,size,opacity){
  if(opacity<=0)return;
  const left=Math.max(0,r[0]),top=Math.max(0,r[1]);
  const right=Math.min(size.x,r[0]+r[2]),bottom=Math.min(size.y,r[1]+r[3]);
  if(right<=left||bottom<=top)return;
  ctx.save();ctx.beginPath();ctx.rect(...r);ctx.clip();
  ctx.globalAlpha=Math.min(.9,.5+opacity*.4);
  ctx.beginPath();
  // Sixteen pixels divides the map tile size, keeping the mesh aligned.
  for(let k=Math.floor((left+top)/16)*16;k<=right+bottom;k+=16){
    ctx.moveTo(k-top,top);ctx.lineTo(k-bottom,bottom);
  }
  for(let k=Math.floor((left-bottom)/16)*16;k<=right-top;k+=16){
    ctx.moveTo(k+top,top);ctx.lineTo(k+bottom,bottom);
  }
  if(r[2]>=2&&r[3]>=2)ctx.rect(r[0]+.5,r[1]+.5,r[2]-1,r[3]-1);
  // A light edge keeps the dark lines visible over satellite imagery too.
  ctx.strokeStyle='rgba(255,255,255,.65)';ctx.lineWidth=3;ctx.stroke();
  ctx.strokeStyle='#30343b';ctx.lineWidth=1;ctx.stroke();
  ctx.restore();
}

// Intentionally keeps the v2.0.4 wrapped GridLayer geometry and anchors.
const TargetLayer=L.GridLayer.extend({createTile(coords){
  const canvas=document.createElement('canvas'), size=this.getTileSize(), dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=size.x*dpr;canvas.height=size.y*dpr;canvas.style.width=size.x+'px';canvas.style.height=size.y+'px';
  const ctx=canvas.getContext('2d');if(!ctx)return canvas;ctx.scale(dpr,dpr);
  const b=this._tileCoordsToBounds(coords),nw=map.project(b.getNorthWest(),coords.z);
  const i0=Math.floor((b.getSouth()-G.minLat)/G.dotH),i1=Math.floor((b.getNorth()-G.minLat)/G.dotH);
  const j0=Math.floor((b.getWest()-G.minLon)/G.dotW),j1=Math.floor((b.getEast()-G.minLon)/G.dotW);
  function rect(i,j){const x=map.project([G.minLat+(i+1)*G.dotH,G.minLon+j*G.dotW],coords.z).subtract(nw),y=map.project([G.minLat+i*G.dotH,G.minLon+(j+1)*G.dotW],coords.z).subtract(nw);return [x.x,x.y,y.x-x.x,y.y-x.y];}
  for(let i=i0;i<=i1;i++)for(const c of rows.get(i)||[]){
    if(c.j<j0||c.j>j1||c.classification==='unreviewed'||overlayOpacity===0)continue;
    const r=rect(i,c.j);ctx.fillStyle=C.CLASSES[c.classification].color;ctx.globalAlpha=overlayOpacity;ctx.fillRect(...r);ctx.globalAlpha=1;
    if(c.classification==='excluded')drawExcludedHatch(ctx,r,size,overlayOpacity);
    if(c.classification==='sea'){
      ctx.save();ctx.beginPath();ctx.rect(...r);ctx.clip();ctx.globalAlpha=Math.min(.85,overlayOpacity*1.8);ctx.strokeStyle='#28629C';ctx.lineWidth=1;
      for(let x=Math.floor((r[0]-r[3])/9)*9;x<r[0]+r[2];x+=9){ctx.beginPath();ctx.moveTo(x,r[1]+r[3]);ctx.lineTo(x+r[3],r[1]);ctx.stroke();}
      ctx.strokeRect(r[0]+.5,r[1]+.5,r[2]-1,r[3]-1);ctx.restore();
    }
  }
  if(coords.z>=6){
    ctx.strokeStyle='rgba(255, 0, 0, 0.4)';ctx.lineWidth=.7;
    for(let i=i0;i<=i1+1;i++){const p=map.project([G.minLat+i*G.dotH,b.getWest()],coords.z).subtract(nw);ctx.beginPath();ctx.moveTo(0,p.y);ctx.lineTo(size.x,p.y);ctx.stroke();}
    for(let j=j0;j<=j1+1;j++){const p=map.project([b.getNorth(),G.minLon+j*G.dotW],coords.z).subtract(nw);ctx.beginPath();ctx.moveTo(p.x,0);ctx.lineTo(p.x,size.y);ctx.stroke();}
  }
  if(coords.z>=8){
    ctx.fillStyle='#294252';ctx.font='11px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
    for(let i=i0;i<=i1;i++)for(let j=j0;j<=j1;j++){
      const r=rect(i,j);if(r[2]<60||r[3]<25)continue;
      const x=r[0]+r[2]/2,y=r[1]+r[3]/2;ctx.lineWidth=3;ctx.strokeStyle='#ffffffbb';ctx.strokeText(`${i}, ${j}`,x,y);ctx.fillText(`${i}, ${j}`,x,y);
    }
  }
  if(selected&&selected.i>=i0&&selected.i<=i1&&selected.j>=j0&&selected.j<=j1){
    const r=rect(selected.i,selected.j);ctx.strokeStyle='white';ctx.lineWidth=6;ctx.strokeRect(...r);ctx.strokeStyle='#113f63';ctx.lineWidth=3;ctx.strokeRect(...r);
  }
  return canvas;
}});
const layer=new TargetLayer({keepBuffer:1,updateWhenZooming:false,zIndex:10}).addTo(map);
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
let toastTimeout; function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>t.classList.remove('show'),4000);}
function add(parent,tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;parent.append(e);return e;}
function authorLabel(h){return h.actor?.name||'Author not recorded in this older file';}
function commentText(parent,text){
  let position=0;
  for(const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)){
    parent.append(document.createTextNode(text.slice(position,match.index)));
    const link=add(parent,'a',match[0]);link.href=match[0];link.target='_blank';link.rel='noopener noreferrer';position=match.index+match[0].length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}
function sourceRefs(i,j){
  const explicit=editor.cells.get(C.key(i,j))?.provenance;
  if(explicit?.length)return explicit;
  const refs=[];
  for(const s of editor.doc.sources){const b=s.bounds;if(i<=b.northRow&&i>=b.southRow&&j>=b.westColumn&&j<=b.eastColumn){let n=j-b.westColumn+2,col='';while(n){n--;col=String.fromCharCode(65+n%26)+col;n=Math.floor(n/26);}refs.push({sourceId:s.id,cell:col+(b.northRow-i+3),uncoloured:true});}}
  return refs;
}
function hasFormDraft(){return !!selected&&($('reason').value.trim()!==''\vert{}\vert{}$('classification').value!==editor.get(selected.i,selected.j));}
function leaveForm(){return !hasFormDraft()||confirm(`Discard the unsaved form for dot [${selected.i}, ${selected.j}]?`);}
function renderSelection(){
  if(!selected)return;
  const {i,j}=selected,classification=editor.get(i,j),meta=C.CLASSES[classification];
  $('dot-title').textContent=`[${i}, ${j}]`;$('current-class').replaceChildren();const sw=add($('current-class'),'span',undefined,'swatch');sw.style.background=meta.color;
      if(classification==='sea')sw.classList.add('sea-swatch');
      if(classification==='excluded')sw.classList.add('excluded-swatch');
      if(classification==='unreviewed')sw.classList.add('unreviewed-swatch');
      add($('current-class'),'span',meta.label);$('eligibility').textContent=classification==='eligible'?'Eligible as a Euro-use target when unconquered.':classification==='unreviewed'?'Unreviewed. Excluded from target eligibility until classified.':'Excluded from Euro-use target eligibility.';
  $('copy-info').textContent=selected.world?`Repeated world ${selected.world>0?'+':''}${selected.world}. This is the same stored dot.`:'One stored dot, shared by every repeated world.';
  const b=C.bounds(i,j);$('bounds').replaceChildren();add($('bounds'),'div',`Latitude ${b.south.toFixed(4)}° to ${b.north.toFixed(4)}°`);add($('bounds'),'div',`Longitude ${b.west.toFixed(4)}° to ${b.east.toFixed(4)}°`);
  $('classification').value=classification;$('reason').value='';$('save-change').textContent=`Save change for [${i}, ${j}]`;$('form-error').textContent='';$('source-info').replaceChildren();const refs=sourceRefs(i,j);
  if(!refs.length)add($('source-info'),'p','No source cell is recorded here. This dot starts as unreviewed.','muted');
  else{const list=add($('source-info'),'ul',undefined,'sources-list');for(const ref of refs){const source=editor.doc.sources.find(s=>s.id===ref.sourceId);add(list,'li',`${source.filename} · ${source.sheet}!${ref.cell}${ref.uncoloured?' (uncoloured in source)':''}`);}}
  $('history').replaceChildren();const history=C.visibleHistory(editor.doc.history.filter(h=>h.dot[0]===i&&h.dot[1]===j));$('history-count').textContent=history.length?`(${history.length})`:'';
  const undone=C.undoneHistoryIds(history);
  const latest=[...history].reverse().find(h=>h.action==='edit'&&!undone.has(h.id));$('saved-comment').replaceChildren();$('saved-comment-meta').textContent=latest?`${new Date(latest.at).toLocaleString('en-GB',{timeZone:'UTC'})} UTC · ${authorLabel(latest)}`:'';
  commentText($('saved-comment'),latest?latest.comment:history.length?'No current saved comment. Earlier comments are kept in the history below.':'No manual comment has been saved for this dot yet.');
  if(!history.length)add($('history'),'p','No manual changes yet. Imported classifications retain their workbook reference.','small muted');
  for(const h of [...history].reverse()){
    const author=authorLabel(h);
    const entry=add($('history'),'div',undefined,'history-entry');
    const metadata=add(entry,'div',`${new Date(h.at).toLocaleString('en-GB',{timeZone:'UTC'})} UTC · ${author} · ${h.action}`,'small muted');
    if(undone.has(h.id))add(metadata,'span','Undone','undone-badge');
    add(entry,'p',h.from===h.to?`Note added · ${C.CLASSES[h.to].label}`:`${C.CLASSES[h.from].label} → ${C.CLASSES[h.to].label}`,'small');commentText(add(entry,'p',undefined,'comment'),h.comment);
  }
  refreshSave();
}

function populateSources(){
  $('region').replaceChildren(new Option('Choose an area…',''));
  regionDisplayOrder.forEach(r => {
    if (editor.doc.sources.some(s => s.id === r.id)) {
      $('region').append(new Option(r.name, r.id));
    }
  });
  editor.doc.sources.forEach(s => {
    if (!regionDisplayOrder.some(r => r.id === s.id)) {
      $('region').append(new Option(s.filename, s.id));
    }
  });
  $('dataset-info').replaceChildren();add($('dataset-info'),'p',`Standalone editor · v${APP_VERSION}`);add($('dataset-info'),'p',`Dataset ${editor.doc.datasetId} · ${editor.doc.sources.length} source workbooks · ${editor.cells.size.toLocaleString('en-GB')} classified dots.`);
  add($('dataset-info'),'p',`Grid verified against PWA v${editor.doc.baseline?.appVersion||'2.0.4'}, commit ${editor.doc.baseline?.commit||'unrecorded'}.`);
  add($('dataset-info'),'p','Leaflet 1.9.4 © Vladimir Agafonkin and contributors (BSD-2-Clause). Editor code: MIT. Curated data provenance is retained in the JSON.');
}

const REPORT_CSS="\n*{box-sizing:border-box}body{font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#20394b;background:#f2f5f7;margin:0}main{max-width:1020px;margin:32px auto;padding:32px;background:white;border:1px solid #d5dfe5;border-radius:12px}h1{line-height:1.2;margin:10px 0}h2{font-size:21px;margin-top:30px}h3{font-size:17px}a{color:#076790;overflow-wrap:anywhere}nav{display:flex;gap:20px;flex-wrap:wrap;margin:20px 0}.meta{color:#526772;font-size:14px}.eyebrow{color:#536b7a;letter-spacing:.12em;font-size:12px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #dae3e8;vertical-align:top}th{background:#edf3f6}.scroll{overflow-x:auto}article{margin:24px 0;border-left:3px solid #d2dfe7;padding-left:18px;break-inside:avoid}.comment{white-space:pre-wrap;overflow-wrap:anywhere}.swatch{display:inline-block;width:13px;height:13px;margin-right:7px;border:1px solid #70828d;vertical-align:baseline}.excluded-swatch{background-image:repeating-linear-gradient(45deg,transparent 0,transparent 5px,#30343b 5px,#30343b 6px),repeating-linear-gradient(135deg,transparent 0,transparent 5px,#30343b 5px,#30343b 6px)!important}.sea-swatch{background-image:repeating-linear-gradient(135deg,transparent 0,transparent 4px,#28629c 4px,#28629c 5px)!important}.unreviewed-swatch{background:transparent!important;border:1.5px dashed #758794!important}.undone-badge{display:inline-block;margin-left:7px;padding:1px 7px;border:1px solid #b8c6cf;border-radius:4px;background:#edf2f5;color:#354e5e;font-size:12px;font-weight:650;vertical-align:middle;white-space:nowrap}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:30px}.section-heading h2{margin:0}.back-to-contents{display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:4px 0;font-size:14px;white-space:nowrap}.back-to-contents:focus-visible{outline:3px solid #087baa;outline-offset:3px;border-radius:2px}@media print{.back-to-contents{display:none}.section-heading{display:block}}.callout{background:#edf4f6;padding:14px 18px;border-radius:6px}footer{border-top:1px solid #d5dfe5;margin-top:32px;padding-top:15px}.print{border:1px solid #bfd0dc;background:#17354b;color:white;border-radius:5px;padding:9px 14px;cursor:pointer;font:inherit}@media(max-width:600px){main{margin:0;padding:18px;border:0;border-radius:0}th,td{padding:9px 6px}}@media print{body{background:white;font-size:11pt}main{margin:0;max-width:none;padding:0;border:0}nav,.print{display:none}a{color:inherit;text-decoration:none}thead{display:table-header-group}@page{size:A4;margin:18mm}}\n\n.sortable th{padding:0}.sort-button{width:100%;border:0;background:transparent;color:inherit;font:inherit;font-weight:650;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;padding:12px 10px;min-height:44px}.sort-button:hover{background:#dce9f0}.sort-button:focus-visible{outline:3px solid #087baa;outline-offset:-3px}.sort-mark{font-size:12px;color:#526f83;flex-shrink:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:600px){.sort-button{padding:9px 6px;gap:6px}}@media print{.sort-mark,.sort-help{display:none}.sort-button{padding:9px 6px;color:inherit}.sort-button:hover{background:transparent}}\n";
const REPORT_SCRIPT="\n(function(){\n 'use strict';\n const collator=new Intl.Collator('en',{numeric:true,sensitivity:'base'});\n for(const table of document.querySelectorAll('table.sortable')){\n  const headers=[...table.tHead.rows[0].cells],body=table.tBodies[0];\n  let active=-1,direction=1;\n  function value(row,column){\n   const cell=row.cells[column],text=cell.dataset.sort||cell.textContent.trim();\n   switch(headers[column].dataset.type){\n    case 'dot':return text.split(',').map(Number);\n    case 'date':return Date.parse(text);\n    default:return text;\n   }\n  }\n  function sort(column,nextDirection,announce=true){\n   active=column;direction=nextDirection;\n   const rows=[...body.rows],kind=headers[column].dataset.type;\n   rows.sort((a,b)=>{\n    const left=value(a,column),right=value(b,column);\n    const result=kind==='dot'?(left[0]-right[0]||left[1]-right[1]):kind==='date'?left-right:collator.compare(left,right);\n    return result?direction*result:Number(a.dataset.order)-Number(b.dataset.order);\n   });\n   body.append(...rows);\n   headers.forEach((header,index)=>{\n    const button=header.querySelector('button'),label=header.querySelector('.sort-label').textContent;\n    if(index===active)header.setAttribute('aria-sort',direction===1?'ascending':'descending');else header.removeAttribute('aria-sort');\n    header.querySelector('.sort-mark').textContent=index===active?(direction===1?'▲':'▼'):'↕';\n    const next=index===active&&direction===1?'descending':'ascending';\n    button.setAttribute('aria-label',`Sort by ${label}, ${next}`);\n    button.title=`Sort by ${label}; click again to reverse`;\n   });\n   if(announce)document.getElementById('sort-status').textContent=`${table.getAttribute('aria-label')} sorted by ${headers[column].querySelector('.sort-label').textContent}, ${direction===1?'ascending':'descending'}.`;\n  }\n  headers.forEach((header,column)=>header.querySelector('button').addEventListener('click',()=>sort(column,active===column?-direction:1)));\n  if(table.id==='summary-table')sort(1,1,false);else sort(0,-1,false);\n }\n})();\n";
function escapeHTML(value){
  return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
}
function linkedComment(text){
  let position=0,html='';
  for(const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)){
    html+=escapeHTML(text.slice(position,match.index));
    const url=escapeHTML(match[0]);
    html+=`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    position=match.index+match[0].length;
  }
  return html+escapeHTML(text.slice(position));
}
function buildReport(data){
  const history=C.visibleHistory(data.history),undone=C.undoneHistoryIds(data.history),first=new Map();
  const undoneBadge=h=>undone.has(h.id)?'<span class="undone-badge">Undone</span>':'';
  const cells=new Map(data.cells.map(c=>[C.key(c.i,c.j),c.classification]));
  for(const h of history){
    const key=C.key(...h.dot);
    if(!first.has(key))first.set(key,h);
  }
  const decisions=[...first.values()].map(h=>({dot:h.dot,from:h.from,to:cells.get(C.key(...h.dot))||'unreviewed'}));
  const changed=decisions.filter(d=>d.from!==d.to).length;
  const editors=new Set(history.map(h=>h.actor?.name).filter(Boolean)).size;
  const eligible=data.cells.filter(c=>c.classification==='eligible').length;
  const count=n=>n.toLocaleString('en-GB');
  
  const regionNames={'workbook-11':'Main European cluster','workbook-07':'Finland & Baltic','workbook-08':'Ireland','workbook-06':'Azores, Madeira & Canaries','workbook-03':'Cyprus','workbook-05':'French Caribbean & Guiana','workbook-10':'French Indian Ocean areas','workbook-02':'St-Pierre & Miquelon','workbook-09':'French Antarctic Ocean areas','workbook-04':'Terre d’Adélie','workbook-01':'Clipperton'};
  const stats=Object.fromEntries(data.sources.map(s=>[s.id,{name:regionNames[s.id]||s.filename,eligible:0,excluded:0}]));
  for(const c of data.cells)if((c.classification==='eligible'||c.classification==='excluded')&&c.provenance?.[0]?.sourceId)stats[c.provenance[0].sourceId][c.classification]++;
  let tEligible=0,tExcluded=0,statsHTML='';
  for(const id of Object.keys(regionNames)){
    if(!stats[id])continue;
    tEligible+=stats[id].eligible;tExcluded+=stats[id].excluded;
    statsHTML+=`<tr><td>${escapeHTML(stats[id].name)}</td><td>${count(stats[id].eligible)}</td><td>${count(stats[id].excluded)}</td><td>${count(stats[id].eligible+stats[id].excluded)}</td></tr>`;
  }
  statsHTML+=`<tr style="font-weight: 650; background: #edf3f6;"><td>Total</td><td>${count(tEligible)}</td><td>${count(tExcluded)}</td><td>${count(tEligible+tExcluded)}</td></tr>`;

  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const when=h=>formatter.format(new Date(h.at)).replace(' at ', ', ')+' UTC';
  const description=h=>{
    const decision=h.from===h.to?'Comment added; classification unchanged':`${C.CLASSES[h.from].label} → ${C.CLASSES[h.to].label}`;
    return h.action==='edit'?decision:`${h.action==='undo'?'Undo':'Redo'}: ${decision}`;
  };
  const heading=(label,type)=>`<th scope="col" data-type="${type}"><button class="sort-button" type="button"><span class="sort-label">${label}</span><span class="sort-mark" aria-hidden="true">↕</span></button></th>`;
  const decisionsHTML=decisions.map((d,index)=>`<tr data-order="${index}"><td data-sort="${d.dot.join(',')}">[${d.dot.join(', ')}]</td><td>${C.CLASSES[d.from].label}</td><td><span class="swatch${d.to==='excluded'?' excluded-swatch':d.to==='unreviewed'?' unreviewed-swatch':d.to==='sea'?' sea-swatch':''}" style="background:${C.CLASSES[d.to].color}"></span>${C.CLASSES[d.to].label}</td></tr>`).join('');
  const summaryHTML=history.map((h,index)=>`<tr data-order="${index}"><td data-sort="${h.dot.join(',')}"><a href="#entry-${index+1}">[${h.dot.join(', ')}]</a></td><td data-sort="${escapeHTML(h.at)}">${escapeHTML(when(h))}</td><td>${escapeHTML(authorLabel(h))}</td><td>${escapeHTML(description(h))}${undoneBadge(h)}</td></tr>`).join('');
  const commentsHTML=history.map((h,index)=>`<article id="entry-${index+1}"><h3>${index+1}. [${h.dot.join(', ')}] — ${escapeHTML(description(h))}${undoneBadge(h)}</h3><p class="meta">${escapeHTML(when(h))} · ${escapeHTML(authorLabel(h))}</p><div class="comment">${linkedComment(h.comment)}</div></article>`).join('');
  return `<!doctype html><html lang="en">
<!-- Bundled Leaflet 1.9.4 licence:
BSD 2-Clause License

Copyright (c) 2010-2023, Volodymyr Agafonkin
Copyright (c) 2010-2011, CloudMade
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

--><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EBT Dot Safari — saved changes, revision ${data.revision}</title><style>${REPORT_CSS}</style></head><body><main><div class="eyebrow">EBT DOT SAFARI</div><h1>Saved map changes</h1><p class="meta">${escapeHTML(startingMapLabel())}<br>Current map revision: ${data.revision}<br>History times are shown in UTC.</p><p class="callout"><strong>${count(changed)} changed ${changed===1?'dot':'dots'} · ${count(history.length)} saved ${history.length===1?'entry':'entries'} · ${count(editors)} ${editors===1?'editor':'editors'} · ${count(eligible)} eligible dots</strong></p><nav id="contents" aria-label="Report contents" tabindex="-1"><a href="#area-summary">Area summary</a><a href="#current">Current decisions</a><a href="#summary">History log</a><a href="#comments">Full comments</a></nav><button class="print" onclick="window.print()">Print / Save as PDF</button><div class="section-heading"><h2 id="area-summary">Area summary</h2><a class="back-to-contents" href="#contents"><span aria-hidden="true">↑</span>Back to contents</a></div><p class="meta">Total Conquerable and Unconquerable Euro land dots per area.</p><div class="scroll"><table aria-label="Area summary"><thead><tr><th>Area</th><th>Conquerable</th><th>Unconquerable</th><th>Total Euro land</th></tr></thead><tbody>${statsHTML}</tbody></table></div><div class="section-heading"><h2 id="current">Current decisions</h2><a class="back-to-contents" href="#contents"><span aria-hidden="true">↑</span>Back to contents</a></div><p class="meta">Click any column heading to sort these decisions.</p>${!decisions.length?'<p>No manual decisions have been saved in this map yet.</p>':''}<div class="scroll"><table id="current-table" class="sortable" aria-label="Current decisions"><thead><tr>${heading('Dot','dot')}${heading('Original classification','text')}${heading('Saved classification','text')}</tr></thead><tbody>${decisionsHTML}</tbody></table></div><div class="section-heading"><h2 id="summary">Summary</h2><a class="back-to-contents" href="#contents"><span aria-hidden="true">↑</span>Back to contents</a></div><p>Click a column heading to sort; click it again to reverse the order. Click a dot to read its full comment.</p><div class="scroll"><table id="summary-table" class="sortable" aria-label="Summary"><thead><tr>${heading('Dot','dot')}${heading('When','date')}${heading('Editor','text')}${heading('What was saved','text')}</tr></thead><tbody>${summaryHTML}</tbody></table></div><div class="section-heading"><h2 id="comments">Full comments</h2><a class="back-to-contents" href="#contents"><span aria-hidden="true">↑</span>Back to contents</a></div><p class="meta">Saved comments, with repeated saves shown only once. Edits and Redo steps labelled Undone have been reversed; Undo and Redo entries keep the full sequence. Current decisions above show the saved classifications.</p>${commentsHTML}<footer class="meta">Change report for Miguel / lmviterbo. Use Save Map File in the editor to keep or move the complete working map. This report does not update the public Dot Safari app.</footer><p id="sort-status" class="sr-only" role="status" aria-live="polite"></p></main><script>${REPORT_SCRIPT}</scr`+'ipt></body></html>';
}

function currentActor(){return {id:'local',name:$('local-author').value.trim(),authentication:'local'};}
function canEdit(){return !importing&&!recoveryError;}
function clearNameError(){
  $('local-author').removeAttribute('aria-invalid');
  $('editor-name-error').hidden=true;$('editor-name-error').textContent='';
}
function closeDialogs(){
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
}
function requireEditorName(){
  if(currentActor().name){clearNameError();return true;}
  closeDialogs();
  const field=$('local-author');field.setAttribute('aria-invalid','true');$('editor-name-error').textContent='Please enter your name before saving or sharing. Your comment has been kept.';
  $('editor-name-error').hidden=false;
  field.focus();field.scrollIntoView({block:'nearest'});
  return false;
}
function readyToExport(){
  if(importing||!requireEditorName())return false;
  if(hasFormDraft()){
    closeDialogs();
    $('form-error').textContent='Save or clear the unfinished form before saving or sharing this file. Your comment has been kept.';
    $('reason').focus();return false;
  }
  return true;
}
function refreshSave(){
  const actor=currentActor();
  const duplicate=!!actor.name&&selected&&editor.duplicate(selected.i,selected.j,$('classification').value,$('reason').value,actor);
  // A missing name is explained when Save change is clicked.
  $('save-change').disabled=!canEdit()\vert{}\vert{}!selected\vert{}\vert{}!$('reason').value.trim()||duplicate;
  $('save-change').title=duplicate?'This classification and comment are already saved.':'';$('classification').disabled=importing||recoveryError;
  $('reason').disabled=importing||recoveryError;
}
function refreshButtons(){
  $('undo').disabled=!canEdit()||!editor.undoStack.length;
  $('redo').disabled=!canEdit()||!editor.redoStack.length;
  $('open-file').disabled=importing;
}
function refreshDraftStatus(){
  $('draft-status').classList.toggle('error',!draftAvailable||recoveryError);
  if(recoveryError){$('draft-status').textContent='Saved browser draft needs attention';return;}
  if(!draftAvailable){$('draft-status').textContent='Browser saving unavailable — use Save Map File before closing';return;}$('draft-status').textContent=`Draft saved in this browser${hasFormDraft()?' · Unfinished form retained':''}`;
}
function refresh(){
  $('eligible-count').textContent=[...editor.cells.values()].filter(c=>c.classification==='eligible').length.toLocaleString('en-GB');$('changed-count').textContent=`(${C.visibleHistory(editor.doc.history).length})`;
  refreshButtons();refreshSave();refreshDraftStatus();rebuildRows();layer.redraw();
}
function persist(dataChanged=false){
  if(!ready||recoveryError)return false;
  try{
    if(dataChanged)storedData=editor.export();
    // Keep an unfinished form separate from confirmed JSON history.
    const pendingForm=hasFormDraft()?{dot:[selected.i,selected.j],classification:$('classification').value,reason:$('reason').value}:null;
    localStorage.setItem(DRAFT_KEY,JSON.stringify({
      data:storedData,exportedRevision,startingMap,author:$('local-author').value,
      center:[map.getCenter().lat,map.getCenter().lng],zoom:map.getZoom(),
      selected,pendingForm,basemap:$('basemap').value,overlayOpacity
    }));
    draftAvailable=true;refreshDraftStatus();return true;
  }catch(error){
    draftAvailable=false;refreshDraftStatus();
    status('The browser could not save this draft. Confirm any unfinished comment with Save change, then use Save Map File before closing.',true);
    return false;
  }
}
function selectDot(dot,pan=false){
  if(!leaveForm())return false;
  selected=dot;renderSelection();layer.redraw();
  if(pan){const b=C.bounds(dot.i,dot.j);map.setView([(b.north+b.south)/2,(Math.max(-180,b.west)+Math.min(180,b.east))/2+(dot.world||0)*360],Math.max(map.getZoom(),8));}
  persist();return true;
}
function setBackground(value){
  if(background)map.removeLayer(background);
  background=({osm,esri})[value]||null;
  $('basemap').value=background?value:'none';$('map-message').hidden=true;
  if(background)background.addTo(map);
}
function exportFilename(base,extension){
  const iso=new Date().toISOString();
  // Filename times are UTC, with minute precision and no timezone suffix.
  const stamp=iso.slice(0,10).replace(/-/g,'')+'-'+iso.slice(11,16).replace(':','');
  const prefix=`${base}-r${editor.doc.revision}-`,suffix=`-${stamp}.${extension}`;
  const name=currentActor().name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');
  const encoder=new TextEncoder(),limit=255-encoder.encode(prefix+suffix).length;
  const parts=typeof Intl.Segmenter==='function'
    ?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(name),part=>part.segment)
    :Array.from(name);
  let safeName='',bytes=0;
  for(const part of parts){
    const size=encoder.encode(part).length;if(bytes+size>limit)break;
    safeName+=part;bytes+=size;
  }
  return prefix+(safeName||'editor')+suffix;
}
function download(data,name){
  const type=name.endsWith('.html')?'text/html;charset=utf-8':'application/json;charset=utf-8';
  const blob=new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)+'\n'],{type});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function exportDataset(){
  if(!readyToExport())return;
  if(editor.doc.revision === exportedRevision) {
    showToast('No new changes to save. The map file is already up to date.');
    return;
  }
  try{
    const data=editor.export();download(data,exportFilename('euro-use-targets','json'));
    exportedRevision=data.revision;
    if(persist())status('Map file download requested. This copy keeps your map, comments, names and history.');
  }catch(error){status(`Could not save the map file: ${error.message}`,true);}
}
let sharingReport=false;
function prepareChangeReport(){
  const html=buildReport(editor.export()),name=exportFilename('EBT-map-change-report','html');
  let file=null;
  // File creation is optional: downloading must work without file sharing.
  if(typeof File==='function'){
    try{file=new File([html],name,{type:'text/html'});}
    catch(error){/* Keep the HTML download available. */}
  }
  return {html,name,file};
}
function canShareReport(report){
  if(!report.file||!window.isSecureContext||typeof navigator.share!=='function'||typeof navigator.canShare!=='function')return false;
  try{return navigator.canShare({files:[report.file]});}
  catch(error){return false;}
}
function reportMessage(message,error=false){
  const element=$('report-message');
  element.textContent=message;element.hidden=!message;element.classList.toggle('error',error);
}
function reportSharingAvailable(available){
  $('share-summary').hidden=!available;
  $('export-summary').classList.toggle('primary',!available);$('report-share-note').textContent=available
    ?'Choose an app in your device’s sharing menu, then select Miguel / lmviterbo as the recipient. Available apps depend on your device.'
    :'Direct sharing of this HTML report is unavailable here. Use Save Change Report, then attach the downloaded file to a message for Miguel / lmviterbo.';
}
async function shareChangeReport(){
  if(sharingReport||!readyToExport())return;
  reportMessage('');
  try{
    const report=prepareChangeReport();
    const available=canShareReport(report);reportSharingAvailable(available);
    if(!available)return;
    sharingReport=true;$('share-summary').disabled=true;$('export-summary').disabled=true;
    $('share-summary').textContent='Opening sharing menu…';
    // Call share directly during the click, before any asynchronous work.
    await navigator.share({files:[report.file]});
    reportMessage('Report sharing requested.');
  }catch(error){
    // Cancellation must not show an error or trigger a download.
    if(error?.name!=='AbortError'){
      reportMessage('Could not share the report. Use Save Change Report, then attach the downloaded file to your message.',true);
    }
  }finally{
    sharingReport=false;$('share-summary').disabled=false;$('export-summary').disabled=false;
    $('share-summary').textContent='Share Change Report';
  }
}
function review(){
  try{
    const frame=document.createElement('iframe');
    frame.title='Saved map changes — readable HTML report';
    frame.style.cssText='display:block;width:100%;height:52vh;min-height:300px;border:1px solid #ced8de;border-radius:6px;margin:16px 0;background:white';
    frame.setAttribute('sandbox','allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox');
    const report=prepareChangeReport();
    // A srcdoc document otherwise inherits the editor URL as its link base.
    // Only the embedded preview needs this base; downloaded/shared files do not.
    frame.srcdoc=report.html.replace('<head>','<head><base href="about:srcdoc">');
    reportSharingAvailable(canShareReport(report));reportMessage('');
    $('review-content').replaceChildren(frame);$('review-dialog').showModal();
  }catch(error){status(`Could not prepare the history report: ${error.message}`,true);}
}
for(const [value,meta] of Object.entries(C.CLASSES)){
  $('classification').append(new Option(`${meta.label} — ${meta.color}`,value));
  const label=add($('legend-items'),'span'),sw=add(label,'span',undefined,'swatch');
  sw.style.background=meta.color;
  add(label,'span',({eligible:'Conquerable',excluded:'Unconquerable',foreign:'Foreign',sea:'Sea',unreviewed:'Unreviewed'})[value]);
  if(value==='sea')sw.classList.add('sea-swatch');
  if(value==='excluded')sw.classList.add('excluded-swatch');
  if(value==='unreviewed')sw.classList.add('unreviewed-swatch');
}
$('reason').addEventListener('input',()=>{refreshSave();persist();});
$('classification').addEventListener('change',()=>{refreshSave();persist();});$('local-author').addEventListener('input',()=>{
  if(currentActor().name)clearNameError();
  refreshSave();refreshButtons();persist();
});
$('edit-form').addEventListener('submit',event=>{   event.preventDefault();if(!selected\vert{}\vert{}!canEdit()\vert{}\vert{}$('save-change').disabled)return;
  if(!requireEditorName())return;
  try{
    editor.actor=currentActor();
    const entry=editor.change(selected.i,selected.j,$('classification').value,$('reason').value);
    renderSelection();
    const saved=persist(true);refresh();
    if(saved)status(`Saved ${C.CLASSES[entry.to].label.toLowerCase()} for [${selected.i}, ${selected.j}] · ${entry.actor.name}.`);
  }catch(error){$('form-error').textContent=error.message;}
});
$('search-form').addEventListener('submit',event=>{
  event.preventDefault();
  try{
    const dot=C.parseDot($('dot-search').value);
    if(selectDot(dot,true)&&draftAvailable)status(dot.enteredJ===dot.j?`Selected [${dot.i}, ${dot.j}].`:`[${dot.i}, ${dot.enteredJ}] opens the stored dot [${dot.i}, ${dot.j}].`);
  }catch(error){status(error.message,true);}
});
map.on('click',event=>{
  try{const dot=C.atLatLng(event.latlng.lat,event.latlng.lng);dot.world=Math.floor((event.latlng.lng+180)/360);selectDot(dot);}
  catch(error){status(error.message,true);}
});
$('region').addEventListener('change',()=>{
  const source=editor.doc.sources.find(s=>s.id===$('region').value);if(!source)return;
  const b=source.bounds,a=C.bounds(b.southRow,b.westColumn),z=C.bounds(b.northRow,b.eastColumn);
  map.fitBounds([[Math.max(-85,a.south),a.west],[Math.min(85,z.north),z.east]],{padding:[25,25],maxZoom:9});
});
$('basemap').addEventListener('change',()=>{setBackground($('basemap').value);persist();});$('overlay-opacity').oninput=()=>{
  overlayOpacity=Number($('overlay-opacity').value)/100;
  $('opacity-value').textContent=`${Math.round(overlayOpacity*100)}%`;layer.redraw();persist();
};
for(const action of ['undo','redo'])$(action).onclick=()=>{
  if(!canEdit()||!requireEditorName()||!leaveForm())return;
  try{
    editor.actor=currentActor();const entry=editor[action]();if(!entry)return;
    selected={i:entry.dot[0],j:entry.dot[1],world:selected?.world||0};
    renderSelection();const saved=persist(true);refresh();
    if(saved)status(`${action==='undo'?'Undid':'Redid'} change for [${entry.dot.join(', ')}] · ${editor.actor.name}.`);
  }catch(error){status(error.message,true);}
};
$('review').onclick=review;
$('export-file').onclick=exportDataset;

$('publish-map').onclick = async () => {
  if (!readyToExport()) return;
  if (editor.doc.revision === exportedRevision) {
    showToast('No new changes to publish. The live map is already up to date.');
    return;
  }
  const token = prompt("Enter your GitHub Personal Access Token to publish to the live site:");
  if (!token) return;

  status("Publishing to GitHub...");
  try {
    const repo = 'ShortOkapi/ebt-target-maps';
    const path = 'euro-use-master-map.json';

    // 1. Find the exact file currently on GitHub so we can safely overwrite it
    let sha = '';
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=main`);
    if (getRes.ok) sha = (await getRes.json()).sha;

    // 2. Prepare the new data securely
    const data = editor.export();
    const contentStr = JSON.stringify(data, null, 2) + '\n';
    const reader = new FileReader();

    reader.onloadend = async () => {
      const base64Content = reader.result.split(',')[1];

      // 3. Upload the new file to your main branch
      const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Publish map revision ${data.revision} from editor`,
          content: base64Content,
          sha: sha || undefined,
          branch: 'main'
        })
      });

      if (!putRes.ok) throw new Error('Upload refused. Your GitHub token has likely expired. Time to generate a new token in GitHub Settings and update your saved copy!');

      // 4. Trigger the local backup download
      download(data, exportFilename('euro-use-targets', 'json'));
      exportedRevision = data.revision;
      if (persist()) status(`Map published successfully to the live site, and local backup saved!`);
    };
    reader.readAsDataURL(new Blob([contentStr], {type: 'application/json'}));

  } catch (error) {
    status(`Publishing error: ${error.message}`, true);
  }
};
$('export-from-review').onclick=exportDataset;
$('share-summary').onclick=shareChangeReport;
$('export-summary').onclick=()=>{
  if(sharingReport||!readyToExport())return;
  try{
    const report=prepareChangeReport();download(report.html,report.name);
    reportMessage('Report download requested. Attach the downloaded HTML file to your message for Miguel / lmviterbo.');
  }catch(error){reportMessage(`Could not save the change report: ${error.message}`,true);}
};
$('export-ranges').onclick=()=>{
  if(!readyToExport())return;
  try{download(C.compact(editor.export()),exportFilename('euro-use-eligibility','json'));}
  catch(error){status(`Could not save eligibility data: ${error.message}`,true);}
};
$('help-button').onclick=()=>$('help-dialog').showModal();
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$(button.dataset.close).close();$('open-file').onclick=()=>$('file-input').click();$('file-input').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file||importing)return;
  importing=true;refreshSave();refreshButtons();
  try{
    if(file.size>25*1024*1024)throw Error('This file exceeds the 25 MB editable-dataset limit.');
    const next=new C.Editor(JSON.parse(await file.text()));
    if((editor.doc.revision!==exportedRevision||hasFormDraft()||recoveryError)&&!confirm('Open this map file and replace the current browser draft, including any unfinished form? Use Save Map File first if you want to keep a separate copy of your current work.'))return;
    editor=next;storedData=editor.export();exportedRevision=editor.doc.revision;
    startingMap=captureStartingMap(editor.doc);showStartingMap();
    recoveryError=false;$('recovery').hidden=true;selected={i:458,j:403,world:0};
    populateSources();renderSelection();
    if(persist())status(`Opened ${file.name}. Your saved map and history have been retained.`);
  }catch(error){status(`Could not open that map file: ${error.message} Your current map is unchanged.`,true);}
  finally{importing=false;refresh();}
});
$('discard-draft').onclick=()=>{
  if(!confirm(`Discard the unreadable browser draft and start from the bundled revision-${initial.revision} dataset?`))return;
  try{localStorage.removeItem(DRAFT_KEY);}
  catch(error){status('The browser could not discard the draft. You can still open a saved map file.',true);return;}
  recoveryError=false;$('recovery').hidden=true;
  startingMap=captureStartingMap(initial);showStartingMap();
  if(persist())status(`Using the bundled revision-${initial.revision} dataset.`);refresh();
};

// Restore both old editor drafts and this standalone editor's working draft.
let recovered=null,rawDraft=null;
try{
  rawDraft=localStorage.getItem(DRAFT_KEY);
  if(rawDraft){
    const candidate=JSON.parse(rawDraft),next=new C.Editor(candidate.data);
    editor=next;storedData=editor.export();recovered=candidate;
    startingMap=restoreStartingMap(candidate.startingMap,editor.doc);
    exportedRevision=Number.isSafeInteger(candidate.exportedRevision)&&candidate.exportedRevision>=0?candidate.exportedRevision:0;
  }
}catch(error){
  recoveryError=!!rawDraft;
  if(recoveryError){$('recovery').hidden=false;status('The saved browser draft could not be read. It has been kept unchanged. Open a saved map file or use Discard unreadable draft.',true);}
}
try{
  $('local-author').value=typeof recovered?.author==='string'?recovered.author:localStorage.getItem('ebt-editor-local-author')||'';
  const oldOpacity=localStorage.getItem('ebt-editor-opacity');
  const alpha=Number.isFinite(recovered?.overlayOpacity)?recovered.overlayOpacity:oldOpacity!==null?Number(oldOpacity):.35;
  if(Number.isFinite(alpha)&&alpha>=0&&alpha<=1)overlayOpacity=alpha;
}catch(error){if(typeof recovered?.author==='string')$('local-author').value=recovered.author;}
$('overlay-opacity').value=overlayOpacity*100;$('opacity-value').textContent=`${Math.round(overlayOpacity*100)}%`;
if(['osm','esri','none'].includes(recovered?.basemap))setBackground(recovered.basemap);
function validSelection(dot){
  return dot&&Number.isSafeInteger(dot.i)&&dot.i>=G.minRow&&dot.i<=G.maxRow&&Number.isSafeInteger(dot.j)&&dot.j>=G.minColumn&&dot.j<=G.maxColumn;
}
selected=validSelection(recovered?.selected)?{i:recovered.selected.i,j:recovered.selected.j,world:Number.isSafeInteger(recovered.selected.world)?recovered.selected.world:0}:{i:458,j:403,world:0};
showStartingMap();populateSources();renderSelection();
if(Array.isArray(recovered?.center)&&recovered.center.length===2&&recovered.center.every(Number.isFinite)&&Math.abs(recovered.center[0])<=90&&Number.isFinite(recovered.zoom)&&recovered.zoom>=2&&recovered.zoom<=18)map.setView(recovered.center,recovered.zoom);
const pending=recovered?.pendingForm;
if(pending&&Array.isArray(pending.dot)&&pending.dot[0]===selected.i&&pending.dot[1]===selected.j&&Object.hasOwn(C.CLASSES,pending.classification)&&typeof pending.reason==='string'){
  $('classification').value=pending.classification;$('reason').value=pending.reason;
}
ready=true;
if(persist())status(recovered?'Restored your browser draft, including any unfinished form.':`Euro-use revision ${editor.doc.revision} ready. Enter your Editor Name to save changes.`);
refresh();
map.on('moveend',()=>persist());
window.addEventListener('pagehide',()=>persist());
window.addEventListener('beforeunload',event=>{
  if(!draftAvailable&&!recoveryError&&(editor.doc.revision!==exportedRevision||hasFormDraft())){event.preventDefault();event.returnValue='';}
});
new ResizeObserver(()=>map.invalidateSize()).observe($('map'));
// Read-only inspection bridge, retained for checking the release candidate.
window.TargetEditor=Object.freeze({getData:()=>editor.export(),getSelected:()=>({...selected}),map,layer});
})();