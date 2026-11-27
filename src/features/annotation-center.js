'use strict';
const {ItemView,setIcon}=require('obsidian');
const Format=require('./annotation-format');
const {collectNoteAnnotations,DIRECTIONS,COLORS}=Format;

const CENTER_VIEW='aw-annotation-center';
const CENTER_NAME='标注中心';
const CENTER_ICON='message-square-text';
const INDEX_BATCH=24;

// Incremental cross-vault index of Markdown annotations with per-path revision guards.
class VaultAnnotationIndex{
  constructor(readFile){
    this.readFile=readFile;
    this.files=new Map();
    this.revisions=new Map();
  }
  async rebuild(files){
    const current=new Set(files.map(f=>f.path));
    for(const path of [...this.files.keys()])if(!current.has(path))this.remove(path);
    for(let i=0;i<files.length;i+=INDEX_BATCH){
      await Promise.all(files.slice(i,i+INDEX_BATCH).map(f=>this.update(f).catch(()=>{})));
    }
  }
  async update(file,source){
    if(!file?.path)return;
    const rev=(this.revisions.get(file.path)||0)+1;
    this.revisions.set(file.path,rev);
    let raw;
    try{raw=source!==undefined?source:await this.readFile(file);}
    catch(error){
      if(this.revisions.get(file.path)===rev)this.remove(file.path);
      throw error;
    }
    if(this.revisions.get(file.path)!==rev)return;
    const items=collectNoteAnnotations(raw);
    if(items.length)this.files.set(file.path,{file:{path:file.path,basename:file.basename||file.path.split('/').pop().replace(/\.md$/i,'')},items});
    else this.files.delete(file.path);
  }
  remove(path){
    this.revisions.set(path,(this.revisions.get(path)||0)+1);
    this.files.delete(path);
  }
  rename(oldPath,file){
    const prev=this.files.get(oldPath);
    this.remove(oldPath);
    if(!prev||!file?.path)return;
    this.revisions.set(file.path,(this.revisions.get(file.path)||0)+1);
    this.files.set(file.path,{file:{path:file.path,basename:file.basename||file.path.split('/').pop().replace(/\.md$/i,'')},items:prev.items});
  }
  entries(){
    const out=[];
    for(const {file,items} of this.files.values()){
      for(const item of items)out.push({file,item});
    }
    out.sort((a,b)=>a.file.path.localeCompare(b.file.path)||a.item.docFrom-b.item.docFrom);
    return out;
  }
}

function filterAnnotationEntries(entries,query='',color='all'){
  const terms=String(query||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (entries||[]).filter(entry=>{
    const a=entry.item;
    if(color&&color!=='all'&&a.color!==color)return false;
    if(!terms.length)return true;
    const haystack=`${a.target}\n${a.note}\n${entry.file?.path||''}`.toLowerCase();
    return terms.every(t=>haystack.includes(t));
  });
}

function folderOf(path){
  const i=String(path||'').lastIndexOf('/');
  return i>0?path.slice(0,i):'';
}

class AnnotationCenterView extends ItemView{
  constructor(leaf,owner){
    super(leaf);
    this.owner=owner;
    this.scope='current';
    this.query='';
    this.color='all';
    this.currentFile=null;
    this.currentItems=[];
    this.vaultEntries=[];
    this.vaultLoading=false;
    this.active=null;
    this.renderedScope=null;
  }
  getViewType(){return CENTER_VIEW;}
  getDisplayText(){return CENTER_NAME;}
  getIcon(){return CENTER_ICON;}
  async onOpen(){
    const root=this.contentEl;
    root.empty();
    root.addClass('aw-ac');
    root.addClass('aw-annot-center');
    this.buildChrome(root);
    this.renderList();
    this.owner.onCenterOpened(this);
  }
  async onClose(){
    this.listEl=null;this.countEl=null;this.scopeBtns=null;this.searchEl=null;this.colorEl=null;this.copyBtn=null;
    this.contentEl.empty();
  }
  buildChrome(root){
    const head=root.createDiv({cls:'aw-ac-head'});
    const titleRow=head.createDiv({cls:'aw-ac-title-row'});
    const title=titleRow.createDiv({cls:'aw-ac-title'});
    setIcon(title.createSpan({cls:'aw-ac-title-icon'}),CENTER_ICON);
    title.createSpan({text:CENTER_NAME});
    this.countEl=title.createSpan({cls:'aw-ac-count',text:'0'});
    this.copyBtn=titleRow.createEl('button',{cls:'aw-ac-tool',attr:{type:'button','aria-label':'复制当前列表汇总',title:'复制 Markdown 汇总'}});
    setIcon(this.copyBtn.createSpan({cls:'aw-ac-tool-icon'}),'copy');
    this.copyBtn.createSpan({text:'复制汇总'});
    this.copyBtn.addEventListener('click',()=>void this.copyVisibleSummary());

    const scopeBar=head.createDiv({cls:'aw-ac-scope',attr:{role:'group','aria-label':'标注范围'}});
    this.scopeBtns=[];
    for(const opt of [{id:'current',label:'当前笔记'},{id:'vault',label:'整个笔记库'}]){
      const btn=scopeBar.createEl('button',{cls:'aw-ac-scope-btn',text:opt.label,attr:{type:'button'}});
      btn.dataset.scope=opt.id;
      btn.setAttribute('aria-pressed',String(this.scope===opt.id));
      btn.addEventListener('click',()=>{
        if(this.scope===opt.id)return;
        this.scope=opt.id;
        for(const b of this.scopeBtns)b.setAttribute('aria-pressed',String(b.dataset.scope===this.scope));
        if(this.scope==='vault')void this.owner.ensureVaultIndex();
        this.renderList();
      });
      this.scopeBtns.push(btn);
    }

    const filters=head.createDiv({cls:'aw-ac-filters'});
    const searchWrap=filters.createDiv({cls:'aw-ac-search'});
    setIcon(searchWrap.createSpan({cls:'aw-ac-search-icon'}),'search');
    this.searchEl=searchWrap.createEl('input',{attr:{type:'search',placeholder:'搜索原文、标注或文件…','aria-label':'搜索标注'}});
    this.searchEl.value=this.query;
    this.searchEl.addEventListener('input',event=>{
      this.query=this.searchEl.value;
      if(!event.isComposing)this.renderList();
    });
    this.searchEl.addEventListener('compositionend',()=>{
      this.query=this.searchEl.value;
      this.renderList();
    });

    this.colorEl=filters.createEl('select',{cls:'dropdown aw-ac-color',attr:{'aria-label':'按颜色筛选'}});
    for(const opt of [{id:'all',label:'全部颜色'},...COLORS,{id:'custom',label:'自定义'}]){
      const o=this.colorEl.createEl('option',{text:opt.label,attr:{value:opt.id}});
      if(opt.id===this.color)o.selected=true;
    }
    this.colorEl.addEventListener('change',()=>{this.color=this.colorEl.value;this.renderList();});

    this.listEl=root.createDiv({cls:'aw-ac-list'});
  }
  setCurrent(file,items){
    this.currentFile=file;
    this.currentItems=items||[];
    if(this.scope==='current')this.renderList();
  }
  setVault(entries,loading=false){
    this.vaultEntries=entries||[];
    this.vaultLoading=loading;
    if(this.scope==='vault')this.renderList();
  }
  setActive(filePath,docFrom){
    if(this.active&&this.active.filePath===filePath&&this.active.docFrom===docFrom)return;
    this.active=filePath!=null&&Number.isInteger(docFrom)?{filePath,docFrom}:null;
    this.applyActive();
  }
  applyActive(){
    if(!this.listEl)return;
    let activeEl=null;
    for(const el of this.listEl.querySelectorAll('.aw-ac-item')){
      const hit=Boolean(this.active&&el.dataset.file===this.active.filePath&&Number(el.dataset.from)===this.active.docFrom);
      el.classList.toggle('is-active',hit);
      if(hit){activeEl=el;el.setAttribute('aria-current','true');}
      else el.removeAttribute('aria-current');
    }
    if(activeEl&&typeof activeEl.scrollIntoView==='function')activeEl.scrollIntoView({block:'nearest'});
  }
  visibleEntries(){
    const base=this.scope==='vault'
      ?this.vaultEntries
      :this.currentItems.map(item=>({file:this.currentFile||{path:'',basename:'当前笔记'},item}));
    return {total:base.length,shown:filterAnnotationEntries(base,this.query,this.color)};
  }
  renderList(){
    if(!this.listEl)return;
    const preserveScroll=this.renderedScope===this.scope?this.listEl.scrollTop:0;
    this.renderedScope=this.scope;
    const {total,shown}=this.visibleEntries();
    if(this.countEl)this.countEl.textContent=shown.length===total?String(total):`${shown.length} / ${total}`;
    if(this.copyBtn)this.copyBtn.disabled=!shown.length;
    this.listEl.empty();

    if(!shown.length){
      const msg=this.scope==='vault'&&this.vaultLoading
        ?'正在索引笔记库标注…'
        :(this.query.trim()||this.color!=='all')
          ?'没有匹配的标注。'
          :this.scope==='vault'?'笔记库中还没有手写标注。':'当前笔记还没有手写标注。';
      this.listEl.createDiv({cls:'aw-ac-empty',text:msg});
      return;
    }

    if(this.scope==='vault'){
      const groups=new Map();
      for(const entry of shown){
        const list=groups.get(entry.file.path)||[];
        list.push(entry);
        groups.set(entry.file.path,list);
      }
      for(const [path,groupEntries] of groups){
        const group=this.listEl.createDiv({cls:'aw-ac-group'});
        const head=group.createDiv({cls:'aw-ac-group-head'});
        const nameBtn=head.createEl('button',{cls:'aw-ac-group-name',text:groupEntries[0].file.basename,attr:{type:'button',title:path}});
        nameBtn.addEventListener('click',()=>void this.owner.jumpToAnnotation(path,groupEntries[0].item));
        const folder=folderOf(path);
        if(folder)head.createSpan({cls:'aw-ac-group-folder',text:folder,attr:{title:path}});
        head.createSpan({cls:'aw-ac-group-count',text:String(groupEntries.length)});
        for(const entry of groupEntries)this.renderItem(group,entry);
      }
    }else{
      for(const entry of shown)this.renderItem(this.listEl,entry);
    }
    this.listEl.scrollTop=preserveScroll;
    this.applyActive();
  }
  renderItem(parent,entry){
    const {file,item}=entry;
    const card=parent.createDiv({cls:`aw-ac-item aw-annot-c-${item.color}`});
    if(item.color==='custom'&&item.custom)card.style.setProperty('--aw-annot-color',item.custom);
    card.dataset.file=file?.path||'';
    card.dataset.from=String(item.docFrom);
    card.tabIndex=0;

    const top=card.createDiv({cls:'aw-ac-item-top'});
    top.createSpan({cls:'aw-ac-dot'});
    top.createSpan({cls:'aw-ac-target',text:item.target});
    const actions=top.createDiv({cls:'aw-ac-actions'});
    const buttons=[
      {id:'edit',label:'编辑标注',icon:'pencil'},
      {id:'toggle-highlight',label:item.highlight===false?'开启目标高亮':'关闭目标高亮',icon:'highlighter'},
      {id:'copy',label:'复制标注',icon:'copy'},
      {id:'remove',label:'删除标注',icon:'trash-2'},
    ];
    for(const act of buttons){
      const b=actions.createEl('button',{cls:`aw-ac-act aw-ac-act-${act.id}`,attr:{type:'button','aria-label':act.label,title:act.label}});
      setIcon(b,act.icon);
      b.addEventListener('pointerdown',e=>e.stopPropagation());
      b.addEventListener('click',e=>{e.stopPropagation();void this.owner.handleCenterAction(act.id,{filePath:file?.path||null,item});});
    }

    card.createDiv({cls:'aw-ac-note',text:item.note});
    const meta=card.createDiv({cls:'aw-ac-meta'});
    const dirLabel=DIRECTIONS.find(d=>d.id===item.dir)?.label||'右下';
    meta.createSpan({cls:'aw-ac-line',text:`L${item.lineIndex+1}`});
    meta.createSpan({cls:'aw-ac-tag',text:dirLabel});
    if(item.highlight===false)meta.createSpan({cls:'aw-ac-tag',text:'无高亮'});

    card.addEventListener('click',()=>void this.owner.jumpToAnnotation(file?.path||null,item));
    card.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&e.target===card){e.preventDefault();void this.owner.jumpToAnnotation(file?.path||null,item);}
    });
  }
  async copyVisibleSummary(){
    const {shown}=this.visibleEntries();
    if(!shown.length)return;
    const title=this.scope==='vault'?'笔记库标注':(this.currentFile?.basename||'当前笔记');
    let md;
    if(this.scope==='vault'){
      const groups=new Map();
      for(const e of shown){const g=groups.get(e.file.path)||[];g.push(e);groups.set(e.file.path,g);}
      const blocks=[`## 标注汇总：${title}（共 ${shown.length} 条）`];
      for(const [path,list] of groups){
        blocks.push(`\n### ${list[0].file.basename} \`${path}\``);
        list.forEach((e,i)=>{
          const dir=DIRECTIONS.find(d=>d.id===e.item.dir)?.label||'右下';
          blocks.push(`${i+1}. **${e.item.target}**（${dir}）：${e.item.note} *(第 ${e.item.lineIndex+1} 行)*`);
        });
      }
      md=blocks.join('\n');
    }else{
      md=Format.formatAnnotationSummary(title,shown.map(e=>e.item));
    }
    await this.owner.copyText(md,`已复制 ${shown.length} 条标注汇总。`);
  }
}

module.exports={CENTER_VIEW,CENTER_NAME,CENTER_ICON,VaultAnnotationIndex,AnnotationCenterView,filterAnnotationEntries};
