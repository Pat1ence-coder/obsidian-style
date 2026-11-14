'use strict';
const {Component,MarkdownView}=require('obsidian');

// Reading progress as a fraction, or null when the note does not scroll.
function progressOf(top,height,client){
  const range=height-client;
  return range>4?Math.min(1,Math.max(0,top/range)):null;
}
function topFor(fraction,height,client){return Math.round(Math.min(1,Math.max(0,fraction))*Math.max(0,height-client));}

// A thin tick ruler on the right of each note (glass style): a dot marks the reading position
// with its fraction beside it; click or drag the ruler to jump.
class ScrollRuler extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.entries=new Map();}
  onload(){
    for(const event of ['layout-change','active-leaf-change','file-open','resize'])this.registerEvent(this.app.workspace.on(event,()=>this.sync()));
    this.app.workspace.onLayoutReady(()=>this.sync());
  }
  onunload(){for(const view of [...this.entries.keys()])this.detach(view);}
  enabled(){const s=this.plugin.data.settings;return s.scrollRuler!==false&&s.style==='glass';}
  sync(){
    const views=this.enabled()?this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).filter(v=>v instanceof MarkdownView):[];
    for(const view of [...this.entries.keys()])if(!views.includes(view)||!view.contentEl?.isConnected)this.detach(view);
    for(const view of views){if(!this.entries.has(view))this.attach(view);this.update(view);}
  }
  attach(view){
    const host=view.contentEl,doc=host.ownerDocument,owner=this.addChild(new Component());
    const el=doc.createElement('div');el.className='aw-ruler';el.setAttribute('aria-hidden','true');
    const knob=doc.createElement('div');knob.className='aw-ruler-knob';
    const label=doc.createElement('span');label.className='aw-ruler-label';
    knob.appendChild(label);el.appendChild(knob);host.appendChild(el);host.classList.add('aw-has-ruler');
    const entry={owner,el,knob,label,frame:0};this.entries.set(view,entry);
    // scroll does not bubble; capture it from whichever scroller the current mode uses.
    owner.registerDomEvent(host,'scroll',()=>this.schedule(view),{capture:true});
    owner.registerDomEvent(el,'pointerdown',event=>this.drag(view,event));
  }
  detach(view){
    const entry=this.entries.get(view);if(!entry)return;
    cancelAnimationFrame(entry.frame);entry.el.remove();view.contentEl?.classList.remove('aw-has-ruler');
    this.removeChild(entry.owner);this.entries.delete(view);
  }
  scroller(view){
    const preview=view.getMode?.()==='preview';
    return view.contentEl.querySelector(preview?'.markdown-reading-view .markdown-preview-view':'.markdown-source-view .cm-scroller');
  }
  schedule(view){
    const entry=this.entries.get(view);
    if(entry&&!entry.frame)entry.frame=requestAnimationFrame(()=>{entry.frame=0;this.update(view);});
  }
  update(view){
    const entry=this.entries.get(view),s=entry&&this.scroller(view);
    if(!entry)return;
    const progress=s?progressOf(s.scrollTop,s.scrollHeight,s.clientHeight):null;
    entry.el.classList.toggle('is-idle',progress===null);
    if(progress===null)return;
    entry.knob.style.top=`${(progress*100).toFixed(2)}%`;entry.label.textContent=progress.toFixed(2);
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
    new Setting(container).setName('滚动刻度尺').setDesc('通透玻璃风格下，在笔记右侧显示阅读位置刻度；可点击或拖动跳转。')
      .addToggle(t=>t.setValue(this.plugin.data.settings.scrollRuler!==false).onChange(v=>{this.plugin.data.settings.scrollRuler=v;this.sync();this.plugin.changed();}));
  }
}
module.exports={ScrollRuler,progressOf,topFor};
