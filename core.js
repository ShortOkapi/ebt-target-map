/* MIT. Shared, DOM-free target dataset operations. No geographic renumbering. */
(function (root) {
  'use strict';
  const GRID = Object.freeze({id:'ebt-dot-safari-legacy-v1',dotH:0.28,dotW:66/157,minLat:-89.72,minLon:-(178+140/157),longitudeWrap:360,minColumn:-3,maxColumn:853,minRow:0,maxRow:641});
  const CLASSES = Object.freeze({
    eligible:{label:'Conquerable Euro land',color:'#F1A983'},
    excluded:{label:'Unconquerable Euro land',color:'#737373'},
    sea:{label:'Water Only',color:'#AAD3DF'},
    foreign:{label:'Foreign land',color:'#FF0000'},
    unreviewed:{label:'Unreviewed',color:'#FFFFFF'}
  });
  const key = (i,j) => `${i}_${j}`;
  const clone = x => JSON.parse(JSON.stringify(x));
  const compare = (a,b) => a.i-b.i || a.j-b.j;
  const canonicalLongitude = lon => ((lon+180)%360+360)%360-180;
  const inBounds = (i,j) => Number.isSafeInteger(i) && Number.isSafeInteger(j) && i>=GRID.minRow && i<=GRID.maxRow && j>=GRID.minColumn && j<=GRID.maxColumn;
  function atLatLng(lat,lon) {
    const i=Math.floor((lat-GRID.minLat)/GRID.dotH);
    const j=Math.floor((canonicalLongitude(lon)-GRID.minLon)/GRID.dotW);
    if (!inBounds(i,j)) throw Error('This position is outside the legacy grid.');
    return {i,j};
  }
  function bounds(i,j) {
    return {south:GRID.minLat+i*GRID.dotH,north:GRID.minLat+(i+1)*GRID.dotH,
            west:GRID.minLon+j*GRID.dotW,east:GRID.minLon+(j+1)*GRID.dotW};
  }
  function parseDot(text) {
    const m=String(text).trim().match(/^\[?\s*(-?\d+)\s*[,;_]\s*(-?\d+)\s*\]?$/);
    if(!m) throw Error('Enter a dot such as [458, 403].');
    const i=Number(m[1]), enteredJ=Number(m[2]);
    if(!Number.isSafeInteger(i)||!Number.isSafeInteger(enteredJ)||i<GRID.minRow||i>GRID.maxRow) throw Error('Dot index is outside the legacy grid.');
    if(inBounds(i,enteredJ)) return {i,j:enteredJ,world:0,enteredJ};
    // Convenience input aliases only. Never use this for geographic lookup or
    // tile rendering: 360 / dotW is 856.3636..., not 856. Seam IDs stay distinct.
    const first=Math.ceil((enteredJ-GRID.maxColumn)/856), last=Math.floor((enteredJ-GRID.minColumn)/856);
    if(first!==last) throw Error('This repeated ID is ambiguous at the world seam. Enter its original column between -3 and 853.');
    const j=enteredJ-first*856;
    if(!inBounds(i,j)) throw Error('Dot index is outside the legacy grid.');
    return {i,j,world:first,enteredJ};
  }
  function compileBackground(input) {
    if(input===undefined)return null;
    if(!input||input.formatVersion!==1||!Array.isArray(input.landRanges)||!Number.isSafeInteger(input.landCount)||input.landCount<0)throw Error('Invalid classification background.');
    const source=input.source;
    if(!source||source.repository!=='ShortOkapi/ebt-world-land-map'||!/^([a-f0-9]{40})$/.test(source.commit)||!/^([a-f0-9]{64})$/.test(source.baseSha256)||!/^([a-f0-9]{64})$/.test(source.overridesSha256))throw Error('Invalid classification background source.');
    const rows=new Map();let count=0,previousRow=-1,previousEnd=-4;
    for(const range of input.landRanges){
      if(!Array.isArray(range)||range.length!==3||!range.every(Number.isSafeInteger))throw Error('Invalid classification background range.');
      const [i,first,last]=range;
      if(!inBounds(i,first)||!inBounds(i,last)||first>last||i<previousRow||i===previousRow&&first<=previousEnd)throw Error('Invalid or overlapping classification background range.');
      if(!rows.has(i))rows.set(i,[]);
      rows.get(i).push([first,last]);count+=last-first+1;previousRow=i;previousEnd=last;
    }
    if(count!==input.landCount)throw Error('Classification background count mismatch.');
    return rows;
  }
  function backgroundClassification(rows,i,j) {
    if(!rows||!inBounds(i,j))return 'unreviewed';
    const intervals=rows.get(i)||[];let low=0,high=intervals.length-1;
    while(low<=high){const mid=(low+high)>>1,[first,last]=intervals[mid];if(j<first)high=mid-1;else if(j>last)low=mid+1;else return 'foreign';}
    return 'sea';
  }
  function validate(data) {
    const fail=m=>{throw Error(m);};
    if(!data || data.format!=='ebt-target-editor' || data.formatVersion!==1) fail('This is not a supported editable target dataset (format version 1).');
    for(const [k,v] of Object.entries(GRID)) if(data.grid?.[k]!==v) fail(`Incompatible legacy grid: ${k}.`);
    compileBackground(data.classificationBackground);
    if(data.model?.id!=='euro-use' || data.model?.worldwideLandIncluded!==false) fail('This editor version accepts the Euro-use model only.');
    if(typeof data.datasetId!=='string' || !data.datasetId || !Number.isSafeInteger(data.revision)||data.revision<0) fail('Invalid dataset identity or revision.');
    if(!Array.isArray(data.sources)||data.sources.length>1000) fail('Invalid source list.');
    const sourceIds=new Set();
    for(const s of data.sources){
      if(typeof s.id!=='string'||sourceIds.has(s.id)||typeof s.filename!=='string'||typeof s.sheet!=='string') fail('Invalid or duplicate source.');
      const b=s.bounds;
      if(!b||!inBounds(b.southRow,b.westColumn)||!inBounds(b.northRow,b.eastColumn)||b.southRow>b.northRow||b.westColumn>b.eastColumn) fail('Invalid source coverage.');
      sourceIds.add(s.id);
    }
    if(!Array.isArray(data.cells)||data.cells.length>550194) fail('Invalid cell list.');
    const cells=new Map();
    for(const c of data.cells){
      if(!inBounds(c.i,c.j)||!Object.hasOwn(CLASSES,c.classification)) fail('Invalid dot or classification.');
      const k=key(c.i,c.j);
      if(cells.has(k)) fail(`Duplicate dot [${c.i}, ${c.j}].`);
      if(!Array.isArray(c.provenance)||c.provenance.some(p=>!sourceIds.has(p.sourceId)||typeof p.cell!=='string'||!/^\$?[A-Z]+\$?\d+$/.test(p.cell))) fail('Invalid source reference.');
      cells.set(k,c);
    }
    if(!Array.isArray(data.history)||data.history.length>100000) fail('Invalid change history.');
    const ids=new Set(), last=new Map();
    for(const h of data.history){
      if(typeof h.id!=='string'||ids.has(h.id)||!Array.isArray(h.dot)||h.dot.length!==2||!inBounds(...h.dot)||!Object.hasOwn(CLASSES,h.from)||!Object.hasOwn(CLASSES,h.to)||typeof h.comment!=='string'||!h.comment.trim()||typeof h.at!=='string'||!Number.isFinite(Date.parse(h.at))||!['edit','undo','redo'].includes(h.action)) fail('Invalid history entry.');
      if(h.action!=='edit' && !ids.has(h.relatedEventId)) fail('Invalid Undo/Redo reference.');
      if(h.actor!==undefined&&(!h.actor||typeof h.actor.id!=='string'||typeof h.actor.name!=='string'||!['local','account'].includes(h.actor.authentication))) fail('Invalid edit author.');
      const k=key(...h.dot);
      if(last.has(k)&&last.get(k)!==h.from) fail('Broken classification history.');
      last.set(k,h.to); ids.add(h.id);
    }
    for(const [k,v] of last) if((cells.get(k)?.classification||'unreviewed')!==v) fail('History does not match the current classification.');
    if(data.revision<data.history.length) fail('Revision is older than the change history.');
    return data;
  }
  function compact(data) {
    validate(data);
    const ranges=[],classifications={formatVersion:1,excluded:[],foreign:[],sea:[],unreviewed:[]};
    const eligible=data.cells.filter(c=>c.classification==='eligible').length;
    for(const c of data.cells.slice().sort(compare)){
      const list=c.classification==='eligible'?ranges:classifications[c.classification];
      const last=list[list.length-1];
      if(last&&last[0]===c.i&&last[2]+1===c.j) last[2]=c.j;
      else list.push([c.i,c.j,c.j]);
    }
    if(data.classificationBackground)classifications.background=clone(data.classificationBackground);
    return {format:'ebt-target-ranges',formatVersion:1,grid:clone(GRID),model:'euro-use',datasetId:data.datasetId,revision:data.revision,eligibleCount:eligible,ranges,classifications};
  }
  function sameEditor(a,b){
    const name=a?.name.trim();
    return !!name&&name===b?.name.trim()&&(a.id===b.id||a.authentication==='local'||b.authentication==='local');
  }
  function repeatsEdit(previous,from,to,comment,actor){
    return from===to&&previous?.action==='edit'&&previous.to===to&&previous.comment.trim()===comment.trim()&&sameEditor(previous.actor,actor);
  }
  function visibleHistory(history){
    const last=new Map();
    return history.filter(h=>{
      const k=key(...h.dot),previous=last.get(k);
      last.set(k,h);
      return h.action!=='edit'||!repeatsEdit(previous,h.from,h.to,h.comment,h.actor);
    });
  }
  function undoneEditIds(history){
    // Derive display state from the saved event links; never rewrite history.
    const undone=new Set();
    for(const h of history){
      if(h.action==='undo')undone.add(h.relatedEventId);
      else if(h.action==='redo')undone.delete(h.relatedEventId);
    }
    return undone;
  }
  function undoneHistoryIds(history){
    const undone=undoneEditIds(history),latestRedo=new Map();
    for(const h of history){
      if(h.action==='redo')latestRedo.set(h.relatedEventId,h.id);
      else if(h.action==='undo'&&latestRedo.has(h.relatedEventId)){
        // Undo/Redo records link to the original edit. Mark the particular
        // Redo being reversed as well; a later Redo is a separate event.
        undone.add(latestRedo.get(h.relatedEventId));
        latestRedo.delete(h.relatedEventId);
      }
    }
    return undone;
  }
  class Editor {
    constructor(data,actor={id:'local',name:'Name not recorded',authentication:'local'}){
      this.actor=clone(actor);
      this.doc=clone(validate(data)); this.cells=new Map(this.doc.cells.map(c=>[key(c.i,c.j),c]));
      this.background=compileBackground(this.doc.classificationBackground);
      this.opened=new Map(this.doc.cells.map(c=>[key(c.i,c.j),c.classification]));
      this.openedHistoryLength=this.doc.history.length; this.undoStack=[]; this.redoStack=[];
    }
    get(i,j){return this.cells.get(key(i,j))?.classification||backgroundClassification(this.background,i,j);}
    rowRuns(){
      const explicit=new Map(),rows=new Map();
      for(const c of this.cells.values()){if(!explicit.has(c.i))explicit.set(c.i,[]);explicit.get(c.i).push(c);}
      for(let i=GRID.minRow;i<=GRID.maxRow;i++){
        const cuts=new Set([GRID.minColumn,GRID.maxColumn+1]);
        for(const [first,last] of this.background?.get(i)||[]){cuts.add(first);cuts.add(last+1);}
        for(const c of explicit.get(i)||[]){cuts.add(c.j);cuts.add(c.j+1);}
        const edges=[...cuts].sort((a,b)=>a-b),runs=[];
        for(let n=0;n<edges.length-1;n++){
          const first=edges[n],last=edges[n+1]-1,classification=this.get(i,first),previous=runs[runs.length-1];
          if(previous&&previous.classification===classification&&previous.last+1===first)previous.last=last;
          else runs.push({i,first,last,classification});
        }
        rows.set(i,runs);
      }
      return rows;
    }
    duplicate(i,j,to,comment,actor=this.actor){
      const last=[...this.doc.history].reverse().find(h=>h.dot[0]===i&&h.dot[1]===j);
      return repeatsEdit(last,this.get(i,j),to,comment,actor);
    }
    change(i,j,to,comment){
      if(!inBounds(i,j)||!Object.hasOwn(CLASSES,to)) throw Error('Invalid dot or classification.');
      if(typeof comment!=='string'||!comment.trim()) throw Error('Add a reason or comment before saving.');
      if(this.duplicate(i,j,to,comment)) throw Error('This classification and comment are already saved. Nothing new was added.');
      if(!this.opened.has(key(i,j)))this.opened.set(key(i,j),this.get(i,j));
      const e=this.record(i,j,this.get(i,j),to,comment.trim(),'edit');
      this.undoStack.push(e); this.redoStack=[]; return e;
    }
    record(i,j,from,to,comment,action,relatedEventId){
      const at=new Date().toISOString();
      const e={id:`r${this.doc.revision+1}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,dot:[i,j],at,from,to,comment,action,actor:clone(this.actor)};
      if(relatedEventId) e.relatedEventId=relatedEventId;
      const k=key(i,j), current=this.cells.get(k)||{i,j,classification:'unreviewed',provenance:[]};
      this.cells.set(k,{...current,classification:to}); this.doc.history.push(e);
      this.doc.updatedAt=at; this.doc.revision++; return e;
    }
    undo(){const e=this.undoStack.pop(); if(!e)return null; this.record(...e.dot,e.to,e.from,`Undo: ${e.comment}`,'undo',e.id); this.redoStack.push(e); return e;}
    redo(){const e=this.redoStack.pop(); if(!e)return null; this.record(...e.dot,e.from,e.to,`Redo: ${e.comment}`,'redo',e.id); this.undoStack.push(e); return e;}
    export(){const d=clone(this.doc); d.cells=[...this.cells.values()].sort(compare); validate(d); return d;}
    changes(){
      const touched=new Set(this.doc.history.slice(this.openedHistoryLength).map(h=>key(...h.dot)));
      return [...touched].map(k=>{const c=this.cells.get(k);return {i:c.i,j:c.j,from:this.opened.get(k)||'unreviewed',to:c.classification,history:this.doc.history.slice(this.openedHistoryLength).filter(h=>key(...h.dot)===k)};}).sort(compare);
    }
  }
  root.TargetCore={GRID,CLASSES,key,clone,compare,compileBackground,backgroundClassification,canonicalLongitude,atLatLng,bounds,parseDot,validate,compact,visibleHistory,undoneEditIds,undoneHistoryIds,Editor};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.TargetCore;
})(typeof globalThis!=='undefined'?globalThis:this);