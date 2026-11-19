'use strict';
const {Component,MarkdownView}=require('obsidian');

// Reading progress as a fraction, or null when the note does not scroll.
function progressOf(top,height,client){
  const range=height-client;
  return range>4?Math.min(1,Math.max(0,top/range)):null;
}
function topFor(fraction,height,client){return Math.round(Math.min(1,Math.max(0,fraction))*Math.max(0,height-client));}
const clamp01=x=>Math.min(1,Math.max(0,x));

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
const HEADING_LEVELS=3,HEADING_GAP=16,MIN_MARGIN=120,LIST_WIDTH=220;

// A thin tick ruler on the right of each note: a dot marks the reading position with its
// fraction beside it; click or drag the ruler to jump. Beside it, in the page margin, the note's
// headings (levels 1–3) sit at their place in the whole note, each with a short dash to the
// ruler; the one being read is darker with a longer dash. Clicking a heading moves the dot onto
// its tick, which brings the heading level with the dot.
// When the margin is too narrow for them, they show over the text only while the pointer is on
// the ruler (or dragging it).
class ScrollRuler extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.entries=new Map();}
  onload(){
    for(const event of ['layout-change','active-leaf-change','file-open','resize'])this.registerEvent(this.app.workspace.on(event,()=>this.sync()));
    // Headings added, renamed or removed while typing.
    this.registerEvent(this.app.metadataCache.on('changed',file=>{for(const view of this.entries.keys())if(view.file===file)this.schedule(view);}));
    this.app.workspace.onLayoutReady(()=>this.sync());
  }
  onunload(){for(const view of [...this.entries.keys()])this.detach(view);}
  enabled(){return this.plugin.data.settings.scrollRuler!==false;}
  showHeadings(){return this.plugin.data.settings.rulerHeadings!==false;}
  sync(){
    const views=this.enabled()?this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).filter(v=>v instanceof MarkdownView):[];
    for(const view of [...this.entries.keys()])if(!views.includes(view)||!view.contentEl?.isConnected)this.detach(view);
    for(const view of views){if(!this.entries.has(view))this.attach(view);this.update(view);}
  }
  attach(view){
    const host=view.contentEl,doc=host.ownerDocument,owner=this.addChild(new Component());
    const el=doc.createElement('div');el.className='aw-ruler';el.setAttribute('aria-hidden','true');
    const heads=doc.createElement('div');heads.className='aw-ruler-heads';
    const knob=doc.createElement('div');knob.className='aw-ruler-knob';
    const label=doc.createElement('span');label.className='aw-ruler-label';
    knob.appendChild(label);el.appendChild(heads);el.appendChild(knob);host.appendChild(el);host.classList.add('aw-has-ruler');
    // Frames come from the ruler's own window: a popout keeps updating while the main window
    // is minimised or covered (its frames would pause).
    const win=doc.defaultView||window;
    const entry={owner,el,heads,knob,label,marks:[],frame:0,win};this.entries.set(view,entry);
    // scroll does not bubble; capture it from whichever scroller the current mode uses.
    owner.registerDomEvent(host,'scroll',()=>this.schedule(view),{capture:true});
    owner.registerDomEvent(el,'pointerdown',event=>this.drag(view,event));
    // The ruler and its headings sit beside the scroller, not in it: pass the wheel on.
    owner.registerDomEvent(el,'wheel',event=>{
      const s=this.scroller(view);if(!s)return;
      event.preventDefault();s.scrollTop+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?s.clientHeight:1);
    },{passive:false});
  }
  detach(view){
    const entry=this.entries.get(view);if(!entry)return;
    entry.win.cancelAnimationFrame(entry.frame);entry.el.remove();view.contentEl?.classList.remove('aw-has-ruler');
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
  update(view){
    const entry=this.entries.get(view),s=entry&&this.scroller(view);
    if(!entry)return;
    const progress=s?progressOf(s.scrollTop,s.scrollHeight,s.clientHeight):null;
    entry.el.classList.toggle('is-idle',progress===null);
    if(progress===null)return;
    entry.knob.style.top=`${(progress*100).toFixed(2)}%`;entry.label.textContent=progress.toFixed(2);
    this.updateHeadings(view,entry,s,progress);
  }
  // Headings of levels 1–3 with their 0-based source lines.
  headings(view){
    const list=view.file&&this.app.metadataCache.getFileCache(view.file)?.headings||[];
    return list.filter(h=>h.level<=HEADING_LEVELS&&String(h.heading||'').trim()&&Number.isInteger(h.position?.start?.line))
      .map(h=>({text:String(h.heading).trim(),level:h.level,line:h.position.start.line}));
  }
  // Where each heading's top sits in the scroller's content, as a fraction of its whole height.
  // A heading's tick meets the dot when the heading is at the same height in the window as the
  // dot is on the ruler. Live Preview: CodeMirror's line heights (estimated off screen). Reading
  // view: Obsidian's section heights, corrected by the sections on screen. Otherwise: the share
  // of lines above the heading.
  fractions(view,s,headings){
    const height=s.scrollHeight,top=s.getBoundingClientRect().top-s.scrollTop;
    const cm=view.getMode?.()==='preview'?null:view.editor?.cm;
    if(height>0&&cm?.lineBlockAt&&cm.state?.doc&&Number.isFinite(cm.documentTop)){
      const lines=cm.state.doc.lines,base=cm.documentTop-top;
      return headings.map(h=>clamp01((base+cm.lineBlockAt(cm.state.doc.line(Math.min(h.line+1,lines)).from).top)/height));
    }
    // Obsidian's sections carry start/end positions ({line,col,offset}); the page header (title,
    // properties) and footer (backlinks) are sections too, with no lines of their own: their
    // heights count, but no heading is paired with them.
    const renderer=view.previewMode?.renderer,sections=renderer?.sections;
    const ui=x=>x===renderer?.header||x===renderer?.footer;
    const text=Array.isArray(sections)?sections.map((x,i)=>i).filter(i=>!ui(sections[i])):[];
    if(height>0&&text.length&&sections.every(x=>Number.isFinite(x?.height))&&text.every(i=>Number.isInteger(sections[i].start?.line)&&Number.isInteger(sections[i].end?.line))){
      const sizer=s.querySelector('.markdown-preview-sizer');
      let y=sizer?sizer.getBoundingClientRect().top-top:0;
      const starts=sections.map(x=>{
        if(x.el?.isConnected&&x.el.offsetParent)y=x.el.getBoundingClientRect().top-top;
        const at=y;y+=x.height;return at;
      });
      // Headings and sections both run down the note: one pass pairs them.
      let j=0;const last=sections[text.at(-1)].end.line;
      return headings.map(h=>{
        while(j<text.length-1&&sections[text[j]].end.line<h.line)j++;
        const x=sections[text[j]],inside=x.start.line<=h.line&&h.line<=x.end.line;
        return clamp01(inside?starts[text[j]]/height:h.line/Math.max(1,last+1));
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
  updateHeadings(view,entry,s,progress){
    const headings=this.showHeadings()?this.headings(view):[];
    if(!headings.length){this.clearHeadings(entry);return;}
    const margin=this.margin(entry,s),compact=margin<MIN_MARGIN;
    entry.el.classList.toggle('is-compact',compact);
    entry.heads.style.setProperty('--aw-heads-width',`${Math.round(compact?LIST_WIDTH:Math.min(LIST_WIDTH,margin-24))}px`);
    const fractions=this.fractions(view,s,headings),height=entry.el.getBoundingClientRect().height;
    const current=currentHeading(fractions,progress);
    const kept=layoutHeadings(headings.map((h,i)=>({index:i,level:h.level,top:fractions[i]*height})),HEADING_GAP,current);
    const doc=entry.el.ownerDocument;
    let near=false;
    kept.forEach((i,n)=>{
      const h=headings[i];
      let mark=entry.marks[n];
      if(!mark){
        mark=doc.createElement('div');
        const text=doc.createElement('span');text.className='aw-ruler-head-text';mark.appendChild(text);
        mark.addEventListener('pointerdown',event=>{
          if(event.button!==0)return;
          event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(mark.dataset.fraction));
        });
        entry.heads.appendChild(mark);entry.marks.push(mark);
      }
      mark.className=`aw-ruler-head is-level-${h.level}${i===current?' is-current':''}`;
      mark.dataset.line=String(h.line);mark.dataset.fraction=String(fractions[i]);mark.title=h.text;mark.firstChild.textContent=h.text;
      mark.style.top=`${(fractions[i]*100).toFixed(2)}%`;
      if(Math.abs(fractions[i]-progress)*height<12)near=true;
    });
    for(const extra of entry.marks.splice(kept.length))extra.remove();
    // On a heading the dot's number would sit on the heading's name: the name says more.
    entry.el.classList.toggle('is-on-heading',near);
  }
  clearHeadings(entry){
    for(const mark of entry.marks)mark.remove();
    entry.marks=[];entry.el.classList.toggle('is-on-heading',false);entry.el.classList.toggle('is-compact',false);
  }
  // Like clicking the ruler at the heading's tick: the dot lands on it, so it is the heading
  // being read, and the heading sits level with the dot (headings near the end cannot reach the
  // top of the window, so scrolling them to the top would leave the dot past them).
  jumpTo(view,fraction){
    const s=this.scroller(view);
    if(s&&Number.isFinite(fraction))s.scrollTop=topFor(fraction,s.scrollHeight,s.clientHeight);
  }
  drag(view,event){
    const entry=this.entries.get(view),s=this.scroller(view);
    if(!entry||!s||event.button!==0)return;
    event.preventDefault();
    const doc=entry.el.ownerDocument,jump=e=>{
      const rect=entry.el.getBoundingClientRect();
      s.scrollTop=topFor((e.clientY-rect.top)/rect.height,s.scrollHeight,s.clientHeight);
    };
    jump(event);entry.el.classList.add('is-dragging');
    const up=()=>{doc.removeEventListener('pointermove',jump);doc.removeEventListener('pointerup',up);entry.el.classList.remove('is-dragging');};
    doc.addEventListener('pointermove',jump);doc.addEventListener('pointerup',up);
  }
  displaySettings(container,Setting){
    new Setting(container).setName('滚动刻度尺').setDesc('在笔记右侧显示阅读位置刻度；可点击或拖动跳转。')
      .addToggle(t=>t.setValue(this.plugin.data.settings.scrollRuler!==false).onChange(v=>{this.plugin.data.settings.scrollRuler=v;this.sync();this.plugin.changed();}));
    new Setting(container).setName('刻度尺旁显示标题').setDesc('在刻度尺左侧的页边列出一到三级标题，位置对应它们在全文中的位置；正在读的标题颜色加深，点击标题跳转过去。页边放不下时，把指针移到刻度尺上才显示。')
      .addToggle(t=>t.setValue(this.showHeadings()).onChange(v=>{this.plugin.data.settings.rulerHeadings=v;this.sync();this.plugin.changed();}));
  }
}
module.exports={ScrollRuler,progressOf,topFor,currentHeading,layoutHeadings};
