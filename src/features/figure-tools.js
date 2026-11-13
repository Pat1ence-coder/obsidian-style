'use strict';
const {Component,Notice,Setting,TFile,setIcon}=require('obsidian');
const Edit=require('./figure-edit');
const FIGURE='.callout[data-callout="figure"]';
const CAPTIONED='.callout:is([data-callout="figure"],[data-callout="table"]) .callout-title-inner';
const ALIGN=[['left','align-left','左对齐'],['center','align-center','居中'],['right','align-right','右对齐']];
const MIN_WIDTH=40;

// Bold the "图 1" / "表 2" label of a caption; the rest stays a plain text node.
function markLabel(title) {
  if(title.querySelector('.aw-caption-label'))return;
  const first=title.firstChild;
  if(!first||first.nodeType!==3)return;
  const found=Edit.captionLabel(first.textContent);
  if(!found)return;
  const label=title.ownerDocument.createElement('span');
  label.className='aw-caption-label';label.textContent=found.label;
  first.textContent=found.rest;title.insertBefore(label,first);
}

// Hover tools for figure callouts: alignment / column bar, a resize handle on single
// images and drag grips for reordering grids. Every change is written back to the
// note's Markdown, so print and PDF follow the same layout.
class FigureTools extends Component {
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.documents=new Map();this.decorated=new WeakSet();this.gesture=null;}
  onload(){
    this.attachDocument(this.app.workspace.containerEl?.ownerDocument);
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.attachDocument(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>{
      const owner=this.documents.get(win.document);
      if(owner){this.removeChild(owner);this.documents.delete(win.document);}
    }));
    this.plugin.registerMarkdownPostProcessor((el,ctx)=>this.process(el,ctx));
  }
  onunload(){this.endGesture();this.documents.clear();}
  enabled(){return this.plugin.data.settings.figureTools!==false;}
  attachDocument(doc){
    if(!doc||this.documents.has(doc))return;
    const owner=this.addChild(new Component());this.documents.set(doc,owner);
    owner.registerDomEvent(doc,'mouseover',event=>this.hover(event));
    owner.registerDomEvent(doc,'pointerdown',event=>this.pointerDown(event),true);
  }
  // Reading view (and rendered callouts in Live Preview): label captions and remember
  // which source line each figure starts on.
  process(el,ctx){
    const titles=[...el.querySelectorAll(CAPTIONED)];
    if(el.matches?.(CAPTIONED))titles.push(el);
    titles.forEach(markLabel);
    const info=ctx?.getSectionInfo?.(el);
    if(!info)return;
    const figures=[...el.querySelectorAll(FIGURE)];
    if(el.matches?.(FIGURE))figures.push(el);
    for(const figure of figures){figure.dataset.awLine=String(info.lineStart);figure.dataset.awSource=ctx.sourcePath;}
  }
  hover(event){
    if(!this.enabled()||this.gesture)return;
    const figure=event.target?.closest?.(FIGURE);
    if(!figure||this.decorated.has(figure)||!figure.closest('.markdown-preview-view,.markdown-source-view'))return;
    this.decorate(figure);
  }
  decorate(figure){
    this.decorated.add(figure);
    const doc=figure.ownerDocument,meta=figure.dataset.calloutMetadata||'center',grid=meta.startsWith('grid-');
    const title=figure.querySelector(':scope > .callout-title .callout-title-inner');
    if(title)markLabel(title);
    figure.classList.add('aw-figure-editable');
    const bar=doc.createElement('div');bar.className='aw-figure-bar';bar.contentEditable='false';
    const add=(value,label,iconName,text)=>{
      const b=doc.createElement('button');b.type='button';b.className='aw-figure-option';
      b.dataset.awMeta=value;b.title=label;b.setAttribute('aria-label',label);
      b.setAttribute('aria-pressed',String(value===meta));
      if(iconName)setIcon(b,iconName);else b.textContent=text;
      bar.appendChild(b);
    };
    if(grid){
      const caption=doc.createElement('span');caption.className='aw-figure-bar-label';caption.textContent='列';bar.appendChild(caption);
      for(let n=1;n<=4;n++)add(`grid-${n}`,`${n} 列`,null,String(n));
    }else for(const [value,iconName,label] of ALIGN)add(value,label,iconName);
    figure.appendChild(bar);
    figure.querySelectorAll('.image-embed').forEach((embed,index)=>{
      const handle=doc.createElement('span');handle.contentEditable='false';handle.dataset.awIndex=String(index);
      if(grid){handle.className='aw-figure-grip';handle.title='拖到另一张图上交换顺序';setIcon(handle,'grip-vertical');}
      else{handle.className='aw-figure-resize';handle.title='拖动调整宽度';}
      embed.appendChild(handle);
    });
  }
  pointerDown(event){
    if(!this.enabled()||event.button!==0)return;
    const target=event.target?.closest?.('.aw-figure-option,.aw-figure-resize,.aw-figure-grip');
    const figure=target?.closest(FIGURE);
    if(!figure)return;
    // Keep CodeMirror from moving the cursor into the callout source.
    event.preventDefault();event.stopPropagation();
    if(target.classList.contains('aw-figure-option')){
      const meta=target.dataset.awMeta;
      if(target.getAttribute('aria-pressed')!=='true')void this.edit(figure,(lines,block)=>Edit.setMeta(lines,block,meta));
      return;
    }
    const index=Number(target.dataset.awIndex),embed=target.closest('.image-embed');
    if(target.classList.contains('aw-figure-resize'))this.startResize(event,figure,embed,index);
    else this.startReorder(event,figure,embed,index);
  }
  startResize(event,figure,embed,index){
    const img=embed?.querySelector('img');
    if(!img)return;
    const start=img.getBoundingClientRect().width,x=event.clientX;
    let width=start;
    figure.classList.add('aw-figure-resizing');
    this.beginGesture(figure.ownerDocument,move=>{
      width=Math.max(MIN_WIDTH,Math.round(start+move.clientX-x));
      img.style.width=width+'px';embed.dataset.awWidth=`${Math.round(width/10)*10}px`;
    },()=>{
      figure.classList.remove('aw-figure-resizing');
      const final=Math.min(4096,Math.max(MIN_WIDTH,Math.round(width/10)*10));
      if(Math.abs(width-start)<3){img.style.width='';delete embed.dataset.awWidth;return;}
      void this.edit(figure,(lines,block)=>Edit.setWidth(lines,block,index,final));
    });
  }
  startReorder(event,figure,embed,from){
    const embeds=[...figure.querySelectorAll('.image-embed')];
    let to=from;
    embed.classList.add('aw-figure-dragging');
    this.beginGesture(figure.ownerDocument,move=>{
      const over=figure.ownerDocument.elementFromPoint(move.clientX,move.clientY)?.closest?.('.image-embed');
      const next=embeds.indexOf(over);
      if(next<0||next===to)return;
      embeds[to]?.classList.remove('aw-figure-drop');to=next;
      if(to!==from)embeds[to].classList.add('aw-figure-drop');
    },()=>{
      embeds.forEach(e=>e.classList.remove('aw-figure-dragging','aw-figure-drop'));
      if(to!==from)void this.edit(figure,(lines,block)=>Edit.moveImage(lines,block,from,to));
    });
  }
  beginGesture(doc,onMove,onEnd){
    this.endGesture();
    const move=event=>onMove(event);
    const up=()=>{this.endGesture();onEnd();};
    doc.addEventListener('pointermove',move);doc.addEventListener('pointerup',up);
    this.gesture={doc,move,up};
  }
  endGesture(){
    if(!this.gesture)return;
    const {doc,move,up}=this.gesture;
    doc.removeEventListener('pointermove',move);doc.removeEventListener('pointerup',up);
    this.gesture=null;
  }
  // Live Preview edits go through the editor (undoable); reading view edits rewrite
  // the file after checking the recorded block is still where it was rendered.
  locate(figure){
    if(figure.closest('.markdown-source-view')){
      const view=this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).find(v=>v?.containerEl?.contains(figure));
      const editor=view?.editor,cm=editor?.cm;
      if(!editor||typeof cm?.posAtDOM!=='function')return null;
      const line=cm.state.doc.lineAt(cm.posAtDOM(figure)).number-1;
      return {apply:change=>{
        const lines=editor.getValue().split('\n'),block=Edit.findBlock(lines,line);
        if(!block)throw Error('这里不是插图块。');
        const next=change(lines,block);
        editor.replaceRange(next.slice(block.start,block.end+1).join('\n'),{line:block.start,ch:0},{line:block.end,ch:lines[block.end].length});
      }};
    }
    const line=Number(figure.dataset.awLine),file=this.app.vault.getAbstractFileByPath(figure.dataset.awSource||'');
    if(!Number.isInteger(line)||!(file instanceof TFile))return null;
    return {apply:change=>this.app.vault.process(file,data=>{
      const eol=data.includes('\r\n')?'\r\n':'\n',lines=data.split(eol),block=Edit.findBlock(lines,line);
      if(!block||block.start!==line)throw Error('笔记内容已变化，请刷新后重试。');
      return change(lines,block).join(eol);
    })};
  }
  async edit(figure,change){
    try{
      const located=this.locate(figure);
      if(!located){new Notice('无法定位这张插图的源码，请在编辑或阅读视图中重试。');return;}
      await located.apply(change);
    }catch(error){new Notice(error?.message||'修改插图失败。');}
  }
  displaySettings(container){
    new Setting(container).setName('插图编辑工具').setDesc('悬停插图时显示对齐与列数工具条；单图可拖动右下角调整宽度，多图组可拖动图片交换顺序。修改直接写回 Markdown。')
      .addToggle(t=>t.setValue(this.enabled()).onChange(v=>{this.plugin.data.settings.figureTools=v;this.plugin.applyAppearanceEverywhere();this.plugin.changed();}));
  }
}
module.exports={FigureTools,markLabel};
