'use strict';
const {Component,Notice,Setting,TFile,setIcon}=require('obsidian');
const Edit=require('./figure-edit');
const FIGURE='.callout[data-callout="figure"]';
const CAPTIONED='.callout:is([data-callout="figure"],[data-callout="table"]) .callout-title-inner';
const ALIGN=[['left','align-left','左对齐'],['center','align-center','居中'],['right','align-right','右对齐']];
const MOSAIC=[['mosaic-left','layout-panel-left','大图在左'],['mosaic-right','layout-panel-left','大图在右']];
const MIN_WIDTH=40;
// Resizing snaps to these fractions of the column when the edge comes within SNAP px.
const SNAP_FRACTIONS=[1/4,1/3,1/2,2/3,3/4,1],SNAP=10;
// A drag only targets a slot while the pointer stays this close to the figure.
const REACH=96;
// Edits that name an image by its number need the rendered images and the source to agree.
const numbered=(figure,change)=>(lines,block)=>{
  if(block.images.length!==figure.querySelectorAll('.image-embed').length)throw Error('图片与源码对不上（例如含网络图片），请在源码中修改这组插图。');
  return change(lines,block);
};
const rectIn=(rect,origin)=>({left:rect.left-origin.left,top:rect.top-origin.top,width:rect.width,height:rect.height});
const centre=r=>({x:r.left+r.width/2,y:r.top+r.height/2});
// Nearest slot to a point, or -1 when the point is farther than REACH from every slot edge.
function nearestSlot(slots,x,y){
  let best=-1,bestDistance=Infinity;
  slots.forEach((r,i)=>{
    const dx=Math.max(r.left-x,0,x-(r.left+r.width)),dy=Math.max(r.top-y,0,y-(r.top+r.height));
    const c=centre(r),edge=Math.hypot(dx,dy),distance=edge*1000+Math.hypot(c.x-x,c.y-y);
    if(edge<=REACH&&distance<bestDistance){best=i;bestDistance=distance;}
  });
  return best;
}
// Snap a width to the nearest column fraction within SNAP px; returns {width, fraction|null}.
// In a narrow column neighbouring fractions overlap, so the closest one wins.
function snapWidth(width,column){
  let best=null,bestDistance=Infinity;
  for(const f of SNAP_FRACTIONS){const d=Math.abs(width-column*f);if(d<=SNAP&&d<bestDistance){best=f;bestDistance=d;}}
  return best===null?{width,fraction:null}:{width:Math.round(column*best),fraction:best};
}
// A pointer position in the figure's own coordinates (stable while the page scrolls).
const pointerIn=(figure,event)=>{const r=figure.getBoundingClientRect();return {x:event.clientX-r.left,y:event.clientY-r.top};};
const percent=f=>f===1?'整列':`${Math.round(f*100)}%`;

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

// Hover tools for figure callouts: a layout bar, a resize handle on every image (snapping
// to column fractions with an outline), and a move grip. Dragging a grid image outlines the
// slot it would land in; dragging a single image outlines the left / centre / right
// positions. Every change is written back to the note's Markdown, so print follows.
class FigureTools extends Component {
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.documents=new Map();this.decorated=new WeakSet();this.contexts=new WeakMap();this.gesture=null;}
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
  // Reading view (and rendered callouts in Live Preview): label captions and keep each
  // figure's context, which tells where its section is in the note at edit time.
  process(el,ctx){
    const titles=[...el.querySelectorAll(CAPTIONED)];
    if(el.matches?.(CAPTIONED))titles.push(el);
    titles.forEach(markLabel);
    if(!ctx?.getSectionInfo?.(el))return;
    const figures=[...el.querySelectorAll(FIGURE)];
    if(el.matches?.(FIGURE))figures.push(el);
    for(const figure of figures)this.contexts.set(figure,ctx);
  }
  // The Markdown view a figure belongs to; null for figures in embedded notes, hover previews
  // and other views, which are not edited in place.
  viewOf(figure){
    if(figure.closest('.markdown-embed,.hover-popover'))return null;
    return this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).find(v=>v?.containerEl?.contains(figure))??null;
  }
  hover(event){
    if(!this.enabled()||this.gesture)return;
    const figure=event.target?.closest?.(FIGURE);
    if(!figure||this.decorated.has(figure)||!figure.closest('.markdown-preview-view,.markdown-source-view')||!this.viewOf(figure))return;
    this.decorate(figure);
  }
  decorate(figure){
    this.decorated.add(figure);
    const doc=figure.ownerDocument,meta=figure.dataset.calloutMetadata||'center',group=Edit.isGroup(meta);
    const title=figure.querySelector(':scope > .callout-title .callout-title-inner');
    if(title)markLabel(title);
    figure.classList.add('aw-figure-editable');
    const bar=doc.createElement('div');bar.className='aw-figure-bar';bar.contentEditable='false';
    const add=(value,label,iconName,text,cls='')=>{
      const b=doc.createElement('button');b.type='button';b.className='aw-figure-option'+cls;
      b.dataset.awMeta=value;b.title=label;b.setAttribute('aria-label',label);
      b.setAttribute('aria-pressed',String(value===meta));
      if(iconName)setIcon(b,iconName);else b.textContent=text;
      bar.appendChild(b);
    };
    if(group){
      const caption=doc.createElement('span');caption.className='aw-figure-bar-label';caption.textContent='列';bar.appendChild(caption);
      for(let n=1;n<=4;n++)add(`grid-${n}`,`${n} 列`,null,String(n));
      const rule=doc.createElement('span');rule.className='aw-figure-bar-rule';bar.appendChild(rule);
      for(const [value,iconName,label] of MOSAIC)add(value,label,iconName,null,value==='mosaic-right'?' aw-flip':'');
    }else for(const [value,iconName,label] of ALIGN)add(value,label,iconName);
    figure.appendChild(bar);
    figure.querySelectorAll('.image-embed').forEach((embed,index)=>{
      const grip=doc.createElement('span');grip.contentEditable='false';grip.dataset.awIndex=String(index);grip.className='aw-figure-grip';
      grip.title=group?'拖动到另一个位置':'拖到左、中、右对齐位置';setIcon(grip,group?'grip-vertical':'move');
      const handle=doc.createElement('span');handle.contentEditable='false';handle.dataset.awIndex=String(index);
      handle.className='aw-figure-resize';handle.title='拖动调整宽度';
      embed.append(grip,handle);
    });
  }
  pointerDown(event){
    if(!this.enabled()||event.button!==0)return;
    const target=event.target?.closest?.('.aw-figure-option,.aw-figure-resize,.aw-figure-grip');
    const figure=target?.closest(FIGURE);
    if(!figure)return;
    // Keep CodeMirror from moving the cursor into the callout source.
    event.preventDefault();event.stopPropagation();
    // Settle any gesture still open before the next one marks up the DOM.
    this.endGesture(true);
    if(target.classList.contains('aw-figure-option')){
      const meta=target.dataset.awMeta;
      if(target.getAttribute('aria-pressed')!=='true')void this.edit(figure,(lines,block)=>Edit.setMeta(lines,block,meta));
      return;
    }
    const index=Number(target.dataset.awIndex),embed=target.closest('.image-embed');
    if(target.classList.contains('aw-figure-resize'))this.startResize(event,figure,embed,index);
    else if(Edit.isGroup(figure.dataset.calloutMetadata||''))this.startReorder(event,figure,embed,index);
    else this.startAlign(event,figure,embed);
  }
  // An outline drawn over the figure (absolute, in figure coordinates) during a gesture.
  outline(figure,cls,label){
    const box=figure.ownerDocument.createElement('div');box.className='aw-figure-outline '+cls;box.contentEditable='false';
    if(label){const tag=figure.ownerDocument.createElement('span');tag.className='aw-figure-outline-label';tag.textContent=label;box.appendChild(tag);}
    figure.appendChild(box);this.gesture?.overlays.push(box);return box;
  }
  place(box,rect){
    if(!rect){box.hidden=true;return;}
    box.hidden=false;
    for(const k of ['left','top','width','height'])box.style[k]=Math.round(rect[k])+'px';
  }
  startResize(event,figure,embed,index){
    const img=embed?.querySelector('img');
    if(!img)return;
    const group=Edit.isGroup(figure.dataset.calloutMetadata||'');
    const start=img.getBoundingClientRect(),x=event.clientX,ratio=start.height/Math.max(1,start.width);
    // Single images snap to fractions of the text column; grid images are capped by their cell.
    const column=group?null:(figure.querySelector(':scope > .callout-content')?.getBoundingClientRect().width||null);
    let width=start.width,fraction=null;
    // While dragging, the embed box follows the image so the dot stays on the image's corner
    // (images that fill their cell or column otherwise leave the box at full width), and the
    // screen cap on unsized images is lifted so a snap to 整列 really fills the column.
    const preview=()=>{img.style.width='';img.style.maxWidth='';embed.style.width='';embed.style.maxWidth='';};
    figure.classList.add('aw-figure-resizing');embed.style.width='fit-content';
    if(column){img.style.maxWidth='100%';embed.style.maxWidth='100%';}
    this.beginGesture(figure.ownerDocument,{
      cleanup:()=>{figure.classList.remove('aw-figure-resizing');delete embed.dataset.awWidth;},
      revert:preview,
    });
    const guide=column?this.outline(figure,'aw-figure-guide',''):null;
    if(guide)guide.hidden=true;
    this.gesture.onMove=move=>{
      const raw=Math.max(MIN_WIDTH,start.width+move.clientX-x),snapped=column?snapWidth(raw,column):{width:raw,fraction:null};
      width=Math.min(snapped.width,column||Infinity);fraction=snapped.fraction;
      img.style.width=Math.round(width)+'px';
      const shown=Math.round(img.getBoundingClientRect().width||width);
      embed.dataset.awWidth=fraction?`${shown}px · ${percent(fraction)}`:`${Math.round(shown/10)*10}px`;
      if(guide){
        if(fraction){
          const at=rectIn(img.getBoundingClientRect(),figure.getBoundingClientRect());
          this.place(guide,{left:at.left,top:at.top,width:shown,height:shown*ratio});
        }else guide.hidden=true;
      }
    };
    // The preview stays until the note re-renders with the new width; if nothing is written
    // (no real change, or the write fails) the image goes back to how it was.
    this.gesture.onEnd=async()=>{
      const shown=img.getBoundingClientRect().width||width;
      if(Math.abs(shown-start.width)<3){preview();return;}
      const final=Math.min(4096,Math.max(MIN_WIDTH,fraction?Math.round(shown):Math.round(shown/10)*10));
      if(!await this.edit(figure,numbered(figure,(lines,block)=>Edit.setWidth(lines,block,index,final))))preview();
    };
  }
  // Grid / mosaic: a small copy of the image follows the pointer; the nearest slot is outlined.
  startReorder(event,figure,embed,from){
    const embeds=[...figure.querySelectorAll('.image-embed')],origin=figure.getBoundingClientRect();
    // Slots are kept in figure coordinates, so scrolling during the drag doesn't shift them.
    const slots=embeds.map(e=>rectIn(e.getBoundingClientRect(),origin));
    let to=from;
    this.beginGesture(figure.ownerDocument,{cleanup:this.lift(figure,embed)});
    const slot=this.outline(figure,'aw-figure-slot','放到这里');slot.hidden=true;
    const ghost=this.ghost(embed,event);
    this.gesture.onMove=move=>{
      this.moveGhost(ghost,move);
      const at=pointerIn(figure,move);
      to=nearestSlot(slots,at.x,at.y);
      this.place(slot,to<0||to===from?null:slots[to]);
    };
    this.gesture.onEnd=()=>{if(to>=0&&to!==from)void this.edit(figure,numbered(figure,(lines,block)=>Edit.moveImage(lines,block,from,to)));};
  }
  // Single image: three outlines (left / centre / right) of the image's size; drop on one to align.
  startAlign(event,figure,embed){
    const img=embed?.querySelector('img'),content=figure.querySelector(':scope > .callout-content');
    if(!img||!content)return;
    const doc=figure.ownerDocument,origin=figure.getBoundingClientRect(),box=rectIn(img.getBoundingClientRect(),origin),area=rectIn(content.getBoundingClientRect(),origin);
    const current=figure.dataset.calloutMetadata||'center';
    // A full-width image has nowhere to move: say so instead of offering identical targets.
    if(area.width-box.width<24){
      this.beginGesture(doc);
      this.place(this.outline(figure,'aw-figure-slot','图片已占满整列，先拖动右下角缩小'),box);
      return;
    }
    const positions=[['left',area.left],['center',area.left+(area.width-box.width)/2],['right',area.left+area.width-box.width]];
    const slots=positions.map(([,left])=>({left,top:box.top,width:box.width,height:box.height}));
    this.beginGesture(doc,{cleanup:this.lift(figure,embed)});
    const outlines=positions.map(([meta],i)=>{
      const o=this.outline(figure,'aw-figure-slot aw-figure-slot-quiet',{left:'左对齐',center:'居中',right:'右对齐'}[meta]);o.dataset.awSlot=meta;
      this.place(o,slots[i]);if(meta===current)o.hidden=true;return o;
    });
    const ghost=this.ghost(embed,event);
    let target=-1;
    this.gesture.onMove=move=>{
      this.moveGhost(ghost,move);
      const at=pointerIn(figure,move);
      target=nearestSlot(slots,at.x,at.y);
      outlines.forEach((o,i)=>o.classList.toggle('is-target',i===target));
    };
    this.gesture.onEnd=()=>{
      const meta=positions[target]?.[0];
      if(meta&&meta!==current)void this.edit(figure,(lines,block)=>Edit.setMeta(lines,block,meta));
    };
  }
  // Mark the image as picked up; returns the undo for the gesture's cleanup.
  lift(figure,embed){
    embed.classList.add('aw-figure-dragging');figure.classList.add('aw-figure-moving');
    return ()=>{embed.classList.remove('aw-figure-dragging');figure.classList.remove('aw-figure-moving');};
  }
  ghost(embed,event){
    const img=embed.querySelector('img'),doc=embed.ownerDocument;
    if(!img)return null;
    const ghost=doc.createElement('img');ghost.className='aw-figure-ghost';ghost.src=img.currentSrc||img.src;ghost.alt='';
    doc.body.appendChild(ghost);this.gesture?.overlays.push(ghost);this.moveGhost(ghost,event);return ghost;
  }
  moveGhost(ghost,event){if(ghost){ghost.style.left=event.clientX+'px';ghost.style.top=event.clientY+'px';}}
  // One gesture at a time. However it ends, overlays are removed and cleanup() runs;
  // revert() also undoes live previews when the gesture is abandoned instead of completed:
  // Escape, a cancelled pointer (system gesture, touch scroll, pen out of range) or unload.
  beginGesture(doc,{cleanup=null,revert=null}={}){
    this.endGesture(true);
    const gesture={doc,overlays:[],cleanup,revert,onMove:null,onEnd:null};
    gesture.move=event=>gesture.onMove?.(event);
    gesture.up=()=>{const done=gesture.onEnd;this.endGesture(false);void done?.();};
    gesture.abort=()=>this.endGesture(true);
    // Escape is consumed here so the editor doesn't also act on it (Vim mode, popovers).
    gesture.key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.endGesture(true);}};
    doc.addEventListener('pointermove',gesture.move);doc.addEventListener('pointerup',gesture.up);
    doc.addEventListener('pointercancel',gesture.abort);doc.addEventListener('keydown',gesture.key,true);
    this.gesture=gesture;
  }
  endGesture(cancelled=true){
    const g=this.gesture;
    if(!g)return;
    this.gesture=null;
    g.doc.removeEventListener('pointermove',g.move);g.doc.removeEventListener('pointerup',g.up);
    g.doc.removeEventListener('pointercancel',g.abort);g.doc.removeEventListener('keydown',g.key,true);
    for(const node of g.overlays)node.remove();
    g.cleanup?.();
    if(cancelled)g.revert?.();
  }
  // Live Preview edits go through the editor (undoable); reading view edits rewrite the file
  // after checking the block is still what the view shows. apply() resolves to whether the
  // note changed.
  locate(figure){
    const view=this.viewOf(figure);
    if(!view)return null;
    if(figure.closest('.markdown-source-view')){
      const editor=view.editor,cm=editor?.cm;
      if(!editor||typeof cm?.posAtDOM!=='function'||typeof cm.dispatch!=='function')return null;
      const line=cm.state.doc.lineAt(cm.posAtDOM(figure)).number-1;
      return {apply:change=>{
        const lines=editor.getValue().split('\n'),block=Edit.findBlock(lines,line);
        if(!block)throw Error('这里不是插图块。');
        const doc=cm.state.doc,insert=change(lines,block).slice(block.start,block.end+1).join('\n');
        if(insert===lines.slice(block.start,block.end+1).join('\n'))return false;
        // Straight to CodeMirror, still one undoable step. Editor.replaceRange would also scroll
        // the cursor into view, and the cursor is wherever it was before the click (the toolbar
        // keeps it out of the callout), often the top of the note: the page would jump there.
        // Not an "input." event: a layout change is not writing, and is never merged into the
        // typing before it in the undo history.
        cm.dispatch({changes:{from:doc.line(block.start+1).from,to:doc.line(block.end+1).to,insert},userEvent:'set.figure'});
        return true;
      }};
    }
    // Reading view: where the figure's section is now (Obsidian moves unchanged sections without
    // running post-processors again), in the file the view shows now (it may have been renamed).
    const info=this.contexts.get(figure)?.getSectionInfo?.(figure),file=view.file;
    if(!info||!(file instanceof TFile))return null;
    const line=info.lineStart,shown=String(info.text??'').split(/\r?\n/);
    return {apply:async change=>{
      let changed=false;
      await this.app.vault.process(file,data=>{
        const eol=data.includes('\r\n')?'\r\n':'\n',lines=data.split(eol),block=Edit.findBlock(lines,line);
        const same=block&&block.start===line&&lines.slice(block.start,block.end+1).join('\n')===shown.slice(block.start,block.end+1).join('\n');
        if(!same)throw Error('笔记内容已变化，请稍后重试。');
        const next=change(lines,block);
        changed=next.length!==lines.length||next.some((l,i)=>l!==lines[i]);
        return changed?next.join(eol):data;
      });
      return changed;
    }};
  }
  // Resolves true once the change is written; false when there was nothing to change, or after
  // showing why it wasn't written.
  async edit(figure,change){
    try{
      const located=this.locate(figure);
      if(!located){new Notice('无法定位这张插图的源码，请在编辑或阅读视图中重试。');return false;}
      return await located.apply(change)!==false;
    }catch(error){new Notice(error?.message||'修改插图失败。');return false;}
  }
  displaySettings(container){
    new Setting(container).setName('插图编辑工具').setDesc('悬停插图时显示布局工具条；拖动右下角圆点调整宽度（单图靠近 1/4、1/3、1/2、2/3、3/4、整列时吸附）；拖动左上角手柄：多图组移动图片位置，单图移到左、中、右对齐。拖动时会显示目标位置的轮廓，按 Esc 取消。修改直接写回 Markdown。')
      .addToggle(t=>t.setValue(this.enabled()).onChange(v=>{this.plugin.data.settings.figureTools=v;this.plugin.applyAppearanceEverywhere();this.plugin.changed();}));
  }
}
module.exports={FigureTools,markLabel,nearestSlot,snapWidth,numbered};
