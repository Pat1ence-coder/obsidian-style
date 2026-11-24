'use strict';
const {Component,MarkdownView,Modal,Notice,Setting,TFile,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
let syntaxTree=null;
try{({syntaxTree}=require('@codemirror/language'));}catch{}
const Format=require('./annotation-format');
const {parseAnnotation,findAnnotations,formatAnnotation,placement,targetClasses,noteTree,collectNoteAnnotations,replaceSectionAnnotation,formatAnnotationSummary,sameSpec,DIRECTIONS,COLORS,LINES}=Format;
const SVG='http://www.w3.org/2000/svg';
const STYLE_KEYS=['dir','color','custom','line','highlight'];

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
    if(typeof el.getBoundingClientRect!=='function')continue;
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
  class NoteWidget extends WidgetType{
    constructor(spec){super();this.spec=spec;}
    eq(other){return sameSpec(other.spec,this.spec);}
    toDOM(view){return noteNode(view.dom.ownerDocument,this.spec);}
    ignoreEvent(){return false;}
  }
  // A pinned note is laid out against its target's box, so the whole ==target=={note} is one
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
      const where=placement(a),attributes=a.color==='custom'?{style:`--aw-annot-color:${a.custom}`}:undefined;
      if(where==='pin'){out.push(Decoration.replace({widget:new PinnedWidget(a,view.state.sliceDoc(a.targetFrom,a.targetTo))}).range(a.markFrom,a.to));continue;}
      out.push(Decoration.mark({class:targetClasses(a).join(' '),attributes}).range(a.targetFrom,a.targetTo));
      if(where==='before'){
        out.push(Decoration.widget({widget:new NoteWidget(a),side:-1}).range(a.markFrom));
        out.push(Decoration.replace({}).range(a.from,a.to));
      }else out.push(Decoration.replace({widget:new NoteWidget(a)}).range(a.from,a.to));
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
      const where=placement(sample),note=noteNode(doc,sample),mark=doc.createElement('mark');
      mark.className=targetClasses(sample,'目标文字').join(' ');tint(mark,sample);
      mark.appendChild(doc.createTextNode('目标文字'));
      if(where==='pin')mark.appendChild(note);
      lineEl.appendChild(doc.createTextNode('示例前文 '));
      if(where==='before')lineEl.appendChild(note);
      lineEl.appendChild(mark);
      if(where==='after')lineEl.appendChild(note);
      lineEl.appendChild(doc.createTextNode(' 示例后文'));
    };
    const pickers=el.createDiv({cls:'aw-annot-pickers'});
    const group=name=>{const box=pickers.createDiv({cls:'aw-annot-picker'});box.createDiv({cls:'aw-annot-picker-name',text:name});return box;};
    const choose=(buttons,key,value)=>{this.spec[key]=value;for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.value===value));renderPreview();};
    // Position: the eight directions around a small "文字" chip.
    const compass=group('位置').createDiv({cls:'aw-annot-compass'}),dirs=[];
    for(const id of ['nw','n','ne','w','center','e','sw','s','se']){
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

class Annotations extends Component{
  constructor(plugin){
    super();this.plugin=plugin;this.app=plugin.app;
    this.documents=new Map();this.noteMeta=new WeakMap();this.recall=false;this.lastStyle=null;
  }
  onload(){
    this.attachDocument(this.app?.workspace?.containerEl?.ownerDocument);
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.attachDocument(win?.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>{
      const owner=this.documents.get(win?.document);
      if(owner){this.removeChild?.(owner);this.documents.delete(win.document);}
    }));
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.clampAll()));
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
    this.plugin.addCommand?.({id:'toggle-annotation-recall',name:'切换标注自测遮罩',callback:()=>this.toggleRecall()});
    this.plugin.addCommand?.({id:'open-annotation-summary',name:'查看与复制当前笔记标注',callback:()=>void this.openSummary()});
  }
  onunload(){this.recall=false;this.documents.clear();}
  attachDocument(doc){
    if(!doc||typeof doc.addEventListener!=='function'||this.documents.has(doc))return;
    const owner=this.addChild?.(new Component())??new Component();
    this.documents.set(doc,owner);
    owner.registerDomEvent?.(doc,'click',event=>this.onReadingClick(event));
    owner.registerDomEvent?.(doc,'dblclick',event=>this.onReadingDblClick(event));
    owner.registerDomEvent?.(doc,'keydown',event=>this.onReadingKey(event));
    if(doc.defaultView)owner.registerDomEvent?.(doc.defaultView,'resize',()=>this.clampAll());
  }
  clampAll(){
    this.app?.workspace?.iterateAllLeaves?.(leaf=>{
      const el=leaf?.view?.contentEl;
      if(el)scheduleClamp(el);
    });
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
      const note=noteNode(el.ownerDocument,found),where=placement(found);
      if(ctx){
        const holder=where==='pin'?note.children[1]:note;
        const textEl=note.querySelector?.('.aw-annot-text')??[...(holder?.children||[])].find(c=>c.className==='aw-annot-text');
        textEl?.setAttribute?.('tabindex','0');
        textEl?.setAttribute?.('role','button');
        const key=`${mark.textContent}\0${formatAnnotation(found)}`,ordinal=counts.get(key)||0;
        counts.set(key,ordinal+1);
        this.noteMeta.set(note,{el,ctx,target:mark.textContent,spec:{...found},ordinal});
      }
      if(where==='pin')mark.appendChild(note);
      else mark.parentNode.insertBefore(note,where==='before'?mark:next);
    }
    scheduleClamp(el);
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
  activeMarkdownView(){
    if(MarkdownView&&typeof this.app?.workspace?.getActiveViewOfType==='function'){
      const active=this.app.workspace.getActiveViewOfType(MarkdownView);
      if(active)return active;
    }
    return this.app?.workspace?.getLeavesOfType?.('markdown')?.[0]?.view??null;
  }
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
  openModal(spec,labels,submit){new AnnotationModal(this.app,spec,labels,submit).open();}
  displaySettings(container){
    const s=this.plugin.data.settings;
    new Setting(container).setName('标注字体').setDesc('手写标注使用的字体，填写本机已安装的字体名，多个用逗号分隔；留空依次使用手札体、翩翩体、行楷、霞鹜文楷和楷体。')
      .addText(t=>t.setPlaceholder('"LXGW WenKai", KaiTi').setValue(s.annotFont||'').onChange(v=>{
        s.annotFont=v.replace(/[;{}<>\\]/g,'').trim().slice(0,200);this.plugin.applyAppearanceEverywhere();this.plugin.changed();
      }));
  }
}
module.exports={Annotations,AnnotationModal,AnnotationSummaryModal,noteNode,clampNotes,placement,targetClasses};
