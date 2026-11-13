'use strict';
const {ItemView,Notice,TFile,setIcon}=require('obsidian');
const Core=require('../core');
const VIEW='algorithm-workbench';
const number=n=>new Intl.NumberFormat('zh-CN').format(n);
const clockFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateFormat=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'});
function el(parent,tag,cls,text){
  const node=parent.ownerDocument.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  parent.appendChild(node);return node;
}
function button(parent,text,cls,fn){
  const node=el(parent,'button',cls,text);node.type='button';node.addEventListener('click',fn);return node;
}
function icon(parent,name,cls='aw-icon'){
  const node=el(parent,'span',cls);node.setAttribute('aria-hidden','true');setIcon(node,name);return node;
}
function folderLabel(file){return file.parent?.path&&file.parent.path!=='/'?file.parent.path:'笔记库';}
function modifiedLabel(mtime,now=new Date()){
  const date=new Date(mtime),day=Core.dayKey(date);
  if(day===Core.dayKey(now))return `今天 ${clockFormat.format(date)}`;
  if(day===Core.dayKey(Core.shiftDay(now,-1)))return '昨天';
  return date.getFullYear()===now.getFullYear()?dateFormat.format(date):`${date.getFullYear()}年${dateFormat.format(date)}`;
}
function metrics(data,now=new Date()){
  const today=Core.dayKey(now),monday=Core.dayKey(Core.shiftDay(now,-((now.getDay()+6)%7)));
  return [data.days[today]?.characters||0,
    Object.entries(data.days).filter(([d])=>d>=monday&&d<=today).reduce((sum,[,day])=>sum+day.characters,0),
    Core.calendarDays(now,data.settings.weeks).filter(d=>d<=today&&(data.days[d]?.characters||0)>0).length];
}

class WorkbenchView extends ItemView{
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.selectedDate=Core.dayKey();this.creatingNote=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return '工作台';}
  getIcon(){return 'layout-dashboard';}
  async onOpen(){this.render();}
  async onClose(){
    this.contentEl.replaceChildren();this.dayEl=null;this.recentEl=null;
    this.heatCells=null;this.statNumbers=null;this.renderStamp=null;this.recentStamp=null;this.dayStamp=null;
  }
  stamp(){return Core.dayKey()+'|'+JSON.stringify(this.plugin.data.settings)+'|'+this.plugin.saveError+'|'+(this.plugin.folderNotes?.getFolder()?.path??'');}
  daySignature(){
    const records=this.plugin.data.days[this.selectedDate]?.files||{};
    return this.selectedDate+'|'+JSON.stringify(Object.entries(records).map(([path,n])=>[path,n,this.app.vault.getAbstractFileByPath(path) instanceof TFile]));
  }
  refresh(){
    if(this.contentEl.getClientRects().length===0)return;
    if(this.renderStamp!==this.stamp()){this.render();return;}
    const data=this.plugin.data,today=Core.dayKey(),values=metrics(data);
    this.statNumbers.forEach((node,i)=>{const value=number(values[i]);if(node.textContent!==value)node.textContent=value;});
    for(const [date,cell] of this.heatCells){
      const n=data.days[date]?.characters||0;
      if(date>today||date<data.started||cell.dataset.awCount===String(n))continue;
      cell.dataset.awCount=String(n);cell.className=`aw-cell aw-level-${Core.heatLevel(n)}`;
      cell.title=`${date} · ${number(n)} 个新增字符`;cell.setAttribute('aria-label',cell.title);
    }
    const files=Core.recentFiles(this.app.vault.getMarkdownFiles(),data.settings);
    if(this.recentStamp!==JSON.stringify(files.map(f=>[f.path,f.stat.mtime])))this.renderRecent(files);
    if(this.dayStamp!==this.daySignature())this.renderDay();
  }
  render(){
    const active=this.contentEl.ownerDocument.activeElement;
    const focusDate=active?.dataset?.awDate,focusRange=active?.dataset?.awWeeks;
    const scrollTop=this.contentEl.scrollTop;
    const helpOpen=this.contentEl.querySelector('.aw-help')?.open||false;
    const heatScroll=this.contentEl.querySelector('.aw-heat-scroll')?.scrollLeft;
    this.contentEl.replaceChildren();this.contentEl.classList.add('aw-view');
    this.statNumbers=[];this.heatCells=new Map();
    const data=this.plugin.data,settings=data.settings,now=new Date();
    const root=el(this.contentEl,'div','aw-page');
    el(root,'div','aw-backdrop').setAttribute('aria-hidden','true');
    const header=el(root,'header','aw-header'),copy=el(header,'div','aw-header-copy');
    el(copy,'h1','aw-title','工作台');
    const date=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'}).format(now);
    const weekday=new Intl.DateTimeFormat('zh-CN',{weekday:'long'}).format(now);
    el(copy,'p','aw-date',`${date} · ${weekday}`);
    const actions=el(header,'div','aw-header-actions');
    const create=button(actions,'','aw-new-note aw-material-control',()=>this.newNote());icon(create,'plus');el(create,'span','','新建笔记');
    const folder=this.plugin.folderNotes?.getFolder();
    create.title=folder?`在 ${folder.path==='/'?'笔记库根目录':folder.path} 中新建`:'按 Obsidian 当前的新建笔记设置创建';
    const refresh=button(actions,'','aw-refresh aw-material-control',()=>this.render());icon(refresh,'refresh-cw');
    refresh.title='刷新';refresh.setAttribute('aria-label','刷新工作台');
    if(!settings.tracking)el(root,'p','aw-notice','写作统计已暂停，可在插件设置中恢复。');
    if(this.plugin.saveError)el(root,'p','aw-notice','统计暂未保存成功，请检查磁盘空间或权限；插件会重试。').setAttribute('role','status');

    const body=el(root,'div','aw-body aw-material-shell');
    this.recentEl=el(body,'section','aw-notes');
    this.renderRecent(Core.recentFiles(this.app.vault.getMarkdownFiles(),settings));
    const sidebar=el(body,'aside','aw-records');sidebar.setAttribute('aria-label','写作记录');
    el(sidebar,'h2','aw-section-title','写作记录');
    const stats=el(sidebar,'div','aw-stats'),values=metrics(data,now);
    for(const [i,label,unit] of [[0,'今日新增','字符'],[1,'本周新增','字符'],[2,'活跃天数','天']]){
      const item=el(stats,'div','aw-stat');el(item,'span','aw-stat-label',label);
      if(i===2)item.title=settings.weeks===27?'最近半年中有新增记录的日期数量':'最近一年中有新增记录的日期数量';
      const value=el(item,'div','aw-stat-value');this.statNumbers.push(el(value,'strong','',number(values[i])));el(value,'span','aw-unit',unit);
    }
    this.dayEl=el(sidebar,'section','aw-day-detail');this.renderDay();
    const heatWrap=this.renderCalendar(root);
    const footer=el(root,'footer','aw-footer');
    const local=el(footer,'span','aw-local');icon(local,'hard-drive');el(local,'span','',settings.tracking?'仅保存在本地':'本地记录 · 已暂停');
    const help=el(footer,'details','aw-help');help.open=helpOpen;el(help,'summary','','如何统计？');
    el(help,'p','','仅统计本机编辑器内的新增字符，不含空白，包含公式、代码和粘贴内容。删除后恢复到当天旧长度不会重复计数，启用前的历史不会补记。');
    this.renderStamp=this.stamp();this.contentEl.scrollTop=scrollTop;
    heatWrap.scrollLeft=heatScroll??heatWrap.scrollWidth;
    if(focusDate)this.heatCells.get(focusDate)?.focus({preventScroll:true});
    else if(focusRange)this.contentEl.querySelector(`[data-aw-weeks="${focusRange}"]`)?.focus({preventScroll:true});
  }
  renderRecent(files){
    if(!this.recentEl)return;
    const area=this.recentEl;area.replaceChildren();
    this.recentStamp=JSON.stringify(files.map(f=>[f.path,f.stat.mtime]));
    const first=files[0];el(area,'h2','aw-section-title','继续编辑');
    if(!first){el(area,'p','aw-empty','还没有笔记，点击“新建笔记”开始记录。');return;}
    const featured=button(area,'','aw-note-card aw-material-surface',()=>this.openFile(first.path));
    featured.setAttribute('aria-label',`继续编辑：${first.basename}`);featured.title=first.path;
    const context=el(featured,'span','aw-note-context');icon(context,'file-text');
    el(context,'span','aw-context-divider');icon(context,'folder');el(context,'span','aw-note-folder',folderLabel(first));
    el(featured,'span','aw-feature-title',first.basename);
    const bottom=el(featured,'span','aw-note-bottom');
    el(bottom,'span','aw-feature-time',`${modifiedLabel(first.stat.mtime)} 更新`);
    const open=el(bottom,'span','aw-open-note','打开笔记');icon(open,'arrow-up-right');
    const rest=files.slice(1);
    if(!rest.length)return;
    el(area,'h2','aw-section-title aw-other-title','其他最近文件');
    const list=el(area,'div','aw-file-list');
    for(const file of rest){
      const row=button(list,'','aw-file-row',()=>this.openFile(file.path));row.title=file.path;
      icon(row,'file-text','aw-file-icon');
      const info=el(row,'span','aw-file-info');el(info,'span','aw-file-name',file.basename);
      const location=el(info,'span','aw-file-path');icon(location,'folder');el(location,'span','',folderLabel(file));
      const time=el(row,'time','aw-file-time',modifiedLabel(file.stat.mtime));time.dateTime=new Date(file.stat.mtime).toISOString();
    }
  }
  renderDay(){
    if(!this.dayEl)return;
    this.dayEl.replaceChildren();this.dayStamp=this.daySignature();
    const date=new Date(this.selectedDate+'T12:00:00');
    const title=date.getFullYear()===new Date().getFullYear()?dateFormat.format(date):`${date.getFullYear()}年${dateFormat.format(date)}`;
    const heading=el(this.dayEl,'h3','aw-selected-date',title);heading.title=this.selectedDate;
    const entries=Object.entries(this.plugin.data.days[this.selectedDate]?.files||{}).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){el(this.dayEl,'p','aw-empty',this.selectedDate<this.plugin.data.started?'这一天在启用之前，没有记录。':'这一天还没有新增记录。');return;}
    const list=el(this.dayEl,'div','aw-day-list');
    for(const [path,count] of entries){
      const file=this.app.vault.getAbstractFileByPath(path),exists=file instanceof TFile;
      const row=button(list,'','aw-day-row',()=>this.openFile(path));row.disabled=!exists;row.title=exists?path:`${path}（文件已移除）`;
      el(row,'span','aw-day-name',exists?file.basename:path);el(row,'span','aw-day-count',`+${number(count)}`);
      row.setAttribute('aria-label',`${exists?file.basename:path}，新增 ${number(count)} 字符${exists?'':'，文件已移除'}`);
    }
  }
  renderCalendar(root){
    const {data}=this.plugin,today=Core.dayKey(),weeks=data.settings.weeks;
    const panel=el(root,'section','aw-calendar aw-material-shell');
    const bar=el(panel,'div','aw-calendar-header');el(bar,'h2','aw-section-title','写作足迹');
    const ranges=el(bar,'div','aw-ranges');ranges.setAttribute('role','group');ranges.setAttribute('aria-label','热力图范围');
    for(const [value,label] of [[27,'半年'],[53,'全年']]){
      const control=button(ranges,label,'aw-range-button',()=>{
        if(data.settings.weeks===value)return;
        data.settings.weeks=value;this.plugin.changed();this.render();
      });
      control.dataset.awWeeks=String(value);control.setAttribute('aria-pressed',String(weeks===value));
    }
    const surface=el(panel,'div','aw-calendar-surface aw-material-surface');
    const heatWrap=el(surface,'div','aw-heat-scroll'),heat=el(heatWrap,'div','aw-heatmap');heat.style.setProperty('--aw-weeks',String(weeks));
    const labels=el(heat,'div','aw-day-labels');labels.setAttribute('aria-hidden','true');
    for(const label of ['一','','三','','五','','日'])el(labels,'span','',label);
    const grid=el(heat,'div','aw-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label','写作日历，方向键移动，回车选择日期');
    const days=Core.calendarDays(new Date(),weeks);let previousMonth='';
    for(let week=0;week<weeks;week++){
      const column=el(grid,'div','aw-week'),month=days[week*7].slice(0,7);
      el(column,'span','aw-month',month!==previousMonth?`${Number(month.slice(5))}月`:'');previousMonth=month;
      for(let row=0;row<7;row++){
        const date=days[week*7+row],count=data.days[date]?.characters||0,future=date>today,untracked=date<data.started;
        const label=`${date} · ${future?'未来日期':untracked?'启用前，无记录':`${number(count)} 个新增字符`}`;
        const cell=button(column,'',`aw-cell aw-level-${Core.heatLevel(count)}`,()=>{
          this.selectedDate=date;
          for(const [day,node] of this.heatCells){node.setAttribute('aria-pressed',String(day===date));node.tabIndex=day===date?0:-1;}
          this.renderDay();
        });
        cell.dataset.awDate=date;cell.dataset.awCount=String(count);cell.title=label;cell.setAttribute('aria-label',label);
        cell.setAttribute('aria-pressed',String(date===this.selectedDate));
        cell.tabIndex=date===(days.includes(this.selectedDate)?this.selectedDate:today)?0:-1;
        if(future||untracked)cell.classList.add('aw-untracked');cell.disabled=future;this.heatCells.set(date,cell);
      }
    }
    grid.addEventListener('keydown',event=>{
      const offset={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}[event.key];
      if(offset===undefined||!event.target.dataset.awDate)return;
      event.preventDefault();const date=days[days.indexOf(event.target.dataset.awDate)+offset],target=this.heatCells.get(date);
      if(target&&!target.disabled){event.target.tabIndex=-1;target.tabIndex=0;target.focus();}
    });
    const caption=el(surface,'div','aw-heat-caption');el(caption,'span','',`从 ${data.started} 开始记录`);
    const legend=el(caption,'span','aw-legend');el(legend,'span','','少');
    for(let level=0;level<=4;level++)el(legend,'i',`aw-level-${level}`).setAttribute('aria-hidden','true');
    el(legend,'span','','多');return heatWrap;
  }
  async newNote(){
    if(this.creatingNote)return;this.creatingNote=true;
    try{
      if(this.plugin.folderNotes?.getFolder())await this.plugin.folderNotes.createNote();
      else if(typeof this.app.commands?.executeCommandById==='function'){
        if(await this.app.commands.executeCommandById('file-explorer:new-file')===false)new Notice('新建笔记命令暂不可用。');
      }else new Notice('请使用 Obsidian 的新建笔记命令。');
    }catch{new Notice('无法新建笔记，请检查目标文件夹。');}
    finally{this.creatingNote=false;}
  }
  async openFile(path){
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!(file instanceof TFile)){new Notice('这篇笔记已被移动或删除。');return;}
    try{await this.app.workspace.getLeaf('tab').openFile(file);}catch{new Notice('无法打开这篇笔记。');}
  }
}
module.exports={WorkbenchView,VIEW,metrics,modifiedLabel};
