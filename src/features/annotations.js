'use strict';
const {Component,Modal,Notice,Setting,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
const Format=require('./annotation-format');
const {parseAnnotation,findAnnotations,formatAnnotation,placement,targetClasses,noteTree,DIRECTIONS,COLORS,LINES}=Format;
const SVG='http://www.w3.org/2000/svg';

function tint(el,spec){
  if(spec.color==='custom'&&spec.custom)el.style.setProperty('--aw-annot-color',spec.custom);
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
const KEYS=['note','dir','color','custom','line','highlight'];
const sameSpec=(a,b)=>KEYS.every(k=>a[k]===b[k]);

// Live Preview: the braces become the note unless the cursor is on the annotation, in which
// case the source stays editable (as Obsidian does for its own formatting). A pinned note is
// drawn inside a mark over target and braces, so it is placed against the target's box.
function editorExtension(){
  class NoteWidget extends WidgetType{
    constructor(spec){super();this.spec=spec;}
    eq(other){return sameSpec(other.spec,this.spec);}
    toDOM(view){return noteNode(view.dom.ownerDocument,this.spec);}
    ignoreEvent(){return false;}
  }
  const build=view=>{
    if(!livePreview(view.state))return Decoration.none;
    const doc=view.state.doc,ranges=view.state.selection.ranges,seen=new Map();
    for(const {from,to} of view.visibleRanges){
      // Whole lines, so a match is never cut at the viewport edge.
      const start=doc.lineAt(from).from,end=doc.lineAt(to).to;
      for(const a of findAnnotations(view.state.sliceDoc(start,end),start))seen.set(a.from,a);
    }
    const out=[];
    for(const a of [...seen.values()].sort((x,y)=>x.markFrom-y.markFrom)){
      if(ranges.some(r=>r.from<=a.to&&r.to>=a.markFrom)){out.push(Decoration.mark({class:'aw-annot-source'}).range(a.from,a.to));continue;}
      const where=placement(a),attributes=a.color==='custom'?{style:`--aw-annot-color:${a.custom}`}:undefined;
      out.push(Decoration.mark({class:targetClasses(a).join(' '),attributes}).range(a.targetFrom,where==='pin'?a.to:a.targetTo));
      if(where==='before'){
        out.push(Decoration.widget({widget:new NoteWidget(a),side:-1}).range(a.markFrom));
        out.push(Decoration.replace({}).range(a.from,a.to));
      }else out.push(Decoration.replace({widget:new NoteWidget(a)}).range(a.from,a.to));
    }
    return Decoration.set(out,true);
  };
  return ViewPlugin.fromClass(class{
    constructor(view){this.decorations=build(view);}
    update(update){
      if(update.docChanged||update.viewportChanged||update.selectionSet||livePreview(update.startState)!==livePreview(update.state))
        this.decorations=build(update.view);
    }
  },{decorations:plugin=>plugin.decorations});
}

// The add / edit dialog: note, position (3×3 around the text), colour, highlight, line.
class AnnotationModal extends Modal{
  constructor(app,spec,{title,action},submit){
    super(app);this.spec={...Format.DEFAULTS,...spec};this.title=title;this.action=action;this.submit=submit;
  }
  onOpen(){
    const el=this.contentEl,doc=el.ownerDocument;
    this.setTitle(this.title);el.addClass('aw-annot-modal');
    new Setting(el).setName('笔记').setDesc('阅读时显示的简短标签，最多 80 个字。').addText(t=>{
      t.setPlaceholder('写一句简短标注…').setValue(this.spec.note||'').onChange(v=>{this.spec.note=v;});
      t.inputEl.maxLength=Format.MAX_NOTE;this.noteInput=t.inputEl;
      t.inputEl.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();this.done();}});
    });
    const pickers=el.createDiv({cls:'aw-annot-pickers'});
    const group=(name,desc)=>{const box=pickers.createDiv({cls:'aw-annot-picker'});box.createDiv({cls:'aw-annot-picker-name',text:name});box.createDiv({cls:'aw-annot-picker-desc',text:desc});return box;};
    const choose=(buttons,key,value)=>{this.spec[key]=value;for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.value===value));};
    // Position: the eight directions around a small "文字" chip.
    const compass=group('位置','标注相对目标文字的位置。').createDiv({cls:'aw-annot-compass'}),dirs=[];
    for(const id of ['nw','n','ne','w','center','e','sw','s','se']){
      if(id==='center'){compass.createSpan({cls:'aw-annot-compass-center',text:'文字'});continue;}
      const d=DIRECTIONS.find(x=>x.id===id),b=compass.createEl('button',{cls:'aw-annot-choice',text:d.arrow,attr:{type:'button','aria-label':d.label}});
      b.dataset.value=id;b.addEventListener('click',()=>choose(dirs,'dir',id));dirs.push(b);
    }
    choose(dirs,'dir',this.spec.dir);
    // Colour: eight named colours and a custom one.
    const swatches=group('颜色','随标注一起保存在笔记里。').createDiv({cls:'aw-annot-swatches'}),colors=[];
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
    new Setting(el).setName('高亮标注目标').setDesc('目标文字带一层与标注同色的浅底；目标本身已有底色时可以关掉。')
      .addToggle(t=>t.setValue(this.spec.highlight!==false).onChange(v=>{this.spec.highlight=v;}));
    new Setting(el).setName('线条').setDesc('双线、虚线为斜向引出的箭头；内联则把标注直接写在文字后面。')
      .addDropdown(d=>{for(const l of LINES)d.addOption(l.id,l.label);d.setValue(this.spec.line).onChange(v=>{this.spec.line=v;});});
    new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close()))
      .addButton(b=>b.setButtonText(this.action).setCta().onClick(()=>this.done()));
    doc.defaultView?.setTimeout(()=>this.noteInput?.focus(),0);
  }
  done(){
    if(!String(this.spec.note||'').trim()){new Notice('请填写标注内容。');this.noteInput?.focus();return;}
    try{this.submit(this.spec);this.close();}catch(error){new Notice(error?.message||'标注没有写入。');}
  }
  onClose(){this.contentEl.empty();}
}

class Annotations extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;}
  onload(){
    this.plugin.registerMarkdownPostProcessor(el=>this.process(el));
    this.plugin.registerEditorExtension(editorExtension());
    this.registerEvent(this.app.workspace.on('editor-menu',(menu,editor)=>this.menu(menu,editor)));
  }
  // Reading view: Obsidian renders ==text== as <mark>; the {note} is the text right after it.
  process(el){
    for(const mark of el.querySelectorAll('mark')){
      const next=mark.nextSibling;
      if(!next||next.nodeType!==3)continue;
      const found=parseAnnotation(next.textContent);
      if(!found)continue;
      next.textContent=found.rest;
      for(const name of targetClasses(found))mark.classList.add(name);
      tint(mark,found);
      const note=noteNode(el.ownerDocument,found),where=placement(found);
      if(where==='pin')mark.appendChild(note);
      else mark.parentNode.insertBefore(note,where==='before'?mark:next);
    }
  }
  // The annotation the cursor is on, with its line, or null.
  annotationAt(editor){
    const cursor=editor.getCursor(),text=editor.getLine(cursor.line);
    const found=findAnnotations(text,0).find(a=>a.markFrom<=cursor.ch&&cursor.ch<=a.to);
    return found?{...found,line:cursor.line}:null;
  }
  // Right-click: add an annotation to selected text, or edit / remove the one under the cursor.
  menu(menu,editor){
    if(!this.plugin.data?.settings)return;
    const selected=editor.getSelection();
    if(selected.trim()&&!/[\r\n]/.test(selected)){
      menu.addItem(item=>item.setTitle('添加标注').setIcon('message-square-plus').onClick(()=>this.add(editor)));
      return;
    }
    const at=this.annotationAt(editor);
    if(!at)return;
    menu.addItem(item=>item.setTitle('编辑标注').setIcon('message-square-text').onClick(()=>this.edit(editor,at)));
    menu.addItem(item=>item.setTitle('删除标注').setIcon('message-square-x').onClick(()=>
      editor.replaceRange('',{line:at.line,ch:at.from},{line:at.line,ch:at.to})));
  }
  add(editor){
    const selected=editor.getSelection(),lead=selected.match(/^\s*/)[0],trail=selected.match(/\s*$/)[0];
    // Already highlighted text keeps one pair of ==.
    const target=selected.trim().replace(/^==([\s\S]*)==$/,'$1');
    if(!target||target.includes('==')){new Notice('请选择一段不含 == 的文字。');return;}
    this.openModal({note:''},{title:'添加标注',action:'添加标注'},spec=>
      editor.replaceSelection(`${lead}==${target}==${formatAnnotation(spec)}${trail}`));
  }
  edit(editor,at){
    this.openModal(at,{title:'编辑标注',action:'保存'},spec=>
      editor.replaceRange(formatAnnotation(spec),{line:at.line,ch:at.from},{line:at.line,ch:at.to}));
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
module.exports={Annotations,AnnotationModal,noteNode,placement,targetClasses};
