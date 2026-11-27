'use strict';
const {Component,MarkdownView,Modal,Notice,Setting,TFile,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
let syntaxTree=null;
try{({syntaxTree}=require('@codemirror/language'));}catch{}
const Core=require('../core');
const Format=require('./annotation-format');
const Center=require('./annotation-center');
const {parseAnnotation,findAnnotations,formatAnnotation,targetClasses,noteTree,collectNoteAnnotations,replaceNoteAnnotation,replaceSectionAnnotation,findAdjacentAnnotation,findClosestVisibleIndex,chooseMarginSide,distributeMarginNotes,buildMarginConnector,formatAnnotationSummary,sameSpec,DIRECTIONS,COLORS,LINES}=Format;
const SVG='http://www.w3.org/2000/svg';
const STYLE_KEYS=['dir','color','custom','line','highlight'];
const MARGIN_GAP=12,MARGIN_CONNECTOR_GAP=38,MARGIN_MIN_EXTRA=52,RULER_CLEARANCE=36,FLASH_MS=900;

function tint(el,spec){
  if(spec.color==='custom'&&spec.custom)el.style?.setProperty?.('--aw-annot-color',spec.custom);
  return el;
}
// The note element for an annotation (reading view and Live Preview build the same thing).
function build(doc,node){
  const el=node.svg?doc.createElementNS(SVG,node.tag):doc.createElement(node.tag);
  if(node.cls)el.className=node.cls;
  for(const [k,v] of Object.entries(node.attrs||{}))el.setAttribute(k,v);
  if(node.color)el.style.setProperty('--aw-annot-color',node.color);
  if(node.text!=null)el.textContent=node.text;
  for(const child of node.children||[])el.appendChild(build(doc,child));
  return el;
}
const noteNode=(doc,spec)=>build(doc,noteTree(spec));
const livePreview=state=>!editorLivePreviewField||state.field(editorLivePreviewField,false)===true;
const treeOf=state=>typeof syntaxTree==='function'?syntaxTree(state):null;
// Code, math, comments and front matter keep their text as written (reading view makes no
// highlight there either). Obsidian names a token's syntax node after its classes, joined by _.
const VERBATIM=/(?:^|_)(?:inline-code|hmd-codeblock|math|comment|hmd-frontmatter)(?:_|$)/;
const verbatim=(state,pos)=>{const t=treeOf(state);return t?VERBATIM.test(t.resolveInner(pos,1).type.name):false;};

// Keep row-start / row-end pinned notes inside the visible note column without moving their pin.
const clampPending=new WeakSet();
function clampNotes(root){
  if(!root?.querySelectorAll||typeof root.getBoundingClientRect!=='function')return;
  const box=root.closest?.('.markdown-preview-view,.cm-scroller')||root;
  if(typeof box.getBoundingClientRect!=='function')return;
  const bounds=box.getBoundingClientRect();
  if(!(bounds.width>40))return;
  const minX=bounds.left+8,maxX=bounds.right-8,avail=maxX-minX,reads=[];
  for(const el of root.querySelectorAll('.aw-annot-pin .aw-annot-text')){
    if(el.closest?.('.aw-annot-in-margin')||typeof el.getBoundingClientRect!=='function')continue;
    const rect=el.getBoundingClientRect();
    if(!(rect.width>0))continue;
    const cur=parseFloat(el.dataset?.awNudge||'0')||0;
    reads.push({el,cur,left:rect.left-cur,right:rect.right-cur,width:rect.width});
  }
  for(const {el,cur,left,right,width} of reads){
    let next=0;
    if(width>=avail||left<minX)next=Math.round(minX-left);
    else if(right>maxX)next=Math.round(maxX-right);
    next=Math.max(-200,Math.min(200,next));
    if(next===cur)continue;
    if(next===0){if(el.dataset)delete el.dataset.awNudge;el.style?.removeProperty?.('--aw-annot-nudge');}
    else{if(el.dataset)el.dataset.awNudge=String(next);el.style?.setProperty?.('--aw-annot-nudge',next+'px');}
  }
}
function scheduleClamp(root){
  if(!root||typeof root.getBoundingClientRect!=='function'||clampPending.has(root))return;
  const raf=root.ownerDocument?.defaultView?.requestAnimationFrame;
  if(typeof raf!=='function'){clampNotes(root);return;}
  clampPending.add(root);
  raf(()=>{clampPending.delete(root);clampNotes(root);});
}

// Live Preview: the annotation is drawn unless the cursor is on it, in which case the source
// stays editable (as Obsidian does for its own formatting).
function editorExtension(){
  // Every annotation is pinned against its target's box, so the whole ==target=={note} is one
  // widget: the target words with the note inside them, built as in reading view. Placing the
  // note inside a mark instead depends on how CodeMirror nests this plugin's decorations with
  // Obsidian's own (which hide the == and tint the highlight); in one order the note ends up
  // outside the target and is placed against the whole line.
  class PinnedWidget extends WidgetType{
    constructor(spec,target){super();this.spec=spec;this.target=target;}
    eq(other){return other.target===this.target&&sameSpec(other.spec,this.spec);}
    toDOM(view){
      const doc=view.dom.ownerDocument,el=doc.createElement('span');
      el.className=targetClasses(this.spec,this.target).join(' ');tint(el,this.spec);
      el.appendChild(doc.createTextNode(this.target));el.appendChild(noteNode(doc,this.spec));
      return el;
    }
    ignoreEvent(){return false;}
  }
  const buildDecorations=view=>{
    if(!livePreview(view.state))return Decoration.none;
    const doc=view.state.doc,ranges=view.state.selection.ranges,seen=new Map();
    for(const {from,to} of view.visibleRanges){
      // Whole lines, so a match is never cut at the viewport edge.
      const start=doc.lineAt(from).from,end=doc.lineAt(to).to;
      for(const a of findAnnotations(view.state.sliceDoc(start,end),start))seen.set(a.from,a);
    }
    const out=[];
    for(const a of [...seen.values()].sort((x,y)=>x.markFrom-y.markFrom)){
      if(verbatim(view.state,a.markFrom)||verbatim(view.state,a.from))continue;
      if(ranges.some(r=>r.from<=a.to&&r.to>=a.markFrom)){out.push(Decoration.mark({class:'aw-annot-source'}).range(a.from,a.to));continue;}
      out.push(Decoration.replace({widget:new PinnedWidget(a,view.state.sliceDoc(a.targetFrom,a.targetTo))}).range(a.markFrom,a.to));
    }
    return Decoration.set(out,true);
  };
  return ViewPlugin.fromClass(class{
    constructor(view){this.decorations=buildDecorations(view);scheduleClamp(view.dom);}
    update(update){
      // The syntax tree also arrives in steps after a change: code found later is left alone then.
      if(update.docChanged||update.viewportChanged||update.selectionSet||livePreview(update.startState)!==livePreview(update.state)
        ||treeOf(update.startState)!==treeOf(update.state)){
        this.decorations=buildDecorations(update.view);
        scheduleClamp(update.view.dom);
      }else if(update.geometryChanged)scheduleClamp(update.view.dom);
    }
  },{decorations:plugin=>plugin.decorations});
}

// The add / edit dialog: note, live preview, position (3×3 around the text), colour, highlight, line.
class AnnotationModal extends Modal{
  constructor(app,spec,{title,action,onRemove}={},submit){
    super(app);this.spec={...Format.DEFAULTS,...spec};this.title=title;this.action=action;this.onRemove=onRemove;this.submit=submit;
  }
  onOpen(){
    const el=this.contentEl,doc=el.ownerDocument;
    this.setTitle(this.title);el.addClass('aw-annot-modal');
    this.modalEl?.addEventListener?.('keydown',event=>{
      if((event.metaKey||event.ctrlKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();this.done();}
    });
    let renderPreview=()=>{};
    new Setting(el).setName('笔记').addText(t=>{
      t.setPlaceholder('输入标注…').setValue(this.spec.note||'').onChange(v=>{this.spec.note=v;renderPreview();});
      t.inputEl.maxLength=Format.MAX_NOTE;this.noteInput=t.inputEl;
      t.inputEl.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();this.done();}});
    });
    const preview=el.createDiv({cls:'aw-annot-preview'}),lineEl=preview.createSpan({cls:'aw-annot-preview-line'});
    renderPreview=()=>{
      lineEl.replaceChildren();
      const sample={...this.spec,note:String(this.spec.note||'').trim()||'手写批注预览'};
      const note=noteNode(doc,sample),mark=doc.createElement('mark');
      mark.className=targetClasses(sample,'目标文字').join(' ');tint(mark,sample);
      mark.appendChild(doc.createTextNode('目标文字'));
      mark.appendChild(note);
      lineEl.appendChild(doc.createTextNode('示例前文 '));
      lineEl.appendChild(mark);
      lineEl.appendChild(doc.createTextNode(' 示例后文'));
    };
    const pickers=el.createDiv({cls:'aw-annot-pickers'});
    const group=name=>{const box=pickers.createDiv({cls:'aw-annot-picker'});box.createDiv({cls:'aw-annot-picker-name',text:name});return box;};
    const choose=(buttons,key,value)=>{this.spec[key]=value;for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.value===value));renderPreview();};
    // Position: six pinned directions above and below a centred "文字" chip.
    const compass=group('位置').createDiv({cls:'aw-annot-compass'}),dirs=[];
    for(const id of ['nw','n','ne','center','sw','s','se']){
      if(id==='center'){compass.createSpan({cls:'aw-annot-compass-center',text:'文字'});continue;}
      const d=DIRECTIONS.find(x=>x.id===id),b=compass.createEl('button',{cls:'aw-annot-choice',text:d.arrow,attr:{type:'button','aria-label':d.label}});
      b.dataset.value=id;b.addEventListener('click',()=>choose(dirs,'dir',id));dirs.push(b);
    }
    choose(dirs,'dir',this.spec.dir);
    // Colour: eight named colours and a custom one.
    const swatches=group('颜色').createDiv({cls:'aw-annot-swatches'}),colors=[];
    for(const c of COLORS){
      const b=swatches.createEl('button',{cls:'aw-annot-choice aw-annot-c-'+c.id,attr:{type:'button'}});
      b.createSpan({cls:'aw-annot-dot'});b.createSpan({text:c.label});
      b.dataset.value=c.id;b.addEventListener('click',()=>{this.spec.custom=null;choose(colors,'color',c.id);});colors.push(b);
    }
    const custom=swatches.createEl('label',{cls:'aw-annot-choice aw-annot-custom'});
    const picker=custom.createEl('input',{attr:{type:'color','aria-label':'自定义颜色'}});picker.value=this.spec.custom||'#d0428a';
    custom.createSpan({text:'自定义'});custom.dataset.value='custom';colors.push(custom);
    picker.addEventListener('input',()=>{this.spec.custom=picker.value;choose(colors,'color','custom');});
    choose(colors,'color',this.spec.color);
    new Setting(el).setName('高亮标注目标')
      .addToggle(t=>t.setValue(this.spec.highlight!==false).onChange(v=>{this.spec.highlight=v;renderPreview();}));
    new Setting(el).setName('线条')
      .addDropdown(d=>{for(const l of LINES)d.addOption(l.id,l.label);d.setValue(this.spec.line).onChange(v=>{this.spec.line=v;renderPreview();});});
    const footer=new Setting(el);
    if(typeof this.onRemove==='function'){
      footer.addButton(b=>{
        b.setButtonText('删除标注').onClick(()=>{try{this.onRemove();this.close();}catch(error){new Notice(error?.message||'删除标注失败。');}});
        b.buttonEl?.classList?.add?.('mod-warning');
      });
    }
    footer.addButton(b=>b.setButtonText('取消').onClick(()=>this.close()))
      .addButton(b=>b.setButtonText(this.action).setCta().onClick(()=>this.done()));
    doc.defaultView?.setTimeout(()=>this.noteInput?.focus(),0);
  }
  done(){
    if(!String(this.spec.note||'').trim()){new Notice('请填写标注内容。');this.noteInput?.focus();return;}
    try{this.submit(this.spec);this.close();}catch(error){new Notice(error?.message||'标注没有写入。');}
  }
  onClose(){this.contentEl.empty();}
}

// Lightweight single-line quick annotation modal: Enter submits immediately with the last chosen style.
class QuickAnnotationModal extends Modal{
  constructor(app,target,spec,submit){
    super(app);this.targetText=target;this.spec={...Format.DEFAULTS,...spec};this.submit=submit;
  }
  onOpen(){
    const el=this.contentEl,doc=el.ownerDocument;
    this.setTitle(this.spec.note?'编辑快速标注':'快速标注');
    el.addClass('aw-annot-modal');el.addClass('aw-annot-quick');
    const chip=el.createDiv({cls:'aw-annot-quick-target'});
    chip.createSpan({cls:'aw-annot-quick-quote',text:this.targetText});
    new Setting(el).setClass('aw-annot-quick-field').addText(t=>{
      t.setPlaceholder('输入标注，回车完成…').setValue(this.spec.note||'').onChange(v=>{this.spec.note=v;});
      t.inputEl.maxLength=Format.MAX_NOTE;this.noteInput=t.inputEl;
      t.inputEl.addEventListener('keydown',event=>{
        if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();this.done();}
      });
    });
    new Setting(el)
      .addButton(b=>b.setButtonText('取消').onClick(()=>this.close()))
      .addButton(b=>b.setButtonText(this.spec.note?'保存':'添加').setCta().onClick(()=>this.done()));
    doc.defaultView?.setTimeout(()=>{this.noteInput?.focus();this.noteInput?.select?.();},0);
  }
  done(){
    if(!String(this.spec.note||'').trim()){new Notice('请填写标注内容。');this.noteInput?.focus();return;}
    try{
      if(this.submit(this.spec)===false){new Notice('笔记内容已变化，请重新选中文字后再试。');return;}
      this.close();
    }catch(error){new Notice(error?.message||'标注没有写入。');}
  }
  onClose(){this.noteInput=null;this.contentEl.empty();}
}

// Current-note annotation browser: filter, click to jump to line, or copy Markdown summary.
class AnnotationSummaryModal extends Modal{
  constructor(app,{title,items,onJump,onCopy}){
    super(app);this.noteTitle=title;this.items=items;this.onJump=onJump;this.onCopy=onCopy;
  }
  onOpen(){
    const el=this.contentEl;
    this.setTitle(`标注汇总 · ${this.noteTitle}`);el.addClass('aw-annot-modal');
    const head=el.createDiv({cls:'aw-annot-summary-head'});
    const countEl=head.createSpan({cls:'aw-annot-summary-count',text:`共 ${this.items.length} 条标注`});
    let query='';
    const listEl=el.createDiv({cls:'aw-annot-summary-list'});
    const render=()=>{
      listEl.replaceChildren();
      const q=query.trim().toLowerCase();
      const shown=q?this.items.filter(a=>a.target.toLowerCase().includes(q)||a.note.toLowerCase().includes(q)):this.items;
      countEl.textContent=q?`匹配 ${shown.length} / ${this.items.length} 条标注`:`共 ${this.items.length} 条标注`;
      if(!shown.length){
        listEl.createDiv({cls:'aw-annot-summary-empty',text:this.items.length?'没有匹配的标注。':'当前笔记还没有手写标注。'});
        return;
      }
      for(const item of shown){
        const row=listEl.createEl('button',{cls:`aw-annot-summary-item aw-annot-c-${item.color}`,attr:{type:'button'}});
        tint(row,item);
        row.createSpan({cls:'aw-annot-dot'});
        row.createSpan({cls:'aw-annot-summary-target',text:item.target});
        const dirLabel=DIRECTIONS.find(d=>d.id===item.dir)?.label||'右下';
        const lineLabel=item.line!==Format.DEFAULTS.line?` · ${LINES.find(l=>l.id===item.line)?.label||''}`:'';
        row.createSpan({cls:'aw-annot-summary-dir',text:`（${dirLabel}${lineLabel}）`});
        row.createSpan({cls:'aw-annot-summary-note',text:item.note});
        row.createSpan({cls:'aw-annot-summary-line',text:`L${item.lineIndex+1}`});
        row.addEventListener('click',()=>{this.close();this.onJump?.(item);});
      }
    };
    if(this.items.length>3){
      const search=head.createEl('input',{cls:'aw-annot-summary-search',attr:{type:'text',placeholder:'搜索目标或批注…'}});
      search.addEventListener('input',()=>{query=search.value;render();});
      el.ownerDocument.defaultView?.setTimeout(()=>search.focus(),0);
    }
    render();
    const footer=new Setting(el).addButton(b=>b.setButtonText('关闭').onClick(()=>this.close()));
    if(this.items.length){
      footer.addButton(b=>b.setButtonText('复制 Markdown 汇总').setCta().onClick(()=>{this.onCopy?.();this.close();}));
    }
  }
  onClose(){this.contentEl.empty();}
}

// Reset margin layout styling on a Reading-view sizer so narrow widths or inline mode stay spotless.
function restoreMarginSizer(sizer){
  if(!sizer)return;
  sizer.classList?.remove?.('aw-annot-margin-sizer');
  const content=sizer.closest?.('.view-content');
  content?.classList?.remove?.('aw-has-right-margin-annot');
  for(const note of sizer.querySelectorAll?.('.aw-annot.aw-annot-in-margin')||[]){
    note.classList.remove('aw-annot-in-margin','aw-annot-margin-left','aw-annot-margin-right');
    for(const svg of note.querySelectorAll?.('.aw-annot-margin-connector')||[])svg.remove();
    const textEl=note.querySelector?.('.aw-annot-pin .aw-annot-text');
    if(textEl?.style){
      for(const prop of ['left','top','width','transform','visibility'])textEl.style.removeProperty(prop);
    }
  }
}

function makeMarginConnectorEl(doc,noteEl,textEl,markEl,side,lineStyle,sizerRect){
  const pin=noteEl.querySelector?.('.aw-annot-pin');
  if(!pin)return null;
  const pinRect=pin.getBoundingClientRect(),markRect=markEl.getBoundingClientRect(),textRect=textEl.getBoundingClientRect();
  const from={
    x:(side==='left'?textRect.right+7:textRect.left-7)-pinRect.left,
    y:textRect.top+textRect.height/2-pinRect.top,
  };
  // When neighbouring body text sits between the target and the margin, route through the inter-line gap.
  const inset=sizerRect?(side==='left'?markRect.left-sizerRect.left:sizerRect.right-markRect.right):0;
  const markMidY=markRect.top+markRect.height/2,textMidY=textRect.top+textRect.height/2;
  const attach=inset>14?(textMidY<markMidY-6?'top':'bottom'):'side';
  const to=attach==='side'
    ?{x:(side==='left'?markRect.left-4:markRect.right+4)-pinRect.left,y:markMidY-pinRect.top}
    :{x:(side==='left'?markRect.left+Math.min(18,markRect.width*0.28):markRect.right-Math.min(18,markRect.width*0.28))-pinRect.left,
      y:(attach==='bottom'?markRect.bottom+2:markRect.top-2)-pinRect.top};
  const geom=buildMarginConnector(side,lineStyle,from,to,attach);
  const svg=doc.createElementNS(SVG,'svg');
  svg.setAttribute('class','aw-annot-margin-connector'+(geom.dashed?' is-dashed':''));
  svg.setAttribute('width','1');svg.setAttribute('height','1');
  svg.setAttribute('aria-hidden','true');
  const head=doc.createElementNS(SVG,'path');
  head.setAttribute('d',geom.head);head.setAttribute('class','aw-annot-head');
  svg.appendChild(head);
  for(const d of geom.lines){
    const p=doc.createElementNS(SVG,'path');
    p.setAttribute('d',d);p.setAttribute('class','aw-annot-line');
    svg.appendChild(p);
  }
  return svg;
}

class Annotations extends Component{
  constructor(plugin){
    super();this.plugin=plugin;this.app=plugin.app;
    this.documents=new Map();this.noteMeta=new WeakMap();this.marginStates=new Map();
    this.recall=false;this.lastStyle=null;this.lastMarkdownLeaf=null;this.readingCursor=new WeakMap();
    this.vaultIndex=new Center.VaultAnnotationIndex(f=>this.app.vault.cachedRead(f));
    this.vaultReady=false;this.vaultPromise=null;this.centerTimer=0;this.scrollFrames=new Map();
  }
  onload(){
    this.attachDocument(this.app?.workspace?.containerEl?.ownerDocument);
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.attachDocument(win?.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>{
      const doc=win?.document,owner=this.documents.get(doc);
      if(owner){this.removeChild?.(owner);this.documents.delete(doc);}
      const frame=this.scrollFrames.get(doc);
      if(frame){doc?.defaultView?.cancelAnimationFrame?.(frame);this.scrollFrames.delete(doc);}
    }));
    this.registerEvent(this.app.workspace.on('layout-change',()=>{this.clampAll();this.refreshAllMargins();this.scheduleCenterSync();}));
    this.registerEvent(this.app.workspace.on('active-leaf-change',leaf=>{
      if(MarkdownView&&leaf?.view instanceof MarkdownView)this.lastMarkdownLeaf=leaf;
      this.scheduleCenterSync(true);
    }));
    this.registerEvent(this.app.workspace.on('file-open',()=>this.scheduleCenterSync(true)));
    this.registerEvent(this.app.workspace.on('editor-change',()=>this.scheduleCenterSync()));
    const vault=this.app?.vault;
    if(typeof vault?.on==='function'){
      this.registerEvent(vault.on('create',file=>{if(this.isMdFile(file)&&this.vaultReady)void this.updateVaultFile(file);}));
      this.registerEvent(vault.on('modify',file=>{if(this.isMdFile(file)){if(this.vaultReady)void this.updateVaultFile(file);this.scheduleCenterSync();}}));
      this.registerEvent(vault.on('delete',file=>{if(file?.path&&this.vaultReady){this.vaultIndex.remove(file.path);this.pushVaultToCenters();}}));
      this.registerEvent(vault.on('rename',(file,oldPath)=>{
        if(this.vaultReady){
          if(this.isMdFile(file))this.vaultIndex.rename(oldPath,file);
          else this.vaultIndex.remove(oldPath);
          this.pushVaultToCenters();
        }
        this.scheduleCenterSync(true);
      }));
    }
    this.plugin.registerView?.(Center.CENTER_VIEW,leaf=>new Center.AnnotationCenterView(leaf,this));
    this.plugin.addRibbonIcon?.(Center.CENTER_ICON,'打开'+Center.CENTER_NAME,()=>void this.openCenter());
    this.plugin.registerMarkdownPostProcessor((el,ctx)=>this.process(el,ctx));
    this.plugin.registerEditorExtension(editorExtension());
    this.registerEvent(this.app.workspace.on('editor-menu',(menu,editor)=>this.menu(menu,editor)));
    this.plugin.addCommand?.({
      id:'annotate-selection',name:'添加或编辑标注',
      editorCallback:editor=>{
        const at=this.annotationAt(editor);
        if(at)this.edit(editor,at);
        else if(editor.getSelection().trim())this.add(editor);
        else new Notice('请先选中一段文字，或把光标放在已有标注上。');
      },
    });
    this.plugin.addCommand?.({
      id:'quick-annotate',name:'快速标注',
      editorCallback:editor=>this.quickAdd(editor),
    });
    this.plugin.addCommand?.({id:'prev-annotation',name:'跳到上一条标注',callback:()=>void this.navigateAdjacent('prev')});
    this.plugin.addCommand?.({id:'next-annotation',name:'跳到下一条标注',callback:()=>void this.navigateAdjacent('next')});
    this.plugin.addCommand?.({id:'open-annotation-center',name:'打开'+Center.CENTER_NAME,callback:()=>void this.openCenter()});
    this.plugin.addCommand?.({id:'toggle-annotation-recall',name:'切换标注自测遮罩',callback:()=>this.toggleRecall()});
    this.plugin.addCommand?.({id:'open-annotation-summary',name:'查看与复制当前笔记标注',callback:()=>void this.openSummary()});
  }
  onunload(){
    this.recall=false;this.documents.clear();
    clearTimeout(this.centerTimer);this.centerTimer=0;
    for(const [doc,frame] of this.scrollFrames)doc?.defaultView?.cancelAnimationFrame?.(frame);
    this.scrollFrames.clear();
    for(const [sizer,st] of this.marginStates){
      st.observer?.disconnect?.();
      if(st.frame)sizer.ownerDocument?.defaultView?.cancelAnimationFrame?.(st.frame);
      restoreMarginSizer(sizer);
    }
    this.marginStates.clear();
  }
  isMdFile(file){return Boolean(file?.path&&(TFile?file instanceof TFile:true)&&String(file.extension||file.path.split('.').pop()).toLowerCase()==='md');}
  layoutMode(){
    const v=this.plugin.data?.settings?.annotLayout;
    return Core.ANNOT_LAYOUTS.some(x=>x.id===v)?v:'smart';
  }
  marginWidth(){
    const n=this.plugin.data?.settings?.annotMarginWidth;
    return Number.isInteger(n)?Math.min(Core.ANNOT_MARGIN_MAX,Math.max(Core.ANNOT_MARGIN_MIN,n)):190;
  }
  attachDocument(doc){
    if(!doc||typeof doc.addEventListener!=='function'||this.documents.has(doc))return;
    const owner=this.addChild?.(new Component())??new Component();
    this.documents.set(doc,owner);
    owner.registerDomEvent?.(doc,'click',event=>this.onReadingClick(event));
    owner.registerDomEvent?.(doc,'dblclick',event=>this.onReadingDblClick(event));
    owner.registerDomEvent?.(doc,'keydown',event=>this.onReadingKey(event));
    owner.registerDomEvent?.(doc,'scroll',()=>this.scheduleViewportSync(doc),{capture:true});
    if(doc.defaultView)owner.registerDomEvent?.(doc.defaultView,'resize',()=>{this.clampAll();this.refreshAllMargins();});
  }
  clampAll(){
    this.app?.workspace?.iterateAllLeaves?.(leaf=>{
      const el=leaf?.view?.contentEl;
      if(el)scheduleClamp(el);
    });
  }
  scheduleMargin(root){
    if(!root||typeof root.getBoundingClientRect!=='function')return;
    const findSizer=()=>root.matches?.('.markdown-preview-sizer')?root:root.closest?.('.markdown-preview-sizer')??null;
    const sizer=findSizer();
    if(!sizer){
      root.ownerDocument?.defaultView?.requestAnimationFrame?.(()=>{
        const attached=findSizer();
        if(attached)this.scheduleMarginSizer(attached);
      });
      return;
    }
    this.scheduleMarginSizer(sizer);
  }
  scheduleMarginSizer(sizer){
    if(!sizer?.isConnected)return;
    let st=this.marginStates.get(sizer);
    if(!st){
      const view=sizer.closest?.('.markdown-preview-view');
      const RO=sizer.ownerDocument?.defaultView?.ResizeObserver;
      const observer=RO?new RO(()=>this.scheduleMarginSizer(sizer)):null;
      observer?.observe(sizer);
      if(view)observer?.observe(view);
      st={frame:0,observer};
      this.marginStates.set(sizer,st);
    }
    if(st.frame)return;
    const win=sizer.ownerDocument?.defaultView;
    const run=()=>{
      st.frame=0;
      if(!sizer.isConnected){st.observer?.disconnect?.();this.marginStates.delete(sizer);return;}
      this.layoutMarginSizer(sizer);
    };
    if(typeof win?.requestAnimationFrame==='function')st.frame=win.requestAnimationFrame(run);
    else run();
  }
  refreshAllMargins(){
    for(const [sizer,st] of [...this.marginStates]){
      if(!sizer.isConnected){st.observer?.disconnect?.();this.marginStates.delete(sizer);continue;}
      this.scheduleMarginSizer(sizer);
    }
    this.app?.workspace?.iterateAllLeaves?.(leaf=>{
      const sizer=leaf?.view?.contentEl?.querySelector?.('.markdown-reading-view .markdown-preview-sizer');
      if(sizer)this.scheduleMarginSizer(sizer);
    });
  }
  layoutMarginSizer(sizer){
    const doc=sizer.ownerDocument,view=sizer.closest?.('.markdown-preview-view'),content=sizer.closest?.('.view-content');
    const mode=this.layoutMode(),marginW=this.marginWidth();
    restoreMarginSizer(sizer);
    if(!view||mode==='inline'||doc?.body?.classList?.contains?.('is-mobile')){
      scheduleClamp(sizer);
      return;
    }
    const notes=[...(sizer.querySelectorAll?.('.aw-annot')||[])];
    if(!notes.length)return;
    const sizerRect=sizer.getBoundingClientRect(),viewRect=view.getBoundingClientRect();
    if(!(sizerRect.width>40&&viewRect.width>40))return;
    const ruler=content?.querySelector?.('.aw-ruler:not(.is-idle)');
    const rightRail=ruler&&ruler.getBoundingClientRect().width>0?RULER_CLEARANCE:0;
    const required=marginW+MARGIN_MIN_EXTRA;
    const avail={
      left:sizerRect.left-viewRect.left>=required,
      right:viewRect.right-sizerRect.right>=required+rightRail,
    };
    if(!avail.left&&!avail.right){scheduleClamp(sizer);return;}

    const counts={left:0,right:0},buckets={left:[],right:[]};
    let placedAny=false;
    for(let i=0;i<notes.length;i++){
      const noteEl=notes[i],markEl=noteEl.closest?.('.aw-annot-target'),textEl=noteEl.querySelector?.('.aw-annot-pin .aw-annot-text');
      if(!markEl||!textEl)continue;
      const meta=this.noteMeta.get(noteEl);
      const dir=meta?.spec?.dir||(noteEl.className.match(/aw-annot-(nw|n|ne|sw|s|se)\b/)||[])[1]||'se';
      const lineStyle=meta?.spec?.line||(noteEl.className.match(/aw-annot-(double|dashed|solid|wavy|spiral)\b/)||[])[1]||'double';
      const targetRect=markEl.getBoundingClientRect();
      const side=chooseMarginSide(dir,mode,avail,counts,targetRect,sizerRect);
      if(!side)continue;
      counts[side]++;placedAny=true;
      noteEl.classList.add('aw-annot-in-margin','aw-annot-margin-'+side);
      textEl.style.width=`${marginW}px`;
      textEl.style.left='0px';textEl.style.top='0px';
      textEl.style.transform='none';textEl.style.visibility='hidden';
      const height=Math.max(20,Math.ceil(textEl.getBoundingClientRect().height||textEl.scrollHeight||22));
      const x=side==='left'?-marginW-MARGIN_CONNECTOR_GAP:sizerRect.width+MARGIN_CONNECTOR_GAP;
      const targetY=targetRect.top-sizerRect.top+targetRect.height/2;
      buckets[side].push({id:i,noteEl,markEl,textEl,side,lineStyle,x,height,desiredY:targetY-height/2});
    }
    if(!placedAny){scheduleClamp(sizer);return;}

    sizer.classList.add('aw-annot-margin-sizer');
    content?.classList?.toggle?.('aw-has-right-margin-annot',buckets.right.length>0);
    const docHeight=Math.max(sizer.scrollHeight||0,Math.ceil(sizerRect.height));
    for(const side of ['left','right']){
      if(!buckets[side].length)continue;
      const positioned=distributeMarginNotes(buckets[side],docHeight,MARGIN_GAP);
      for(const p of positioned){
        const pin=p.noteEl.querySelector?.('.aw-annot-pin');
        if(!pin)continue;
        const pinRect=pin.getBoundingClientRect();
        const pinX=pinRect.left-sizerRect.left,pinY=pinRect.top-sizerRect.top;
        p.textEl.style.left=`${Math.round(p.x-pinX)}px`;
        p.textEl.style.top=`${Math.round(p.y-pinY)}px`;
        p.textEl.style.visibility='visible';
      }
      // Second check against live DOM heights so wrapped fonts never touch.
      let prevBottom=-Infinity;
      for(const p of [...positioned].sort((a,b)=>a.textEl.getBoundingClientRect().top-b.textEl.getBoundingClientRect().top)){
        let r=p.textEl.getBoundingClientRect();
        if(r.top<prevBottom+MARGIN_GAP){
          const cur=parseFloat(p.textEl.style.top)||0;
          p.textEl.style.top=`${Math.round(cur+prevBottom+MARGIN_GAP-r.top)}px`;
          r=p.textEl.getBoundingClientRect();
        }
        prevBottom=r.bottom;
      }
      for(const p of positioned){
        const pin=p.noteEl.querySelector?.('.aw-annot-pin');
        const svg=makeMarginConnectorEl(doc,p.noteEl,p.textEl,p.markEl,side,p.lineStyle,sizerRect);
        if(pin&&svg)pin.appendChild(svg);
      }
    }
    scheduleClamp(sizer);
  }
  rememberStyle(spec){
    const next={};
    for(const k of STYLE_KEYS)if(spec[k]!==undefined)next[k]=spec[k];
    this.lastStyle=next;
  }
  // Reading view: Obsidian renders ==text== as <mark>; the {note} is the text right after it.
  process(el,ctx){
    const counts=new Map();
    for(const mark of el.querySelectorAll('mark')){
      const next=mark.nextSibling;
      if(!next||next.nodeType!==3)continue;
      const found=parseAnnotation(next.textContent);
      if(!found)continue;
      next.textContent=found.rest;
      for(const name of targetClasses(found,mark.textContent))mark.classList.add(name);
      tint(mark,found);
      const note=noteNode(el.ownerDocument,found);
      if(ctx){
        const holder=note.children[1];
        const textEl=note.querySelector?.('.aw-annot-text')??[...(holder?.children||[])].find(c=>c.className==='aw-annot-text');
        textEl?.setAttribute?.('tabindex','0');
        textEl?.setAttribute?.('role','button');
        const key=`${mark.textContent}\0${formatAnnotation(found)}`,ordinal=counts.get(key)||0;
        counts.set(key,ordinal+1);
        this.noteMeta.set(note,{el,ctx,target:mark.textContent,spec:{...found},ordinal});
      }
      mark.appendChild(note);
    }
    scheduleClamp(el);
    this.scheduleMargin(el);
  }
  // Center views & cross-vault index coordination.
  centerViews(){
    return (this.app?.workspace?.getLeavesOfType?.(Center.CENTER_VIEW)||[])
      .map(l=>l.view).filter(v=>v instanceof Center.AnnotationCenterView);
  }
  async openCenter(){
    try{
      const ws=this.app.workspace;
      let leaf=ws.getLeavesOfType(Center.CENTER_VIEW)[0];
      if(!leaf){leaf=ws.getRightLeaf(false);if(!leaf)return;await leaf.setViewState({type:Center.CENTER_VIEW,active:true});}
      await ws.revealLeaf(leaf);
    }catch(error){new Notice('标注中心打开失败，请尝试重新启用插件。');console.error(error);}
  }
  onCenterOpened(view){
    void this.syncCenterCurrent(view);
    if(view.scope==='vault')void this.ensureVaultIndex();
  }
  scheduleCenterSync(immediate=false){
    if(!this.centerViews().length)return;
    clearTimeout(this.centerTimer);
    if(immediate){this.centerTimer=0;void this.syncCenterCurrent();return;}
    this.centerTimer=setTimeout(()=>{this.centerTimer=0;void this.syncCenterCurrent();},180);
  }
  async syncCenterCurrent(onlyView=null){
    const targets=onlyView?[onlyView]:this.centerViews();
    if(!targets.length)return;
    const view=this.activeMarkdownView(),file=view?.file;
    if(!view||!file){
      for(const c of targets){c.setCurrent(null,[]);c.setActive(null,null);}
      return;
    }
    const raw=view.getMode?.()==='source'&&view.editor?view.editor.getValue():await this.app.vault.cachedRead(file);
    const items=collectNoteAnnotations(raw);
    const meta={path:file.path,basename:file.basename||file.path.split('/').pop().replace(/\.md$/i,'')};
    for(const c of targets)c.setCurrent(meta,items);
    this.syncViewportActive(view,items);
  }
  async ensureVaultIndex(){
    if(this.vaultReady){this.pushVaultToCenters(false);return;}
    if(!this.vaultPromise){
      this.pushVaultToCenters(true);
      const files=typeof this.app?.vault?.getMarkdownFiles==='function'?this.app.vault.getMarkdownFiles():[];
      this.vaultPromise=this.vaultIndex.rebuild(files).then(()=>{this.vaultReady=true;}).finally(()=>{this.vaultPromise=null;this.pushVaultToCenters(false);});
    }
    await this.vaultPromise;
  }
  async updateVaultFile(file,source){
    try{await this.vaultIndex.update(file,source);}catch{return;}
    this.pushVaultToCenters(false);
  }
  pushVaultToCenters(loading=false){
    const entries=this.vaultIndex.entries();
    for(const c of this.centerViews())c.setVault(entries,loading);
  }
  scheduleViewportSync(doc){
    if(!this.centerViews().length||!doc||this.scrollFrames.has(doc))return;
    const win=doc.defaultView;
    const run=()=>{
      this.scrollFrames.delete(doc);
      const view=this.activeMarkdownView();
      if(view&&view.contentEl?.ownerDocument===doc)void this.syncViewportActive(view);
    };
    if(typeof win?.requestAnimationFrame==='function')this.scrollFrames.set(doc,win.requestAnimationFrame(run));
    else run();
  }
  async syncViewportActive(view,knownItems){
    const centers=this.centerViews();
    if(!centers.length||!view?.file)return;
    const path=view.file.path;
    const items=knownItems??collectNoteAnnotations(view.getMode?.()==='source'&&view.editor?view.editor.getValue():await this.app.vault.cachedRead(view.file));
    if(!items.length){for(const c of centers)c.setActive(null,null);return;}
    let active=null;
    if(view.getMode?.()==='source'&&view.editor){
      const cur=view.editor.getCursor();
      active=items.find(a=>a.lineIndex===cur.line&&a.markFrom<=cur.ch&&cur.ch<=a.to)
        ||items.reduce((best,a)=>!best||Math.abs(a.lineIndex-cur.line)<Math.abs(best.lineIndex-cur.line)?a:best,null);
    }else{
      const preview=view.contentEl?.querySelector?.('.markdown-reading-view .markdown-preview-view');
      if(preview){
        const marks=[...(preview.querySelectorAll?.('.aw-annot-target')||[])];
        const vr=preview.getBoundingClientRect();
        const idx=findClosestVisibleIndex(marks.map(m=>m.getBoundingClientRect()),vr.top,vr.bottom>vr.top?vr.bottom:vr.top+preview.clientHeight);
        if(idx>=0)active=this.matchReadingItem(marks[idx],items,marks.length===items.length?idx:-1);
      }
    }
    for(const c of centers)c.setActive(active?path:null,active?active.docFrom:null);
  }
  matchReadingItem(markEl,items,fallbackIdx=-1){
    const noteEl=markEl?.querySelector?.('.aw-annot'),meta=noteEl&&this.noteMeta.get(noteEl);
    const info=meta?.ctx?.getSectionInfo?.(meta.el);
    if(meta&&info){
      const inSec=items.filter(a=>a.lineIndex>=info.lineStart&&a.lineIndex<=info.lineEnd&&a.target===meta.target&&sameSpec(a,meta.spec));
      if(inSec[meta.ordinal])return inSec[meta.ordinal];
      if(inSec.length===1)return inSec[0];
    }
    return fallbackIdx>=0?items[fallbackIdx]||null:null;
  }
  pulseTarget(el){
    if(!el?.classList)return;
    el.classList.remove('aw-annot-jump-flash');
    void el.offsetWidth;
    el.classList.add('aw-annot-jump-flash');
    el.ownerDocument?.defaultView?.setTimeout?.(()=>el.classList.remove('aw-annot-jump-flash'),FLASH_MS);
  }
  async openLeafForPath(filePath){
    const leaves=this.app?.workspace?.getLeavesOfType?.('markdown')||[];
    if(!filePath)return this.activeMarkdownLeaf()||leaves[0]||null;
    let leaf=leaves.find(l=>l.view?.file?.path===filePath);
    if(!leaf){
      const file=this.app?.vault?.getAbstractFileByPath?.(filePath);
      if(!file)return null;
      leaf=this.app.workspace.getLeaf('tab');
      await leaf.openFile(file,{active:true});
    }
    return leaf;
  }
  async jumpToAnnotation(filePath,item){
    if(!item)return false;
    const leaf=await this.openLeafForPath(filePath);
    const view=leaf?.view;
    if(!leaf||!view)return false;
    this.app?.workspace?.setActiveLeaf?.(leaf,{focus:true});
    void this.app?.workspace?.revealLeaf?.(leaf);
    if(view.getMode?.()==='source'&&view.editor){
      const pos={line:item.lineIndex,ch:item.markFrom},end={line:item.lineIndex,ch:item.to};
      view.editor.setCursor(pos);
      view.editor.scrollIntoView?.({from:pos,to:end},true);
      view.editor.focus?.();
    }else{
      const marks=[...(view.contentEl?.querySelectorAll?.('.markdown-reading-view .aw-annot-target')||[])];
      const hit=marks.find(m=>{
        const noteEl=m.querySelector?.('.aw-annot'),meta=noteEl&&this.noteMeta.get(noteEl);
        const info=meta?.ctx?.getSectionInfo?.(meta.el);
        return meta&&info&&item.lineIndex>=info.lineStart&&item.lineIndex<=info.lineEnd&&meta.target===item.target&&sameSpec(meta.spec,item);
      });
      if(hit&&typeof hit.scrollIntoView==='function'){
        hit.scrollIntoView({block:'center'});
        this.pulseTarget(hit);
      }else{
        view.currentMode?.applyScroll?.(item.lineIndex,{center:true,highlight:true});
      }
      this.readingCursor.set(view,{lineIndex:item.lineIndex,ch:item.markFrom});
    }
    for(const c of this.centerViews())c.setActive(view.file?.path||filePath,item.docFrom);
    return true;
  }
  async navigateAdjacent(direction){
    const view=this.activeMarkdownView(),file=view?.file;
    if(!view||!file){new Notice('请先打开一篇 Markdown 笔记。');return null;}
    const editing=view.getMode?.()==='source'&&Boolean(view.editor);
    const raw=editing?view.editor.getValue():await this.app.vault.cachedRead(file);
    const items=collectNoteAnnotations(raw);
    if(!items.length){new Notice('当前笔记还没有手写标注。');return null;}
    let anchorLine=0,anchorCh=-1;
    if(editing){
      const cur=view.editor.getCursor();
      anchorLine=cur.line;anchorCh=cur.ch;
    }else{
      const tracked=this.readingCursor.get(view);
      if(tracked){anchorLine=tracked.lineIndex;anchorCh=tracked.ch;}
      else{
        const preview=view.contentEl?.querySelector?.('.markdown-reading-view .markdown-preview-view');
        const marks=preview?[...(preview.querySelectorAll?.('.aw-annot-target')||[])]:[];
        const vr=preview?.getBoundingClientRect?.();
        const idx=vr?findClosestVisibleIndex(marks.map(m=>m.getBoundingClientRect()),vr.top,vr.bottom>vr.top?vr.bottom:vr.top+preview.clientHeight):-1;
        const curItem=idx>=0?this.matchReadingItem(marks[idx],items,marks.length===items.length?idx:-1):null;
        if(curItem){anchorLine=curItem.lineIndex;anchorCh=curItem.markFrom;}
        else{anchorLine=direction==='prev'?Infinity:-1;anchorCh=0;}
      }
    }
    const target=findAdjacentAnnotation(items,anchorLine,anchorCh,direction);
    if(target)await this.jumpToAnnotation(file.path,target);
    return target;
  }
  async copyText(text,msg){
    const clip=this.app?.workspace?.containerEl?.ownerDocument?.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
    if(!clip?.writeText){new Notice('当前环境不支持剪贴板写入。');return false;}
    try{await clip.writeText(text);if(msg)new Notice(msg);return true;}
    catch{new Notice('复制失败。');return false;}
  }
  async rewriteNoteItem(filePath,item,replacement){
    const leaf=(this.app?.workspace?.getLeavesOfType?.('markdown')||[]).find(l=>l.view?.file?.path===filePath);
    if(leaf?.view?.getMode?.()==='source'&&leaf.view.editor){
      const ed=leaf.view.editor,raw=ed.getValue();
      const updated=replaceNoteAnnotation(raw,item,replacement);
      const fromPos=ed.offsetToPos?ed.offsetToPos(item.docFrom+(item.from-item.markFrom)):{line:item.lineIndex,ch:item.from};
      const toPos=ed.offsetToPos?ed.offsetToPos(item.docTo):{line:item.lineIndex,ch:item.to};
      if(typeof ed.replaceRange==='function'&&updated!==raw){
        ed.replaceRange(replacement,fromPos,toPos);
      }
      if(this.vaultReady&&leaf.view.file)void this.updateVaultFile(leaf.view.file,ed.getValue());
      this.scheduleCenterSync(true);
      return true;
    }
    const file=filePath?this.app?.vault?.getAbstractFileByPath?.(filePath):null;
    if(!file){new Notice('找不到这条标注所在的笔记。');return false;}
    try{
      await this.app.vault.process(file,data=>replaceNoteAnnotation(data,item,replacement));
      if(this.vaultReady)void this.updateVaultFile(file);
      this.scheduleCenterSync(true);
      return true;
    }catch(error){new Notice(error?.message||'修改标注失败。');return false;}
  }
  async handleCenterAction(action,{filePath,item}){
    if(!item)return;
    if(action==='copy'){await this.copyText(`${item.target} — ${item.note}`,'已复制标注内容。');return;}
    if(action==='remove'){await this.rewriteNoteItem(filePath,item,'');return;}
    if(action==='toggle-highlight'){
      await this.rewriteNoteItem(filePath,item,formatAnnotation({...item,highlight:item.highlight===false}));
      return;
    }
    if(action==='edit'){
      this.openModal(item,{
        title:'编辑标注',action:'保存',
        onRemove:()=>void this.rewriteNoteItem(filePath,item,''),
      },spec=>{
        this.rememberStyle(spec);
        void this.rewriteNoteItem(filePath,item,formatAnnotation(spec));
      });
    }
  }
  readingTextOf(target){
    return target?.closest?.('.markdown-reading-view .aw-annot .aw-annot-text')??null;
  }
  toggleMask(textEl){
    if(!textEl?.classList)return;
    if(this.recall){textEl.classList.toggle('is-revealed');textEl.classList.remove?.('is-masked');}
    else{textEl.classList.toggle('is-masked');textEl.classList.remove?.('is-revealed');}
  }
  toggleRecall(){
    this.recall=!this.recall;
    for(const doc of this.documents.keys()){
      for(const el of doc.querySelectorAll?.('.aw-annot-text.is-masked,.aw-annot-text.is-revealed')||[]){
        el.classList.remove('is-masked','is-revealed');
      }
    }
    this.plugin.applyAppearanceEverywhere?.();
    new Notice(this.recall?'已开启标注自测遮罩：阅读视图中点击标注可显隐核对，双击可编辑。':'已关闭标注自测遮罩。');
    return this.recall;
  }
  onReadingClick(event){
    const textEl=this.readingTextOf(event.target);
    if(!textEl)return;
    event.preventDefault();event.stopPropagation();
    if(event.detail===1){
      textEl._awPre={masked:textEl.classList.contains('is-masked'),revealed:textEl.classList.contains('is-revealed')};
      this.toggleMask(textEl);
    }
  }
  onReadingDblClick(event){
    const textEl=this.readingTextOf(event.target);
    if(!textEl)return;
    event.preventDefault();event.stopPropagation();
    textEl.ownerDocument?.defaultView?.getSelection?.()?.removeAllRanges?.();
    if(textEl._awPre){
      textEl.classList.toggle('is-masked',textEl._awPre.masked);
      textEl.classList.toggle('is-revealed',textEl._awPre.revealed);
    }
    const note=textEl.closest?.('.aw-annot');
    if(note)this.editReading(note);
  }
  onReadingKey(event){
    const textEl=this.readingTextOf(event.target);
    if(!textEl)return;
    if(event.key==='Enter'&&event.shiftKey){
      event.preventDefault();
      const note=textEl.closest?.('.aw-annot');
      if(note)this.editReading(note);
    }else if(event.key===' '||event.key==='Enter'){
      event.preventDefault();this.toggleMask(textEl);
    }
  }
  viewOf(node){
    if(node?.closest?.('.markdown-embed,.hover-popover'))return null;
    return this.app?.workspace?.getLeavesOfType?.('markdown')?.map(l=>l.view).find(v=>v?.containerEl?.contains?.(node))??null;
  }
  editReading(note){
    if(note?.closest?.('.markdown-embed,.hover-popover')){new Notice('嵌入笔记或悬浮预览中的标注请到原笔记中修改。');return;}
    const meta=this.noteMeta.get(note),view=this.viewOf(note);
    const info=meta?.ctx?.getSectionInfo?.(meta.el),file=view?.file;
    const isFile=TFile?file instanceof TFile:Boolean(file?.path);
    if(!meta||!info||!isFile){new Notice('无法定位这条标注的源码，请在编辑视图中修改。');return;}
    this.openModal(meta.spec,{
      title:'编辑标注',action:'保存',
      onRemove:()=>void this.rewriteReading(file,info,meta,''),
    },spec=>{
      this.rememberStyle(spec);
      void this.rewriteReading(file,info,meta,formatAnnotation(spec));
    });
  }
  async rewriteReading(file,info,meta,replacement){
    try{
      const shownLines=String(info.text??'').split(/\r?\n/);
      const expected=shownLines.slice(info.lineStart,info.lineEnd+1).join('\n');
      await this.app.vault.process(file,data=>{
        const eol=data.includes('\r\n')?'\r\n':'\n',lines=data.split(eol);
        const actual=lines.slice(info.lineStart,info.lineEnd+1).join('\n');
        if(actual!==expected)throw Error('笔记内容已变化，请稍后重试。');
        const updated=replaceSectionAnnotation(actual,meta.target,meta.spec,meta.ordinal,replacement).split('\n');
        lines.splice(info.lineStart,info.lineEnd-info.lineStart+1,...updated);
        return lines.join(eol);
      });
      return true;
    }catch(error){new Notice(error?.message||'修改标注失败。');return false;}
  }
  activeMarkdownLeaf(){
    const leaves=this.app?.workspace?.getLeavesOfType?.('markdown')||[];
    if(MarkdownView&&typeof this.app?.workspace?.getActiveViewOfType==='function'){
      const active=this.app.workspace.getActiveViewOfType(MarkdownView);
      if(active)return leaves.find(l=>l.view===active)||{view:active};
    }
    if(this.lastMarkdownLeaf&&leaves.includes(this.lastMarkdownLeaf))return this.lastMarkdownLeaf;
    return leaves[0]??null;
  }
  activeMarkdownView(){return this.activeMarkdownLeaf()?.view??null;}
  async openSummary(){
    const view=this.activeMarkdownView(),file=view?.file;
    if(!view||!file){new Notice('请先打开一篇 Markdown 笔记。');return;}
    const raw=view.getMode?.()==='source'&&view.editor?view.editor.getValue():await this.app.vault.cachedRead(file);
    const title=file.basename||file.name?.replace(/\.md$/i,'')||'当前笔记';
    const items=collectNoteAnnotations(raw);
    const jump=item=>{
      if(view.getMode?.()==='source'&&view.editor){
        const pos={line:item.lineIndex,ch:item.markFrom},end={line:item.lineIndex,ch:item.to};
        view.editor.setCursor(pos);
        view.editor.scrollIntoView?.({from:pos,to:end},true);
        view.editor.focus?.();
      }else{
        view.currentMode?.applyScroll?.(item.lineIndex);
      }
    };
    const copy=async()=>{
      const md=formatAnnotationSummary(title,items);
      const clip=this.app?.workspace?.containerEl?.ownerDocument?.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
      if(!clip?.writeText){new Notice('当前环境不支持剪贴板写入。');return;}
      await clip.writeText(md);
      new Notice(`已复制 ${items.length} 条标注汇总。`);
    };
    this.openSummaryModal({title,items,onJump:jump,onCopy:()=>void copy()});
  }
  openSummaryModal(props){new AnnotationSummaryModal(this.app,props).open();}
  // The annotation under the cursor, or overlapping the selection, with its row; or null.
  annotationAt(editor){
    const from=editor.getCursor('from'),to=editor.getCursor('to');
    if(from.line!==to.line)return null;
    const empty=from.ch===to.ch;
    const found=findAnnotations(editor.getLine(from.line),0).find(a=>empty?a.markFrom<=from.ch&&from.ch<=a.to:a.markFrom<to.ch&&from.ch<a.to);
    return found?{...found,row:from.line}:null;
  }
  // Right-click: edit / remove the annotation under the cursor or selection (a selection inside
  // one would otherwise nest a second annotation in it), or add one to selected text.
  menu(menu,editor){
    if(!this.plugin.data?.settings)return;
    const selected=editor.getSelection(),at=this.annotationAt(editor);
    if(!at){
      if(selected.trim()&&!/[\r\n]/.test(selected))menu.addItem(item=>item.setTitle('添加标注').setIcon('message-square-plus').onClick(()=>this.add(editor)));
      return;
    }
    menu.addItem(item=>item.setTitle('编辑标注').setIcon('message-square-text').onClick(()=>this.edit(editor,at)));
    menu.addItem(item=>item.setTitle('删除标注').setIcon('message-square-x').onClick(()=>
      editor.replaceRange('',{line:at.row,ch:at.from},{line:at.row,ch:at.to})));
  }
  add(editor){
    const selected=editor.getSelection(),lead=selected.match(/^\s*/)[0],trail=selected.match(/\s*$/)[0];
    // Already highlighted text keeps one pair of ==.
    const target=selected.trim().replace(/^==([\s\S]*)==$/,'$1');
    if(!target||target.includes('==')){new Notice('请选择一段不含 == 的文字。');return;}
    this.openModal({...Format.DEFAULTS,...this.lastStyle,note:''},{title:'添加标注',action:'添加标注'},spec=>{
      this.rememberStyle(spec);
      editor.replaceSelection(`${lead}==${target}==${formatAnnotation(spec)}${trail}`);
    });
  }
  edit(editor,at){
    this.openModal(at,{
      title:'编辑标注',action:'保存',
      onRemove:()=>editor.replaceRange('',{line:at.row,ch:at.from},{line:at.row,ch:at.to}),
    },spec=>{
      this.rememberStyle(spec);
      editor.replaceRange(formatAnnotation(spec),{line:at.row,ch:at.from},{line:at.row,ch:at.to});
    });
  }
  quickAdd(editor){
    const at=this.annotationAt(editor);
    const snap=typeof editor.getValue==='function'?editor.getValue():null;
    const intact=()=>snap===null||editor.getValue()===snap;
    if(at){
      const target=editor.getLine(at.row).slice(at.targetFrom,at.targetTo);
      this.openQuickModal(target,at,spec=>{
        if(!intact())return false;
        this.rememberStyle(spec);
        editor.replaceRange(formatAnnotation(spec),{line:at.row,ch:at.from},{line:at.row,ch:at.to});
      });
      return;
    }
    const selected=editor.getSelection(),lead=selected.match(/^\s*/)[0],trail=selected.match(/\s*$/)[0];
    if(!selected.trim()){new Notice('请先选中一段文字，或把光标放在已有标注上。');return;}
    if(/[\r\n]/.test(selected.trim())){new Notice('快速标注仅支持单行选中文字。');return;}
    const target=selected.trim().replace(/^==([\s\S]*)==$/,'$1');
    if(!target||target.includes('==')){new Notice('请选择一段不含 == 的文字。');return;}
    const from=editor.getCursor('from'),to=editor.getCursor('to');
    this.openQuickModal(target,{...Format.DEFAULTS,...this.lastStyle,note:''},spec=>{
      if(!intact())return false;
      this.rememberStyle(spec);
      editor.replaceRange(`${lead}==${target}==${formatAnnotation(spec)}${trail}`,from,to);
    });
  }
  openQuickModal(target,spec,submit){new QuickAnnotationModal(this.app,target,spec,submit).open();}
  openModal(spec,labels,submit){new AnnotationModal(this.app,spec,labels,submit).open();}
  displaySettings(container){
    const s=this.plugin.data.settings;
    new Setting(container).setName('标注布局')
      .addDropdown(d=>{
        for(const opt of Core.ANNOT_LAYOUTS)d.addOption(opt.id,opt.label);
        d.setValue(this.layoutMode()).onChange(v=>{s.annotLayout=v;this.refreshAllMargins();this.plugin.changed();});
      });
    new Setting(container).setName('页边标注宽度')
      .addSlider(sl=>sl.setLimits(Core.ANNOT_MARGIN_MIN,Core.ANNOT_MARGIN_MAX,10).setValue(this.marginWidth()).setDynamicTooltip().onChange(v=>{
        s.annotMarginWidth=v;this.refreshAllMargins();this.plugin.changed();
      }));
    new Setting(container).setName('标注字体').setDesc('手写标注使用的字体，填写本机已安装的字体名，多个用逗号分隔；留空依次使用手札体、翩翩体、行楷、霞鹜文楷和楷体。')
      .addText(t=>t.setPlaceholder('"LXGW WenKai", KaiTi').setValue(s.annotFont||'').onChange(v=>{
        s.annotFont=v.replace(/[;{}<>\\]/g,'').trim().slice(0,200);this.plugin.applyAppearanceEverywhere();this.plugin.changed();
      }));
  }
}
module.exports={Annotations,AnnotationModal,QuickAnnotationModal,AnnotationSummaryModal,noteNode,clampNotes,targetClasses,restoreMarginSizer};
