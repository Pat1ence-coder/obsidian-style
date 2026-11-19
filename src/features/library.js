'use strict';
const {Component,ItemView,Menu,Modal,Notice,Setting,TFile,MarkdownView,setIcon}=require('obsidian');
const L=require('./library-data');
const VIEW='aw-library',NAME='素材库',ICON='images';
// Cards are added a page at a time as the grid scrolls; GAP matches the CSS gap.
const PAGE=60,GAP=12;
// Top-level folders take turns with the theme's tones, as in the reference.
const TONES=['tone-accent','tone-amber','tone-2','tone-3','tone-4','tone-1','tone-5'];
const FILTER={scope:{kind:'all',value:''},text:'',type:'all',shape:'all',rating:'all',sort:'new',size:'m'};
const pick=(list,id,fallback)=>list.some(x=>x.id===id)?id:fallback;
const basename=path=>path.split('/').pop().replace(/\.md$/i,'');

// A saved filter (leaf state) back into a safe one.
function cleanFilter(raw){
  const f={...FILTER,scope:{...FILTER.scope}};
  if(!raw||typeof raw!=='object')return f;
  const kind=raw.scope?.kind;
  if(['all','unused','rated','folder','tag'].includes(kind))f.scope={kind,value:typeof raw.scope.value==='string'?raw.scope.value:''};
  f.type=pick(L.TYPES,raw.type,'all');f.shape=pick(L.SHAPES,raw.shape,'all');f.rating=pick(L.RATINGS,raw.rating,'all');
  f.sort=pick(L.SORTS,raw.sort,'new');f.size=pick(L.SIZES,raw.size,'m');
  return f;
}

// The index every library view reads: the vault's images with their ratings, tags, pixel sizes
// and the notes that embed or link them. Rebuilt lazily after the vault or the links change.
class Library extends Component{
  constructor(plugin){
    super();this.plugin=plugin;this.app=plugin.app;
    this.cache=null;this.links=null;this.dims=new Map();this.failed=new Set();this.queue=[];this.probing=new Set();this.active=0;this.timer=0;
  }
  onload(){
    this.plugin.registerView(VIEW,leaf=>new LibraryView(leaf,this));
    this.plugin.addRibbonIcon(ICON,'打开'+NAME,()=>void this.open());
    this.plugin.addCommand({id:'open-library',name:'打开'+NAME,callback:()=>void this.open()});
    const vault=this.app.vault;
    // Notes come and go all the time; only pictures and folders change the library.
    const counts=(file,path=file.path)=>!(file instanceof TFile)||L.isImage(path.split('.').pop());
    this.registerEvent(vault.on('create',file=>{if(counts(file))this.changed();}));
    this.registerEvent(vault.on('rename',(file,oldPath)=>{if(counts(file)||counts(file,oldPath))this.changed();}));
    this.registerEvent(vault.on('modify',file=>{this.failed.delete(file.path);if(this.dims.delete(file.path))this.changed();}));
    this.registerEvent(vault.on('delete',file=>{
      const lib=this.plugin.data?.library;
      if(lib&&[lib.ratings,lib.tags].some(t=>Object.keys(t).some(p=>p===file.path||p.startsWith(file.path+'/')))){L.forgetInLibrary(lib,file.path);this.plugin.changed();}
      this.dims.delete(file.path);this.changed();
    }));
    // Links settle after the vault index; "resolved" comes again after edits.
    this.registerEvent(this.app.metadataCache.on('resolved',()=>{this.links=null;this.changed();}));
  }
  onunload(){window.clearTimeout(this.timer);this.queue=[];}
  views(){return this.app.workspace.getLeavesOfType(VIEW).map(l=>l.view).filter(v=>v instanceof LibraryView);}
  changed(){
    this.cache=null;
    if(this.timer||!this.views().length)return;
    this.timer=window.setTimeout(()=>{this.timer=0;for(const v of this.views())v.refreshWhenShown();},300);
  }
  refreshNow(){this.cache=null;for(const v of this.views())v.refresh();}
  items(){
    if(!this.cache){
      this.links??=L.references(this.app.metadataCache.resolvedLinks);
      // The corner picture counts as used too.
      const used=new Set(this.links.used),decor=this.plugin.data.settings.decorImage;
      if(decor)used.add(decor);
      this.cache=L.makeItems(this.app.vault.getFiles(),{lib:this.plugin.data.library,used,dims:this.dims});
    }
    return this.cache;
  }
  refsOf(path){this.items();return this.links.refs.get(path)||[];}
  file(path){const f=this.app.vault.getAbstractFileByPath(path);return f instanceof TFile?f:null;}
  // A picture's pixel size, learnt when its thumbnail (or a probe) loads.
  setDims(path,w,h){
    const old=this.dims.get(path);
    if(!(w>0&&h>0)||(old&&old.w===w&&old.h===h))return;
    this.dims.set(path,{w,h});
    const item=this.cache?.find(i=>i.path===path);
    if(item){item.w=w;item.h=h;}
    // Only a shape filter depends on sizes; otherwise the card updates itself.
    if(this.views().some(v=>v.filter.shape!=='all'))this.changed();
  }
  // Load the pictures whose sizes are unknown (for the shape filter), four at a time.
  probe(items,doc){
    for(const item of items)if(!item.w&&!this.probing.has(item.path)&&!this.failed.has(item.path)){this.probing.add(item.path);this.queue.push(item.path);}
    const win=doc.defaultView||window;
    while(this.active<4&&this.queue.length){
      const path=this.queue.shift(),file=this.file(path);
      if(!file){this.probing.delete(path);continue;}
      this.active++;
      const img=new win.Image();
      const done=()=>{
        this.active--;this.probing.delete(path);img.onload=img.onerror=null;
        if(img.naturalWidth>0&&img.naturalHeight>0)this.setDims(path,img.naturalWidth,img.naturalHeight);else this.failed.add(path);
        this.probe([],doc);
      };
      img.onload=done;img.onerror=done;img.src=this.app.vault.getResourcePath(file);
    }
  }
  setRating(path,n){L.setRating(this.plugin.data.library,path,n);this.plugin.changed();this.refreshNow();}
  setTags(path,tags){L.setTags(this.plugin.data.library,path,tags);this.plugin.changed();this.refreshNow();}
  async open(){
    try{
      const ws=this.app.workspace;
      let leaf=ws.getLeavesOfType(VIEW)[0];
      if(!leaf){leaf=ws.getRightLeaf(false);if(!leaf)return;await leaf.setViewState({type:VIEW,active:true});}
      await ws.revealLeaf(leaf);
    }catch(error){new Notice('素材库打开失败，请尝试重新启用插件。');console.error(error);}
  }
}

class LibraryView extends ItemView{
  constructor(leaf,library){
    super(leaf);this.library=library;this.plugin=library.plugin;
    this.filter=cleanFilter(null);this.expanded=new Set();this.list=[];this.listKey='';this.shown=0;this.cards=new Map();this.cols=[];
  }
  getViewType(){return VIEW;}
  getDisplayText(){return NAME;}
  getIcon(){return ICON;}
  // The filter is kept with the pane, so it survives a restart.
  getState(){return {...super.getState?.(),filter:this.filter};}
  async setState(state,result){
    if(state?.filter){this.filter=cleanFilter(state.filter);this.syncControls();this.refresh(true);}
    await super.setState?.(state,result);
  }
  async onOpen(){
    const root=this.contentEl;root.empty();root.addClass('aw-lib');
    const head=root.createDiv({cls:'aw-lib-head'});
    const title=head.createDiv({cls:'aw-lib-title'});
    setIcon(title.createSpan({cls:'aw-lib-title-icon'}),ICON);title.createSpan({cls:'aw-lib-title-text',text:NAME});
    this.countEl=title.createSpan({cls:'aw-lib-count'});
    const search=head.createDiv({cls:'aw-lib-search'});setIcon(search.createSpan({cls:'aw-lib-search-icon'}),'search');
    this.searchEl=search.createEl('input',{attr:{type:'search',placeholder:'搜索文件名、文件夹、标签','aria-label':'搜索素材'}});
    let typing=0;
    this.registerDomEvent(this.searchEl,'input',()=>{window.clearTimeout(typing);typing=window.setTimeout(()=>{this.filter.text=this.searchEl.value;this.refresh();},150);});
    const bar=head.createDiv({cls:'aw-lib-filters'});
    // Narrow panes have no side list: the scope is a dropdown instead.
    this.scopeEl=bar.createEl('select',{cls:'dropdown aw-lib-pill aw-lib-scope',attr:{'aria-label':'范围'}});
    this.registerDomEvent(this.scopeEl,'change',()=>{const [kind,...rest]=this.scopeEl.value.split(':');this.setScope(kind,rest.join(':'));});
    this.selects={};
    for(const [key,list,label] of [['type',L.TYPES,'类型'],['shape',L.SHAPES,'比例'],['rating',L.RATINGS,'星级'],['sort',L.SORTS,'排序']]){
      const sel=bar.createEl('select',{cls:'dropdown aw-lib-pill',attr:{'aria-label':label}});
      for(const o of list)sel.createEl('option',{text:o.label,attr:{value:o.id}});
      this.registerDomEvent(sel,'change',()=>{this.filter[key]=sel.value;this.saveState();this.refresh();});
      this.selects[key]=sel;
    }
    const sizes=bar.createDiv({cls:'aw-lib-sizes',attr:{role:'group','aria-label':'卡片大小'}});
    this.sizeButtons=L.SIZES.map(s=>{
      const b=sizes.createEl('button',{cls:'aw-lib-size',text:s.label[0],attr:{type:'button','aria-label':s.label}});
      b.dataset.size=s.id;this.registerDomEvent(b,'click',()=>{this.filter.size=s.id;this.syncControls();this.saveState();this.refresh(true);});
      return b;
    });
    const body=root.createDiv({cls:'aw-lib-body'});
    this.sideEl=body.createDiv({cls:'aw-lib-side'});
    this.mainEl=body.createDiv({cls:'aw-lib-main'});
    this.gridEl=this.mainEl.createDiv({cls:'aw-lib-grid'});
    this.emptyEl=this.mainEl.createDiv({cls:'aw-lib-empty'});
    this.moreEl=this.mainEl.createDiv({cls:'aw-lib-more',attr:{'aria-hidden':'true'}});
    const win=root.ownerDocument.defaultView||window;
    // More cards as the end comes near; observing again re-checks after a page is added.
    this.more=new win.IntersectionObserver(entries=>{
      if(entries.some(e=>e.isIntersecting)&&this.shown<this.list.length){this.loadMore();this.more.unobserve(this.moreEl);this.more.observe(this.moreEl);}
    },{root:this.mainEl,rootMargin:'800px 0px'});
    this.more.observe(this.moreEl);
    // A wider or narrower pane changes the number of columns; a pane shown again catches up.
    this.resize=new win.ResizeObserver(()=>{
      if(this.stale&&this.mainEl.offsetParent!==null){this.stale=false;this.refresh();return;}
      if(this.columns()!==this.cols.length)this.relayout();
    });
    this.resize.observe(this.mainEl);
    this.syncControls();
    this.refresh(true);
  }
  async onClose(){this.more?.disconnect();this.resize?.disconnect();this.cards.clear();this.contentEl.empty();}
  saveState(){this.app.workspace.requestSaveLayout?.();}
  syncControls(){
    if(!this.selects)return;
    for(const [key,sel] of Object.entries(this.selects))sel.value=this.filter[key];
    for(const b of this.sizeButtons)b.setAttribute('aria-pressed',String(b.dataset.size===this.filter.size));
    if(this.searchEl&&this.searchEl.value!==this.filter.text)this.searchEl.value=this.filter.text;
  }
  setScope(kind,value=''){this.filter.scope={kind,value};this.saveState();this.refresh();}
  // Links are resolved again after every save while typing. A hidden pane (another sidebar tab,
  // a collapsed sidebar) skips that work and catches up when it is shown.
  refreshWhenShown(){
    if(this.mainEl&&this.mainEl.offsetParent===null){this.stale=true;return;}
    this.refresh();
  }
  refresh(force=false){
    if(!this.gridEl)return;
    this.stale=false;
    const all=this.library.items(),list=L.filterItems(all,this.filter);
    this.renderSide(all);
    const waiting=this.filter.shape!=='all'?all.filter(i=>!i.w&&!this.library.failed.has(i.path)):[];
    if(waiting.length)this.library.probe(waiting,this.contentEl.ownerDocument);
    this.countEl.textContent=list.length===all.length?`${all.length}`:`${list.length} / ${all.length}`;
    this.countEl.title=waiting.length?`还有 ${waiting.length} 张图片的尺寸正在读取`:'';
    const key=this.filter.size+'\n'+list.map(i=>i.path).join('\n');
    if(force||key!==this.listKey){this.listKey=key;this.list=list;this.renderGrid();}
    else{this.list=list;for(const item of list){const card=this.cards.get(item.path);if(card)this.fillCard(card,item);}}
  }

  // Side list: scopes, the folder tree and the tags.
  renderSide(all){
    const side=this.sideEl,f=this.filter.scope,doc=side.ownerDocument;
    const unused=all.filter(i=>!i.used).length,rated=all.filter(i=>i.rating>0).length;
    // Links are re-resolved after every pause in typing; redraw only when something shown changed.
    const key=JSON.stringify([f,[...this.expanded],all.length,unused,rated,all.map(i=>i.folder+'\t'+i.tags.join(','))]);
    if(key===this.sideKey)return;
    this.sideKey=key;
    const top=side.scrollTop;side.empty();
    const row=(parent,{kind,value='',icon,text,count,depth=0,tone,title})=>{
      const b=parent.createEl('button',{cls:'aw-lib-row',attr:{type:'button'}});
      b.setAttribute('aria-pressed',String(f.kind===kind&&(f.value||'')===value));
      b.style.setProperty('--aw-lib-depth',String(depth));
      if(tone)b.style.setProperty('--aw-lib-tone',`var(--ds-${tone})`);
      if(title)b.title=title;
      const i=b.createSpan({cls:'aw-lib-row-icon'});setIcon(i,icon);
      b.createSpan({cls:'aw-lib-row-text',text});b.createSpan({cls:'aw-lib-row-count',text:String(count)});
      b.addEventListener('click',()=>this.setScope(kind,value));
      return b;
    };
    const scopes=side.createDiv({cls:'aw-lib-group'});
    row(scopes,{kind:'all',icon:'images',text:'全部素材',count:all.length});
    row(scopes,{kind:'unused',icon:'inbox',text:'待整理',count:unused,title:'没有被任何笔记引用的图片'});
    row(scopes,{kind:'rated',icon:'star',text:'已评星',count:rated});
    const tree=L.folderTree(all);
    if(tree.children.length){
      side.createDiv({cls:'aw-lib-heading',text:'资源目录'});
      const box=side.createDiv({cls:'aw-lib-group'});
      const walk=(node,depth,tone)=>{
        const open=this.expanded.has(node.path)||(f.kind==='folder'&&f.value.startsWith(node.path+'/'));
        const b=row(box,{kind:'folder',value:node.path,icon:open&&node.children.length?'folder-open':'folder',text:node.name,count:node.count,depth,tone,title:node.path});
        if(node.children.length){
          const twist=doc.createElement('span');twist.className='aw-lib-twist';twist.setAttribute('aria-label',open?'收起':'展开');
          setIcon(twist,open?'chevron-down':'chevron-right');b.prepend(twist);
          twist.addEventListener('click',event=>{
            event.stopPropagation();
            if(open)this.expanded.delete(node.path);else this.expanded.add(node.path);
            this.renderSide(this.library.items());
          });
          if(open)for(const child of node.children)walk(child,depth+1,tone);
        }else b.classList.add('is-leaf');
      };
      tree.children.forEach((node,i)=>walk(node,0,TONES[i%TONES.length]));
    }
    const tags=L.tagCounts(all);
    side.createDiv({cls:'aw-lib-heading',text:'标签'});
    const box=side.createDiv({cls:'aw-lib-tags'});
    if(!tags.length)box.createDiv({cls:'aw-lib-hint',text:'右键图片可以加标签。'});
    for(const {tag,count} of tags){
      const b=box.createEl('button',{cls:'aw-lib-tag',attr:{type:'button'}});
      b.setAttribute('aria-pressed',String(f.kind==='tag'&&f.value===tag));
      b.createSpan({text:'#'+tag});b.createSpan({cls:'aw-lib-tag-count',text:String(count)});
      b.addEventListener('click',()=>this.setScope('tag',tag));
    }
    side.scrollTop=top;
    // The same choices as a dropdown, for narrow panes.
    const sel=this.scopeEl;sel.empty();
    const opt=(parent,kind,value,text)=>parent.createEl('option',{text,attr:{value:`${kind}:${value}`}});
    opt(sel,'all','',`全部素材 ${all.length}`);opt(sel,'unused','',`待整理 ${unused}`);opt(sel,'rated','',`已评星 ${rated}`);
    if(tree.children.length){
      const g=sel.createEl('optgroup',{attr:{label:'资源目录'}});
      const walk=(node,depth)=>{opt(g,'folder',node.path,`${'　'.repeat(depth)}${node.name} ${node.count}`);node.children.forEach(c=>walk(c,depth+1));};
      tree.children.forEach(n=>walk(n,0));
    }
    if(tags.length){const g=sel.createEl('optgroup',{attr:{label:'标签'}});for(const {tag,count} of tags)opt(g,'tag',tag,`#${tag} ${count}`);}
    sel.value=`${f.kind}:${f.value||''}`;
    if(sel.selectedIndex<0)sel.value='all:';
  }

  // Grid: columns, filled a page at a time; each card goes to the shortest column.
  columns(){
    const size=L.SIZES.find(s=>s.id===this.filter.size)||L.SIZES[1];
    return L.columnCount(this.mainEl.clientWidth-this.padding(),size.width,GAP);
  }
  padding(){
    const cs=this.mainEl.ownerDocument.defaultView?.getComputedStyle(this.mainEl);
    return (parseFloat(cs?.paddingLeft)||0)+(parseFloat(cs?.paddingRight)||0);
  }
  makeColumns(){
    const n=this.columns();
    this.colWidth=Math.max(1,(this.mainEl.clientWidth-this.padding()-(n-1)*GAP)/n);
    this.heights=Array(n).fill(0);
    this.cols=Array.from({length:n},()=>this.gridEl.createDiv({cls:'aw-lib-col'}));
  }
  renderGrid(){
    const top=this.mainEl.scrollTop;
    this.gridEl.empty();this.cards.clear();this.shown=0;
    this.contentEl.dataset.size=this.filter.size;
    this.makeColumns();
    this.emptyEl.empty();
    if(!this.list.length){
      const all=this.library.items().length;
      this.emptyEl.setText(!all?'笔记库里还没有图片。':this.filter.scope.kind==='unused'&&!this.filter.text?'所有图片都被笔记引用了。':'没有符合条件的图片。');
    }
    this.loadMore();
    this.mainEl.scrollTop=top;
    // A first page shorter than the pane: let the observer look again.
    if(this.more){this.more.unobserve(this.moreEl);this.more.observe(this.moreEl);}
  }
  loadMore(){
    const batch=this.list.slice(this.shown,this.shown+PAGE);
    L.placeCards(batch,this.heights,this.colWidth,GAP).forEach((col,i)=>this.cols[col].appendChild(this.card(batch[i])));
    this.shown+=batch.length;
    this.moreEl.hidden=this.shown>=this.list.length;
  }
  relayout(){
    const shown=this.list.slice(0,this.shown);
    this.gridEl.empty();this.makeColumns();
    L.placeCards(shown,this.heights,this.colWidth,GAP).forEach((col,i)=>{const card=this.cards.get(shown[i].path);if(card)this.cols[col].appendChild(card);});
  }

  // One picture card: thumbnail with its size and type, name, format and file size, stars, tags.
  card(item){
    const doc=this.contentEl.ownerDocument,file=this.library.file(item.path);
    const card=doc.createElement('div');card.className='aw-lib-card';card.tabIndex=0;card.draggable=true;card.dataset.path=item.path;card.title=item.path;
    const thumb=card.createDiv({cls:'aw-lib-thumb'});
    const img=thumb.createEl('img',{attr:{alt:item.name,loading:'lazy',decoding:'async',draggable:'false'}});
    if(file)img.src=this.app.vault.getResourcePath(file);
    img.addEventListener('load',()=>{this.library.setDims(item.path,img.naturalWidth,img.naturalHeight);const now=this.library.dims.get(item.path);if(now)this.fillDims(card,now.w,now.h);},{once:true});
    img.addEventListener('error',()=>card.addClass('is-broken'),{once:true});
    const badges=thumb.createDiv({cls:'aw-lib-badges'});
    badges.createSpan({cls:'aw-lib-dims'});
    const kind=L.kindOf(item.ext);
    if(kind!=='still')badges.createSpan({cls:'aw-lib-kind aw-lib-kind-'+kind,text:kind.toUpperCase()});
    const caption=card.createDiv({cls:'aw-lib-caption'});
    caption.createDiv({cls:'aw-lib-name',text:item.name});
    const meta=caption.createDiv({cls:'aw-lib-meta'});
    meta.createSpan({cls:'aw-lib-type',text:`${item.ext.toUpperCase()} · ${L.formatSize(item.size)}`});
    const stars=meta.createSpan({cls:'aw-lib-stars',attr:{role:'group','aria-label':'评星'}});
    for(let n=1;n<=5;n++){
      const b=stars.createEl('button',{cls:'aw-lib-star',text:'★',attr:{type:'button','aria-label':`${n} 星`}});
      b.addEventListener('click',event=>{event.stopPropagation();const now=this.library.items().find(i=>i.path===item.path);this.library.setRating(item.path,now?.rating===n?0:n);});
    }
    caption.createDiv({cls:'aw-lib-card-tags'});
    card.addEventListener('click',event=>{if(!event.defaultPrevented)this.openFile(item.path);});
    card.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target===card){event.preventDefault();this.openFile(item.path);}});
    card.addEventListener('contextmenu',event=>{event.preventDefault();this.menu(event,item.path);});
    card.addEventListener('dragstart',event=>this.drag(event,item.path));
    this.fillCard(card,item);
    this.cards.set(item.path,card);
    return card;
  }
  // The parts of a card that change without a re-render: size, stars, tags.
  fillCard(card,item){
    this.fillDims(card,item.w,item.h);
    card.classList.toggle('is-rated',item.rating>0);
    card.querySelectorAll('.aw-lib-star').forEach((b,i)=>b.classList.toggle('is-on',i<item.rating));
    const tags=card.querySelector('.aw-lib-card-tags');
    if(tags.dataset.tags!==item.tags.join('\n')){
      tags.dataset.tags=item.tags.join('\n');tags.empty();
      for(const tag of item.tags){
        const b=tags.createEl('button',{cls:'aw-lib-chip',text:'#'+tag,attr:{type:'button'}});
        b.addEventListener('click',event=>{event.stopPropagation();this.setScope('tag',tag);});
      }
    }
  }

  fillDims(card,w,h){
    const thumb=card.querySelector('.aw-lib-thumb'),dims=card.querySelector('.aw-lib-dims');
    if(w>0&&h>0){
      // Very tall or wide pictures are cropped to between 2.5:1 and 1:2, as in the layout.
      const ratio=Math.min(2,Math.max(.4,h/w));
      thumb.style.aspectRatio=`1 / ${ratio.toFixed(4)}`;thumb.classList.toggle('is-cropped',ratio!==h/w);
      dims.textContent=`${w}×${h}`;dims.hidden=false;
    }else{thumb.style.aspectRatio='4 / 3';dims.hidden=true;}
  }
  // Actions.
  openFile(path){const file=this.library.file(path);if(file)void this.app.workspace.getLeaf('tab').openFile(file);}
  embed(file,source){const link=this.app.fileManager.generateMarkdownLink(file,source);return link.startsWith('!')?link:'!'+link;}
  // Into the note last edited, at its cursor; reading view and other panes are refused.
  insert(path){
    const file=this.library.file(path),leaf=this.app.workspace.getMostRecentLeaf?.(),view=leaf?.view;
    if(!file)return;
    if(!(view instanceof MarkdownView)||view.getMode?.()==='preview'){new Notice('请先在编辑模式下打开一篇笔记。');return;}
    view.editor.replaceSelection(this.embed(file,view.file?.path||''));
    this.app.workspace.setActiveLeaf(leaf,{focus:true});
  }
  async copy(path){
    const file=this.library.file(path);if(!file)return;
    try{await this.contentEl.ownerDocument.defaultView.navigator.clipboard.writeText(this.embed(file,''));new Notice('已复制嵌入链接。');}
    catch{new Notice('复制失败。');}
  }
  // Dragged into a note, Obsidian itself writes the embed (its own drag of a file); without
  // that, the embed goes along as text.
  drag(event,path){
    const file=this.library.file(path);if(!file)return;
    const dm=this.app.dragManager;
    if(typeof dm?.dragFile==='function'&&typeof dm.onDragStart==='function')dm.onDragStart(event,dm.dragFile(event,file));
    else event.dataTransfer?.setData('text/plain',this.embed(file,''));
  }
  menu(event,path){
    const file=this.library.file(path);if(!file)return;
    const item=this.library.items().find(i=>i.path===path),menu=new Menu();
    menu.addItem(i=>i.setTitle('打开').setIcon('image').onClick(()=>this.openFile(path)));
    menu.addItem(i=>i.setTitle('插入到当前笔记').setIcon('image-plus').onClick(()=>this.insert(path)));
    menu.addItem(i=>i.setTitle('复制嵌入链接').setIcon('link').onClick(()=>void this.copy(path)));
    menu.addSeparator();
    menu.addItem(i=>i.setTitle('编辑标签…').setIcon('tags').onClick(()=>this.editTags(path)));
    if(item?.rating)menu.addItem(i=>i.setTitle('清除星级').setIcon('star-off').onClick(()=>this.library.setRating(path,0)));
    menu.addSeparator();
    const refs=this.library.refsOf(path);
    if(!refs.length)menu.addItem(i=>i.setTitle('没有笔记引用它').setIcon('unlink').setDisabled(true));
    for(const note of refs.slice(0,8))menu.addItem(i=>i.setTitle('引用于：'+basename(note)).setIcon('file-text').onClick(()=>{
      const target=this.app.vault.getAbstractFileByPath(note);if(target instanceof TFile)void this.app.workspace.getLeaf('tab').openFile(target);
    }));
    if(refs.length>8)menu.addItem(i=>i.setTitle(`还有 ${refs.length-8} 篇笔记引用它`).setDisabled(true));
    // Obsidian and other plugins add their own file actions (show in the file list, …).
    this.app.workspace.trigger('file-menu',menu,file,'aw-library',this.leaf);
    menu.showAtMouseEvent(event);
  }
  editTags(path){
    const item=this.library.items().find(i=>i.path===path);if(!item)return;
    new TagsModal(this.app,{name:item.name+'.'+item.ext,tags:item.tags,known:L.tagCounts(this.library.items()).map(t=>t.tag)},tags=>this.library.setTags(path,tags)).open();
  }
}

class TagsModal extends Modal{
  constructor(app,{name,tags,known},submit){super(app);this.name=name;this.tags=tags;this.known=known;this.submit=submit;}
  onOpen(){
    const el=this.contentEl;el.addClass('aw-lib-modal');this.setTitle('编辑标签');
    let input;
    new Setting(el).setName(this.name).setDesc('用空格或逗号分隔，最多 12 个。标签只保存在插件数据里，不改动图片文件。').addText(t=>{
      input=t.inputEl;t.setValue(this.tags.join(' ')).setPlaceholder('封面 配色 灵感');
      t.inputEl.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();this.done(input.value);}});
    });
    const others=this.known.filter(t=>!this.tags.includes(t));
    if(others.length){
      const box=el.createDiv({cls:'aw-lib-tags aw-lib-known'});
      for(const tag of others.slice(0,30)){
        const b=box.createEl('button',{cls:'aw-lib-tag',text:'#'+tag,attr:{type:'button'}});
        b.addEventListener('click',()=>{const now=L.parseTags(input.value);if(!now.includes(tag))input.value=[...now,tag].join(' ');b.remove();input.focus();});
      }
    }
    new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('保存').setCta().onClick(()=>this.done(input.value)));
    window.setTimeout(()=>input?.focus(),0);
  }
  done(text){this.submit(L.parseTags(text));this.close();}
  onClose(){this.contentEl.empty();}
}

module.exports={Library,LibraryView,TagsModal,cleanFilter,VIEW};
