'use strict';
const {Component,MarkdownView}=require('obsidian');
const Core=require('../core');

// Reading progress as a fraction, or null when the note does not scroll.
function progressOf(top,height,client){
  const range=height-client;
  return range>4?Math.min(1,Math.max(0,top/range)):null;
}
function topFor(fraction,height,client){return Math.round(Math.min(1,Math.max(0,fraction))*Math.max(0,height-client));}
const clamp01=x=>Math.min(1,Math.max(0,x));

// Strips inline Markdown, wiki/Markdown links, comments and attached annotation braces so
// ruler labels match what Reading view renders, while preserving text inside inline code.
function cleanHeading(raw){
  const codes=[];
  let text=String(raw||'').replace(/%%[\s\S]*?%%/g,'')
    .replace(/(`+)([^`]+?)\1/g,(_m,_ticks,code)=>`\u0000${codes.push(code)-1}\u0000`);
  // Annotations right after ==target==: both {标注|...} and {ann ...}.
  text=text.replace(/==([^=\n]+)==\{[^{}\n]{1,200}\}/g,'$1');
  text=text.replace(/!?\[\[([^\]]+)\]\]/g,(_m,inner)=>{
    const clean=inner.replace(/\\\|/g,'|'),bar=clean.lastIndexOf('|');
    return bar>=0?clean.slice(bar+1):clean;
  });
  for(let prev='';prev!==text;){
    prev=text;
    text=text.replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g,'$1');
  }
  text=text
    .replace(/\*\*\*([^*]+)\*\*\*/g,'$1')
    .replace(/\*\*([^*]+)\*\*/g,'$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g,'$1$2')
    .replace(/__([^_]+)__/g,'$1')
    .replace(/(^|[^\w])_([^_]+)_(?![\w])/g,'$1$2')
    .replace(/~~([^~]+)~~/g,'$1')
    .replace(/==([^=\n]+)==/g,'$1')
    .replace(/^#{1,6}\s+/,'')
    .replace(/\u0000(\d+)\u0000/g,(_m,i)=>codes[Number(i)]??'')
    .replace(/\s+/g,' ')
    .trim();
  return text;
}

// 2D Gaussian wave offset (px leftward) for ticks near the pointer or active drag position.
const WAVE_SIGMA=26,WAVE_AMP=7,WAVE_RADIUS=78;
function waveOffset(dy,sigma=WAVE_SIGMA,amp=WAVE_AMP){
  return Math.abs(dy)>sigma*3?0:amp*Math.exp(-(dy*dy)/(2*sigma*sigma));
}

// Semantic reading-position memory: re-anchors to the heading that was active when saved
// if content above it grew or shrank, falling back to the saved fraction.
function resolveResume(saved,headings=[],fractions=[]){
  if(!saved||!(saved.p>0&&saved.p<1))return null;
  let idx=-1;
  if(Number.isInteger(saved.line)&&saved.text)
    idx=headings.findIndex(h=>h.line===saved.line&&h.text===saved.text);
  if(idx<0&&saved.text){
    const hits=headings.map((h,i)=>h.text===saved.text?i:-1).filter(i=>i>=0);
    if(hits.length===1)idx=hits[0];
  }
  if(idx>=0&&Number.isFinite(fractions[idx]))
    return clamp01(Number.isFinite(saved.hp)?saved.p+(fractions[idx]-saved.hp):fractions[idx]);
  return clamp01(saved.p);
}
function makeMemory(progress,headings=[],fractions=[],current=-1,now=Date.now()){
  if(!Number.isFinite(progress)||progress<=0.03||progress>=0.98)return null;
  const rec={p:Math.round(progress*10000)/10000,at:now};
  if(current>=0&&headings[current]){
    rec.line=headings[current].line;rec.text=headings[current].text;
    if(Number.isFinite(fractions[current]))rec.hp=Math.round(fractions[current]*10000)/10000;
  }
  return rec;
}

// The heading being read: the last one whose tick is at or above the dot (-1 before the first).
function currentHeading(fractions,progress){
  let current=-1;
  fractions.forEach((f,i)=>{if(f<=progress+.002)current=i;});
  return current;
}
// Which headings fit beside the ruler. items are {index, level, top} (top in px down the ruler);
// labels need `gap` px between them. The heading being read always stays, then higher levels
// win a clash, then earlier headings. Returns the kept indexes in order.
function layoutHeadings(items,gap,current=-1){
  const rank=item=>[item.index===current?0:1,item.level,item.index];
  const order=[...items].sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];});
  const kept=[];
  for(const item of order)if(kept.every(k=>Math.abs(k.top-item.top)>=gap))kept.push(item);
  return kept.map(k=>k.index).sort((a,b)=>a-b);
}
const inside=(root,node)=>{for(let cur=node;cur;cur=cur.parentNode)if(cur===root)return true;return false;};
const reducedMotion=win=>!!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
const HEADING_LEVELS=4,HEADING_GAP=16,MIN_MARGIN=120,LIST_WIDTH=220,GLIDE_MS=160,MEMORY_DELAY=1200;

class ScrollRuler extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.entries=new Map();}
  onload(){
    for(const event of ['layout-change','active-leaf-change','file-open','resize'])this.registerEvent(this.app.workspace.on(event,()=>this.sync()));
    // Headings added, renamed or removed while typing.
    this.registerEvent(this.app.metadataCache.on('changed',file=>{for(const view of this.entries.keys())if(view.file===file)this.schedule(view);}));
    this.plugin.addCommand?.({
      id:'jump-reading-memory',
      name:'跳到上次阅读位置',
      checkCallback:checking=>{
        const view=this.app.workspace.getActiveViewOfType?.(MarkdownView),entry=view&&this.entries.get(view);
        if(!entry||!this.memoryEnabled()||entry.resumeFraction===null)return false;
        if(!checking)this.jumpTo(view,entry.resumeFraction,true);
        return true;
      }
    });
    this.app.workspace.onLayoutReady(()=>this.sync());
  }
  onunload(){for(const view of [...this.entries.keys()])this.detach(view);}
  enabled(){return this.plugin.data.settings.scrollRuler!==false;}
  showHeadings(){return this.plugin.data.settings.rulerHeadings!==false;}
  headingLevels(){
    const n=this.plugin.data?.settings?.rulerHeadingLevels;
    return Core.RULER_HEADING_LEVELS.some(x=>x.id===n)?n:HEADING_LEVELS;
  }
  memoryEnabled(){return this.plugin.data.settings.rulerMemory!==false;}
  sync(){
    const views=this.enabled()?this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).filter(v=>v instanceof MarkdownView):[];
    for(const view of [...this.entries.keys()])if(!views.includes(view)||!view.contentEl?.isConnected)this.detach(view);
    for(const view of views){if(!this.entries.has(view))this.attach(view);this.update(view);}
  }
  attach(view){
    const host=view.contentEl,doc=host.ownerDocument,owner=this.addChild(new Component());
    const el=doc.createElement('div');el.className='aw-ruler';el.setAttribute('aria-hidden','true');
    const ticksBox=doc.createElement('div');ticksBox.className='aw-ruler-ticks';
    const hmarksBox=doc.createElement('div');hmarksBox.className='aw-ruler-hmarks';
    const heads=doc.createElement('div');heads.className='aw-ruler-heads';
    const panel=doc.createElement('div');panel.className='aw-ruler-panel';
    const resume=doc.createElement('div');resume.className='aw-ruler-resume';resume.hidden=true;resume.title='上次阅读位置（点击返回）';
    const knob=doc.createElement('div');knob.className='aw-ruler-knob';
    const label=doc.createElement('span');label.className='aw-ruler-label';
    knob.appendChild(label);
    el.appendChild(ticksBox);el.appendChild(hmarksBox);el.appendChild(heads);el.appendChild(panel);el.appendChild(resume);el.appendChild(knob);
    host.appendChild(el);host.classList.add('aw-has-ruler');
    // Frames come from the ruler's own window: a popout keeps updating while the main window
    // is minimised or covered (its frames would pause).
    const win=doc.defaultView||window;
    const entry={
      owner,el,ticksBox,ticks:[],hmarksBox,hmarks:[],heads,marks:[],panel,panelItems:[],resume,knob,label,
      frame:0,glideFrame:0,memoryTimer:0,pendingMemory:null,win,
      hoverY:null,dragging:false,endDrag:null,
      sectionSig:'',knownStarts:new Map(),
      filePath:undefined,savedMemory:null,resumeFraction:null
    };
    this.entries.set(view,entry);
    resume.addEventListener('pointerdown',event=>{
      if(event.button!==0||entry.resumeFraction===null)return;
      event.preventDefault();event.stopPropagation();
      this.jumpTo(view,entry.resumeFraction,true);
    });
    panel.addEventListener('pointerdown',event=>event.stopPropagation());
    // scroll does not bubble; capture it from whichever scroller the current mode uses.
    owner.registerDomEvent(host,'scroll',()=>this.schedule(view),{capture:true});
    owner.registerDomEvent(host,'wheel',event=>{if(!inside(el,event.target))this.stopGlide(entry);},{passive:true});
    owner.registerDomEvent(el,'pointerdown',event=>this.drag(view,event));
    owner.registerDomEvent(el,'pointermove',event=>{
      if(inside(panel,event.target)){if(entry.hoverY!==null){entry.hoverY=null;this.paintWave(entry);}return;}
      const rect=el.getBoundingClientRect();
      if(rect.height>0){entry.hoverY=event.clientY-rect.top;this.paintWave(entry);}
    });
    owner.registerDomEvent(el,'pointerleave',()=>{entry.hoverY=null;if(!entry.dragging)this.paintWave(entry);});
    // The ruler and its headings sit beside the scroller, not in it: pass the wheel on, except
    // when scrolling a dense outline panel that overflows its own box.
    owner.registerDomEvent(el,'wheel',event=>{
      if(inside(panel,event.target)&&panel.scrollHeight>panel.clientHeight)return;
      const s=this.scroller(view);if(!s)return;
      this.stopGlide(entry);
      event.preventDefault();s.scrollTop+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?s.clientHeight:1);
    },{passive:false});
  }
  detach(view){
    const entry=this.entries.get(view);if(!entry)return;
    entry.endDrag?.();
    this.stopGlide(entry);
    this.flushMemory(entry);
    entry.win.cancelAnimationFrame?.(entry.frame);
    entry.el.remove();view.contentEl?.classList.remove('aw-has-ruler');
    this.removeChild(entry.owner);this.entries.delete(view);
  }
  scroller(view){
    const preview=view.getMode?.()==='preview';
    return view.contentEl.querySelector(preview?'.markdown-reading-view .markdown-preview-view':'.markdown-source-view .cm-scroller');
  }
  schedule(view){
    const entry=this.entries.get(view);
    if(entry&&!entry.frame)entry.frame=entry.win.requestAnimationFrame(()=>{entry.frame=0;this.update(view);});
  }
  syncFileMemory(view,entry){
    const nextPath=view.file?.path||null;
    if(entry.filePath===nextPath)return;
    this.flushMemory(entry);
    entry.filePath=nextPath;
    const raw=nextPath&&this.plugin.data?.reading?.[nextPath];
    entry.savedMemory=raw?{...raw}:null;
    entry.resumeFraction=null;
  }
  queueMemory(entry,sample){
    if(!entry.filePath||!this.memoryEnabled()||typeof this.plugin.saveReading!=='function')return;
    entry.pendingMemory={path:entry.filePath,sample};
    if(typeof entry.win.setTimeout!=='function'){this.flushMemory(entry);return;}
    entry.win.clearTimeout?.(entry.memoryTimer);
    entry.memoryTimer=entry.win.setTimeout(()=>{entry.memoryTimer=0;this.flushMemory(entry);},MEMORY_DELAY);
  }
  flushMemory(entry){
    if(entry.memoryTimer){entry.win.clearTimeout?.(entry.memoryTimer);entry.memoryTimer=0;}
    const pending=entry.pendingMemory;entry.pendingMemory=null;
    if(pending&&typeof this.plugin.saveReading==='function')this.plugin.saveReading(pending.path,pending.sample);
  }
  syncTicks(entry,height){
    if(!(height>0))return;
    const count=Math.max(9,Math.floor(height/8)+1);
    if(entry.ticks.length===count)return;
    for(const t of entry.ticks)t.remove();
    entry.ticks=[];
    const doc=entry.el.ownerDocument;
    for(let i=0;i<count;i++){
      const tick=doc.createElement('i');
      tick.className=i%8===0?'aw-ruler-tick is-major':'aw-ruler-tick';
      tick.style.top=`${(i/(count-1)*100).toFixed(2)}%`;
      entry.ticksBox.appendChild(tick);entry.ticks.push(tick);
    }
    entry.el.classList.toggle('has-ticks',true);
  }
  paintWave(entry,progress=entry.lastProgress){
    if(!entry.ticks.length&&!entry.hmarks.length)return;
    const height=entry.el.getBoundingClientRect().height;
    const center=reducedMotion(entry.win)?null:entry.dragging&&Number.isFinite(progress)?progress*height:entry.hoverY;
    const count=entry.ticks.length;
    for(let i=0;i<count;i++){
      const tick=entry.ticks[i],y=count>1?i/(count-1)*height:0;
      const off=center===null||!(height>0)?0:waveOffset(y-center);
      tick.style.transform=off>=0.25?`translateX(${-off.toFixed(1)}px)`:'';
      tick.classList.toggle('is-near',off>=1.5);
    }
    for(const hm of entry.hmarks){
      const f=Number(hm.dataset.fraction);
      const off=center===null||!(height>0)||!Number.isFinite(f)?0:waveOffset(f*height-center);
      hm.style.transform=off>=0.25?`translateX(${-off.toFixed(1)}px)`:'';
    }
  }
  update(view){
    const entry=this.entries.get(view),s=entry&&this.scroller(view);
    if(!entry)return;
    this.syncFileMemory(view,entry);
    const progress=s?progressOf(s.scrollTop,s.scrollHeight,s.clientHeight):null;
    entry.lastProgress=progress;
    entry.el.classList.toggle('is-idle',progress===null);
    if(progress===null){entry.resume.hidden=true;return;}
    entry.knob.style.top=`${(progress*100).toFixed(2)}%`;entry.label.textContent=progress.toFixed(2);
    const height=entry.el.getBoundingClientRect().height;
    this.syncTicks(entry,height);
    const {headings,fractions,current}=this.updateHeadings(view,entry,s,progress,height);
    this.paintWave(entry,progress);
    const resume=this.memoryEnabled()?resolveResume(entry.savedMemory,headings,fractions):null;
    entry.resumeFraction=resume;
    if(resume!==null){
      entry.resume.hidden=false;
      entry.resume.style.top=`${(resume*100).toFixed(2)}%`;
    }else entry.resume.hidden=true;
    if(entry.savedMemory===null||Math.abs(progress-(resume??-1))>0.01)
      this.queueMemory(entry,makeMemory(progress,headings,fractions,current));
  }
  // Headings up to the configured max level with their cleaned display text and 0-based source lines.
  headings(view){
    const maxLevel=this.headingLevels();
    const list=view.file&&this.app.metadataCache.getFileCache(view.file)?.headings||[];
    return list.map(h=>({text:cleanHeading(h.heading),level:h.level,line:h.position?.start?.line}))
      .filter(h=>h.level<=maxLevel&&h.text&&Number.isInteger(h.line));
  }
  // Where each heading's top sits in the scroller's content, as a fraction of its whole height.
  fractions(view,s,headings){
    const entry=this.entries.get(view);
    const height=s.scrollHeight,top=s.getBoundingClientRect().top-s.scrollTop;
    const cm=view.getMode?.()==='preview'?null:view.editor?.cm;
    if(height>0&&cm?.lineBlockAt&&cm.state?.doc&&Number.isFinite(cm.documentTop)){
      const lines=cm.state.doc.lines,base=cm.documentTop-top;
      return headings.map(h=>clamp01((base+cm.lineBlockAt(cm.state.doc.line(Math.min(h.line+1,lines)).from).top)/height));
    }
    const renderer=view.previewMode?.renderer,sections=renderer?.sections;
    const ui=x=>x===renderer?.header||x===renderer?.footer;
    const text=Array.isArray(sections)?sections.map((x,i)=>i).filter(i=>!ui(sections[i])):[];
    if(height>0&&text.length&&sections.every(x=>Number.isFinite(x?.height))&&text.every(i=>Number.isInteger(sections[i].start?.line)&&Number.isInteger(sections[i].end?.line))){
      const sig=`${view.file?.path||''}:${s.clientWidth||0}:${sections.length}:${headings.map(h=>`${h.line}:${h.level}`).join(',')}`;
      if(entry&&entry.sectionSig!==sig){entry.sectionSig=sig;entry.knownStarts.clear();}
      const known=entry?entry.knownStarts:new Map();
      sections.forEach((x,idx)=>{
        if(x.el?.isConnected&&x.el.offsetParent)known.set(idx,x.el.getBoundingClientRect().top-top);
      });
      // Next known anchor ahead of each index prevents off-screen height estimates from overshooting.
      const nextAnchor=Array(sections.length).fill(Infinity);
      let bound=Infinity;
      for(let idx=sections.length-1;idx>=0;idx--){
        if(known.has(idx))bound=known.get(idx);
        nextAnchor[idx]=bound;
      }
      const sizer=s.querySelector('.markdown-preview-sizer');
      let y=sizer?sizer.getBoundingClientRect().top-top:0;
      const starts=sections.map((x,idx)=>{
        if(known.has(idx))y=known.get(idx);
        else if(y>nextAnchor[idx])y=nextAnchor[idx];
        const at=y;y+=x.height;return at;
      });
      let j=0;const last=sections[text.at(-1)].end.line;
      return headings.map(h=>{
        while(j<text.length-1&&sections[text[j]].end.line<h.line)j++;
        const x=sections[text[j]],insideSec=x.start.line<=h.line&&h.line<=x.end.line;
        return clamp01(insideSec?starts[text[j]]/height:h.line/Math.max(1,last+1));
      });
    }
    const lines=Math.max(1,view.editor?.lineCount?.()||String(view.data||'').split('\n').length);
    return headings.map(h=>clamp01(h.line/lines));
  }
  // Room between the text column and the ruler, in px.
  margin(entry,s){
    const column=s.querySelector('.cm-sizer, .markdown-preview-sizer');
    if(!column)return 0;
    const pad=parseFloat(entry.el.ownerDocument.defaultView?.getComputedStyle?.(column)?.paddingRight)||0;
    return entry.el.getBoundingClientRect().left-(column.getBoundingClientRect().right-pad);
  }
  updateHeadings(view,entry,s,progress,height=entry.el.getBoundingClientRect().height){
    const headings=this.showHeadings()?this.headings(view):[];
    if(!headings.length){this.clearHeadings(entry);return {headings:[],fractions:[],current:-1};}
    const margin=this.margin(entry,s),compact=margin<MIN_MARGIN;
    entry.el.classList.toggle('is-compact',compact);
    entry.heads.style.setProperty('--aw-heads-width',`${Math.round(compact?LIST_WIDTH:Math.min(LIST_WIDTH,margin-24))}px`);
    const fractions=this.fractions(view,s,headings);
    const current=currentHeading(fractions,progress);
    const doc=entry.el.ownerDocument;
    // Independent heading ticks stay visible on the rail even when narrow margins collapse text labels.
    entry.el.classList.toggle('has-headings',true);
    headings.forEach((h,i)=>{
      let hm=entry.hmarks[i];
      if(!hm){
        hm=doc.createElement('i');
        hm.addEventListener('pointerdown',event=>{
          if(event.button!==0)return;
          event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(hm.dataset.fraction),true);
        });
        entry.hmarksBox.appendChild(hm);entry.hmarks.push(hm);
      }
      hm.className=`aw-ruler-hmark is-level-${h.level}${i===current?' is-current':i<current?' is-passed':''}`;
      hm.dataset.line=String(h.line);hm.dataset.fraction=String(fractions[i]);hm.title=h.text;
      hm.style.top=`${(fractions[i]*100).toFixed(2)}%`;
    });
    for(const extra of entry.hmarks.splice(headings.length))extra.remove();
    const kept=layoutHeadings(headings.map((h,i)=>({index:i,level:h.level,top:fractions[i]*height})),HEADING_GAP,current);
    const dense=kept.length<headings.length;
    entry.el.classList.toggle('is-dense',dense);
    let near=false;
    kept.forEach((i,n)=>{
      const h=headings[i];
      let mark=entry.marks[n];
      if(!mark){
        mark=doc.createElement('div');
        const text=doc.createElement('span');text.className='aw-ruler-head-text';mark.appendChild(text);
        mark.addEventListener('pointerdown',event=>{
          if(event.button!==0)return;
          event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(mark.dataset.fraction),true);
        });
        entry.heads.appendChild(mark);entry.marks.push(mark);
      }
      mark.className=`aw-ruler-head is-level-${h.level}${i===current?' is-current':''}`;
      mark.dataset.line=String(h.line);mark.dataset.fraction=String(fractions[i]);mark.title=h.text;mark.firstChild.textContent=h.text;
      mark.style.top=`${(fractions[i]*100).toFixed(2)}%`;
      if(Math.abs(fractions[i]-progress)*height<12)near=true;
    });
    for(const extra of entry.marks.splice(kept.length))extra.remove();
    // Dense notes expose all headings in a scrollable popover on hover so clashing subsections stay reachable.
    if(dense){
      const minLevel=Math.min(...headings.map(h=>h.level));
      headings.forEach((h,i)=>{
        let item=entry.panelItems[i];
        if(!item){
          item=doc.createElement('div');
          item.addEventListener('pointerdown',event=>{
            if(event.button!==0)return;
            event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(item.dataset.fraction),true);
          });
          entry.panel.appendChild(item);entry.panelItems.push(item);
        }
        const wasCurrent=item.className.includes('is-current');
        item.className=`aw-ruler-item is-level-${h.level}${i===current?' is-current':''}`;
        item.style.setProperty('--aw-head-indent',String(h.level-minLevel));
        item.dataset.line=String(h.line);item.dataset.fraction=String(fractions[i]);
        item.title=h.text;item.textContent=h.text;
        if(i===current&&!wasCurrent)item.scrollIntoView?.({block:'nearest'});
      });
      for(const extra of entry.panelItems.splice(headings.length))extra.remove();
    }else for(const extra of entry.panelItems.splice(0))extra.remove();
    // On a heading the dot's number would sit on the heading's name: the name says more.
    entry.el.classList.toggle('is-on-heading',near);
    return {headings,fractions,current};
  }
  clearHeadings(entry){
    for(const hm of entry.hmarks)hm.remove();
    for(const mark of entry.marks)mark.remove();
    for(const item of entry.panelItems)item.remove();
    entry.hmarks=[];entry.marks=[];entry.panelItems=[];
    entry.el.classList.toggle('has-headings',false);
    entry.el.classList.toggle('is-on-heading',false);
    entry.el.classList.toggle('is-compact',false);
    entry.el.classList.toggle('is-dense',false);
  }
  stopGlide(entry){
    if(entry?.glideFrame){entry.win.cancelAnimationFrame?.(entry.glideFrame);entry.glideFrame=0;}
  }
  jumpTo(view,fraction,smooth=false){
    const s=this.scroller(view),entry=this.entries.get(view);
    if(!s||!Number.isFinite(fraction))return;
    this.stopGlide(entry);
    const target=topFor(fraction,s.scrollHeight,s.clientHeight);
    if(!smooth||!entry||typeof entry.win?.requestAnimationFrame!=='function'||reducedMotion(entry.win)||Math.abs(target-s.scrollTop)<=2){
      s.scrollTop=target;return;
    }
    const start=s.scrollTop,nowFn=()=>entry.win.performance?.now?.()??Date.now(),t0=nowFn();
    const step=()=>{
      const elapsed=nowFn()-t0,t=Math.min(1,Math.max(0,elapsed/GLIDE_MS));
      const eased=1-(1-t)**3;
      const latestTarget=topFor(fraction,s.scrollHeight,s.clientHeight);
      s.scrollTop=t>=1?latestTarget:Math.round(start+(latestTarget-start)*eased);
      if(t<1)entry.glideFrame=entry.win.requestAnimationFrame(step);
      else entry.glideFrame=0;
    };
    entry.glideFrame=entry.win.requestAnimationFrame(step);
  }
  drag(view,event){
    const entry=this.entries.get(view),s=this.scroller(view);
    if(!entry||!s||event.button!==0)return;
    event.preventDefault();
    entry.endDrag?.();
    this.stopGlide(entry);
    const doc=entry.el.ownerDocument,jump=e=>{
      const rect=entry.el.getBoundingClientRect();
      if(!(rect.height>0))return;
      const f=clamp01((e.clientY-rect.top)/rect.height);
      s.scrollTop=topFor(f,s.scrollHeight,s.clientHeight);
      entry.hoverY=e.clientY-rect.top;
      this.paintWave(entry,f);
    };
    entry.dragging=true;entry.el.classList.add('is-dragging');jump(event);
    const up=()=>{
      doc.removeEventListener?.('pointermove',jump);
      doc.removeEventListener?.('pointerup',up);
      doc.removeEventListener?.('pointercancel',up);
      entry.win.removeEventListener?.('blur',up);
      entry.dragging=false;entry.endDrag=null;
      entry.el.classList.remove('is-dragging');
      this.paintWave(entry);
    };
    entry.endDrag=up;
    doc.addEventListener('pointermove',jump);
    doc.addEventListener('pointerup',up);
    doc.addEventListener('pointercancel',up);
    entry.win.addEventListener?.('blur',up);
  }
  displaySettings(container,Setting){
    new Setting(container).setName('滚动刻度尺')
      .addToggle(t=>t.setValue(this.plugin.data.settings.scrollRuler!==false).onChange(v=>{this.plugin.data.settings.scrollRuler=v;this.sync();this.plugin.changed();}));
    new Setting(container).setName('刻度尺旁显示标题')
      .addToggle(t=>t.setValue(this.showHeadings()).onChange(v=>{this.plugin.data.settings.rulerHeadings=v;this.sync();this.plugin.changed();}));
    new Setting(container).setName('刻度尺标题层级')
      .addDropdown(d=>{
        for(const opt of Core.RULER_HEADING_LEVELS)d.addOption(String(opt.id),opt.label);
        d.setValue(String(this.headingLevels())).onChange(v=>{this.plugin.data.settings.rulerHeadingLevels=Number(v);this.sync();this.plugin.changed();});
      });
    new Setting(container).setName('记住上次阅读位置')
      .addToggle(t=>t.setValue(this.memoryEnabled()).onChange(v=>{this.plugin.data.settings.rulerMemory=v;this.sync();this.plugin.changed();}));
  }
}
module.exports={ScrollRuler,progressOf,topFor,cleanHeading,waveOffset,resolveResume,makeMemory,currentHeading,layoutHeadings};
