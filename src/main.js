'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, TFile, editorInfoField} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const Core = require('./core');
const Dash = require('./features/dashboard-data');
const {WorkbenchView,VIEW,NAME,viewIcon}=require('./features/workbench');
const {FolderNotes}=require('./features/folder-notes');
const {Figures}=require('./features/figures');
const {ScreenshotNames}=require('./features/screenshot-names');
const {FigureTools}=require('./features/figure-tools');
const {Annotations}=require('./features/annotations');
const {ScrollRuler}=require('./features/scroll-ruler');
const {Decor}=require('./features/decor');
const {WindowGlass}=require('./features/window-glass');
const {Library}=require('./features/library');
const {MarkdownPaste}=require('./features/markdown-paste');
const {TypingMotion}=require('./features/typing-motion');
// aw-palette-* and aw-style-* are listed so classes left by earlier versions are cleaned up.
const APPEARANCE=/^aw-(?:palette|style|caption|glass-fog)-|^aw-(?:figure-tools-off|glass|annot-recall|smooth-caret|sidebar-hover-off|ribbon-hide-off)$/;
// A created note counts as new when it is opened within this time.
const NEW_NOTE_OPEN_MS=10000;
// Settings are saved soon after a change; statistics gathered while typing wait longer, so
// data.json (and any sync of it) is not rewritten several times a second.
const SAVE_MS=750,TYPING_SAVE_MS=10000;
function backupStamp(d){
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// Copies an unreadable or invalid data.json aside before aborting, so user history is never lost.
async function preserveUnreadableData(adapter,dataPath,now=new Date()){
  if(!adapter||typeof adapter.exists!=='function'||typeof adapter.read!=='function'||typeof adapter.write!=='function')
    return {state:'unavailable'};
  try{
    if(!(await adapter.exists(dataPath)))return {state:'missing'};
    const backupPath=`${dataPath}.unreadable-${backupStamp(now)}`;
    await adapter.write(backupPath,await adapter.read(dataPath));
    return {state:'preserved',backupPath};
  }catch(error){return {state:'failed',error};}
}

class WorkbenchSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display() {
    this.containerEl.replaceChildren(); const s=this.plugin.data.settings;
    this.containerEl.createEl('h3',{text:'文件与新建'});
    this.plugin.folderNotes.displaySettings(this.containerEl);
    this.plugin.markdownPaste.displaySettings(this.containerEl,Setting);
    this.containerEl.createEl('h3',{text:'图片与附件'});
    this.plugin.screenshotNames.displaySettings(this.containerEl);
    this.plugin.figureTools.displaySettings(this.containerEl);
    this.containerEl.createEl('h3',{text:'外观'});
    new Setting(this.containerEl).setName('图注与表注字号').setDesc('标准为比正文小一号（打印 9pt，对应小五号）；小为 8pt，大为 10pt。编号「图 1」「表 1」自动加粗。').addDropdown(d=>{
      for(const c of Core.CAPTION_SIZES)d.addOption(c.id,c.label);
      d.setValue(s.captionSize).onChange(v=>this.plugin.setCaptionSize(v));
    });
    this.plugin.windowGlass.displaySettings(this.containerEl,Setting);
    this.plugin.typingMotion.displaySettings(this.containerEl,Setting);
    this.plugin.annotations.displaySettings(this.containerEl);
    this.plugin.scrollRuler.displaySettings(this.containerEl,Setting);
    this.plugin.decor.displaySettings(this.containerEl,Setting);
    this.containerEl.createEl('h3',{text:'工作台与写作统计'});
    new Setting(this.containerEl).setName('启动时打开工作台').setDesc('在新标签页打开，保留原有笔记标签页。').addToggle(t=>t.setValue(s.openOnStartup).onChange(v=>{s.openOnStartup=v;this.plugin.changed();}));
    new Setting(this.containerEl).setName('记录写作量').setDesc('从启用后开始，仅统计本机编辑；关闭时不补记。').addToggle(t=>t.setValue(s.tracking).onChange(v=>{s.tracking=v;this.plugin.data.records={};this.plugin.changed();}));
    new Setting(this.containerEl).setName('状态栏显示今日进度').setDesc('在底部状态栏实时显示今日新增字数与目标进度，点击直接打开写作工作台。').addToggle(t=>t.setValue(s.statusBar!==false).onChange(v=>{s.statusBar=v;this.plugin.updateStatusBar();this.plugin.changed();}));
    new Setting(this.containerEl).setName('每日目标字数').setDesc('填写每日目标新增字数（如 1000）；填 0 或留空则按近期活跃日的日均值对比。').addText(t=>t.setPlaceholder('0（按日均对比）').setValue(s.dailyGoal?String(s.dailyGoal):'').onChange(v=>{
      const n=Math.trunc(Number(v.trim())||0);
      s.dailyGoal=n>0?Math.min(Core.MAX_DAILY_GOAL,n):0;
      this.plugin.updateStatusBar();this.plugin.changed();
    }));
    new Setting(this.containerEl).setName('最近编辑篇数').addSlider(t=>t.setLimits(3,30,1).setValue(s.recentLimit).setDynamicTooltip().onChange(v=>{s.recentLimit=v;this.plugin.changed();}));
    new Setting(this.containerEl).setName('排除文件夹').setDesc('每行一个相对笔记库的路径；同时影响新统计和最近编辑列表，保留历史记录。').addTextArea(t=>t.setValue(s.excludedFolders.join('\n')).onChange(v=>{
      s.excludedFolders=v.split('\n').map(x=>x.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean);this.plugin.data.records={};this.plugin.changed();
    }));
    new Setting(this.containerEl).setName('立即打开工作台').addButton(b=>b.setButtonText('打开').onClick(()=>this.plugin.openWorkbench()));
  }
}

class WorkbenchPlugin extends Plugin {
  async onload() {
    this.saveQueue=Promise.resolve(); this.saving=false; this.saveRequested=false;
    this.documentCounts=new WeakMap(); this.recordDay=Core.dayKey(); this.session={last:null,span:0};
    // Created first: features added below may already ask for the appearance to be applied.
    this.stopped=false; this.readOnly=false; this.saveError=false; this.appearanceDocs=new Set();
    const adapter=this.app?.vault?.adapter;
    const dataPath=`${this.app?.vault?.configDir||'.obsidian'}/plugins/${this.manifest?.id||'algorithm-workbench'}/data.json`;
    let raw=await this.loadData();
    // An empty or literal-"null" file on disk is a truncated data.json, not a fresh install.
    if(raw===null&&typeof adapter?.exists==='function'){
      try{if(await adapter.exists(dataPath))raw=undefined;}catch{raw=undefined;}
    }
    try {this.data=Core.loadState(raw);}
    catch(error){
      this.stopped=true;this.readOnly=true;
      const backup=await preserveUnreadableData(adapter,dataPath);
      const detail=backup.state==='preserved'?`已自动备份为 ${backup.backupPath.split('/').pop()}，原文件未改动。`:'原文件未改动，请先备份 data.json。';
      new Notice(`工作台统计数据无法读取，已停止加载；${detail}`,10000);
      throw error;
    }
    this.folderNotes=this.addChild(new FolderNotes(this));
    this.markdownPaste=this.addChild(new MarkdownPaste(this));
    this.figures=this.addChild(new Figures(this));
    this.figureTools=this.addChild(new FigureTools(this));
    this.screenshotNames=this.addChild(new ScreenshotNames(this));
    this.scrollRuler=this.addChild(new ScrollRuler(this));
    this.decor=this.addChild(new Decor(this));
    this.windowGlass=this.addChild(new WindowGlass(this));
    this.typingMotion=this.addChild(new TypingMotion(this));
    this.registerView(VIEW,leaf=>new WorkbenchView(leaf,this));
    this.addRibbonIcon(viewIcon(),`打开${NAME}`,()=>this.openWorkbench());
    this.addCommand({id:'open-workbench',name:`打开${NAME}`,callback:()=>this.openWorkbench()});
    this.addCommand({id:'copy-weekly-summary',name:'复制本周写作周报',callback:()=>void this.copyWeeklySummary(0)});
    this.statusBarEl=typeof this.addStatusBarItem==='function'?this.addStatusBarItem():null;
    if(this.statusBarEl){
      this.statusBarEl.classList?.add?.('aw-status-badge','mod-clickable');
      this.statusBarEl.setAttribute?.('aria-label',`打开${NAME}`);
      this.statusBarEl.addEventListener?.('click',()=>void this.openWorkbench());
    }
    this.updateStatusBar();
    // The image library and annotation center: right-sidebar panes.
    this.library=this.addChild(new Library(this));
    this.annotations=this.addChild(new Annotations(this));
    // Palette and caption size are body classes read by both stylesheets; popout windows get
    // them too. Windows already open (plugin re-enabled, restored layout) are found via leaves.
    this.applyAppearanceEverywhere();
    this.app.workspace.onLayoutReady(()=>{if(!this.stopped)this.applyAppearanceEverywhere();});
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.applyAppearance(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>this.appearanceDocs.delete(win.document)));
    this.addSettingTab(new WorkbenchSettings(this.app,this));
    this.registerEditorExtension(EditorView.updateListener.of(update=>this.trackUpdate(update)));
    // Quitting closes the window without unloading plugins: save what is still waiting.
    this.registerEvent(this.app.workspace.on('quit',tasks=>{if(this.saveTimer||this.saving)tasks.add(()=>this.flush());}));
    for(const event of ['create','modify','delete']) this.registerEvent(this.app.vault.on(event,file=>{
      if(event==='delete'&&file){
        const today=Core.dayKey();
        this.freshNotes?.delete(file.path);
        if(file instanceof TFile)Core.retractEmptyNewNote(this.data,file.path,today);
        else if(file.path){
          for(const p of Object.keys(this.data.records))if(p===file.path||p.startsWith(file.path+'/'))Core.retractEmptyNewNote(this.data,p,today);
        }
        if(this.data.reading){
          for(const p of Object.keys(this.data.reading))if(p===file.path||p.startsWith(file.path+'/'))delete this.data.reading[p];
        }
        this.updateStatusBar();
        this.scheduleSave();
      }
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      Core.renamePath(this.data,oldPath,file.path);
      if(file instanceof TFile&&Core.isExcluded(file.path,this.data.settings.excludedFolders)){
        Core.retractEmptyNewNote(this.data,file.path,Core.dayKey());
      }
      this.changed();
    }));
    this.registerInterval(window.setInterval(()=>{
      if(this.stopped)return;
      this.cleanRecords(); this.updateStatusBar(); this.scheduleRefresh(); if(this.saveError)this.scheduleSave();
    },60000));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.scheduleRefresh()));
    this.app.workspace.onLayoutReady(()=>{
      if(this.stopped)return;
      // Vault emits create for every existing file while indexing; count only later ones. A new
      // note counts when this Obsidian opens it right after creating it (new note, a link to a
      // missing note, a daily note); files arriving by Sync, git or the file manager are not opened.
      this.registerEvent(this.app.vault.on('create',file=>this.noteCreated(file)));
      this.registerEvent(this.app.workspace.on('file-open',file=>this.trackCreate(file)));
      if(this.data.settings.openOnStartup)void this.openWorkbench();
    });
    this.scheduleSave();
  }
  trackUpdate(update) {
    if(!update.docChanged || !this.data.settings.tracking || this.stopped)return;
    const file=update.state.field(editorInfoField,false)?.file;
    if(!(file instanceof TFile)||file.extension!=='md'||Core.isExcluded(file.path,this.data.settings.excludedFolders))return;
    const date=Core.dayKey(); this.cleanRecords(date);
    let active=false;
    for(const tr of update.transactions) {
      if(!tr.docChanged)continue;
      const user=['input','delete','undo','redo','move'].some(type=>tr.isUserEvent(type));
      const [before,after]=Core.transactionCounts(tr,this.documentCounts);
      Core.recordChange(this.data,file.path,before,after,date,user);
      if(this.countsTasks(tr,user))Core.recordTasks(this.data,file.path,Core.taskDelta(tr),date);
      active||=user;
    }
    if(active)Core.recordActivity(this.data,this.session);
    this.updateStatusBar();
    this.scheduleSave(TYPING_SAVE_MS);this.scheduleRefresh();
  }
  // Pasted or dragged lists are not newly completed work. A checkbox toggle may carry
  // no user-event annotation, so tiny unannotated replacements are accepted as well.
  countsTasks(tr,user){
    if(user)return !tr.isUserEvent('input.paste')&&!tr.isUserEvent('move');
    let size=0;tr.changes.iterChanges((fromA,toA,fromB,toB)=>{size+=(toA-fromA)+(toB-fromB);});
    return size<=2;
  }
  noteCreated(file){
    if(this.stopped||!(file instanceof TFile)||file.extension!=='md')return;
    const now=Date.now(),fresh=this.freshNotes??=new Map();
    // Oldest first: files that were never opened (a sync of many) are dropped as time passes.
    for(const [p,at] of fresh){if(now-at<=NEW_NOTE_OPEN_MS)break;fresh.delete(p);}
    fresh.delete(file.path);fresh.set(file.path,now);
  }
  trackCreate(file){
    const at=file?this.freshNotes?.get(file.path):undefined;
    if(at===undefined)return;
    this.freshNotes.delete(file.path);
    if(Date.now()-at>NEW_NOTE_OPEN_MS)return;
    if(this.stopped||!this.data.settings.tracking||!(file instanceof TFile)||file.extension!=='md'||Core.isExcluded(file.path,this.data.settings.excludedFolders))return;
    Core.recordNote(this.data,Core.dayKey(),file.path);this.changed();
  }
  cleanRecords(date=Core.dayKey()) {
    if(this.recordDay===date)return;
    this.recordDay=date;
    if(Core.pruneRecords(this.data,date))this.scheduleSave();
  }
  scheduleSave(delay=SAVE_MS){
    if(this.stopped||this.readOnly||!this.data)return;
    if(this.saving){this.saveRequested=true;return;}
    // A sooner save replaces a later one already waiting.
    const due=Date.now()+delay;
    if(this.saveTimer&&this.saveDue<=due)return;
    clearTimeout(this.saveTimer);this.saveDue=due;
    this.saveTimer=setTimeout(()=>{this.saveTimer=null;void this.flush();},delay);
  }
  flush(){
    if(this.readOnly||!this.data)return this.saveQueue;
    this.saveRequested=true;
    if(this.saving)return this.saveQueue;
    clearTimeout(this.saveTimer); this.saveTimer=null; this.saving=true;
    // Allocate one snapshot only when its write starts. Further updates coalesce.
    this.saveQueue=(async()=>{
      try {
      while(this.saveRequested){
        this.saveRequested=false;
        try {
          const snapshot=JSON.parse(JSON.stringify(this.data));
          await this.saveData(snapshot); this.saveError=false;
        } catch(error) {
          if(!this.saveError)new Notice('工作台统计保存失败，请检查磁盘空间或权限。');
          this.saveError=true; this.saveRequested=true;
          console.error('Algorithm Workbench: save failed',error);
          break; // Retry on the next timer, not an unbounded error loop.
        }
      }
      } finally { this.saving=false; }
    })();
    return this.saveQueue;
  }
  scheduleRefresh(){
    if(this.stopped || !this.app.workspace.getLeavesOfType(VIEW).length)return;
    if(!this.refreshTimer)this.refreshTimer=setTimeout(()=>{
      this.refreshTimer=null; if(this.stopped)return;
      for(const leaf of this.app.workspace.getLeavesOfType(VIEW))leaf.view.refresh();
    },1500);
  }
  async openWorkbench(){
    try {
      let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
      if(!leaf){leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW,active:true});}
      await this.app.workspace.revealLeaf(leaf);
    }catch(error){new Notice('工作台打开失败，请尝试重新启用插件。');console.error(error);}
  }
  // Appearance settings are body classes read by both stylesheets.
  appearanceClasses(){
    const s=this.data.settings;
    return ['aw-caption-'+s.captionSize].concat(s.figureTools?[]:['aw-figure-tools-off'],this.windowGlass?.classes()??[],this.typingMotion?.classes()??[],this.annotations?.recall?['aw-annot-recall']:[]);
  }
  applyAppearance(doc){
    if(!doc?.body)return;
    (this.appearanceDocs??=new Set()).add(doc);
    const body=doc.body,wanted=this.appearanceClasses();
    for(const name of [...body.classList])if(APPEARANCE.test(name)&&!wanted.includes(name))body.classList.remove(name);
    for(const name of wanted)body.classList.add(name);
    // The handwriting face for annotations, when the user names one.
    const font=this.data?.settings?.annotFont||'';
    if(font)body.style.setProperty('--aw-annot-font',font);else body.style.removeProperty('--aw-annot-font');
  }
  applyAppearanceEverywhere(){
    const docs=new Set(this.appearanceDocs);
    docs.add(this.app.workspace.containerEl?.ownerDocument);
    this.app.workspace.iterateAllLeaves?.(leaf=>docs.add(leaf.view?.containerEl?.ownerDocument));
    for(const doc of docs)this.applyAppearance(doc);
  }
  setCaptionSize(id){
    if(!Core.CAPTION_SIZES.some(c=>c.id===id)||this.data.settings.captionSize===id)return;
    this.data.settings.captionSize=id;
    this.applyAppearanceEverywhere();
    this.changed();
  }
  saveReading(path,item){
    if(this.stopped||this.readOnly||!this.data?.reading)return;
    if(Core.setReading(this.data.reading,path,item))this.scheduleSave(TYPING_SAVE_MS);
  }
  updateStatusBar(){
    const el=this.statusBarEl,s=this.data?.settings;
    if(!el)return;
    if(this.stopped||!s?.tracking||s.statusBar===false){el.hidden=true;return;}
    el.hidden=false;
    const fmt=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
    const today=this.data.days[Core.dayKey()],chars=today?.characters||0,score=Core.dayScore(today),goal=s.dailyGoal||0;
    const met=goal>0&&chars>=goal;
    const text=goal>0
      ?(met?`今日 ${fmt(chars)} / ${fmt(goal)} 字 ✓`:`今日 ${fmt(chars)} / ${fmt(goal)} 字 · ${Math.min(999,Math.round(chars/goal*100))}%`)
      :(score>0?`今日 ${fmt(chars)} 字 · ${fmt(score)} 分`:'今日 0 字');
    if(el.textContent!==text)el.textContent=text;
    el.classList?.toggle?.('is-goal-met',met);
    const tip=goal>0?`今日新增 ${fmt(chars)} 字，目标 ${fmt(goal)} 字（点击打开${NAME}）`:`今日新增 ${fmt(chars)} 字，贡献 ${fmt(score)} 分（点击打开${NAME}）`;
    if(el.title!==tip)el.title=tip;
  }
  async copyWeeklySummary(weekOffset=0){
    const review=Dash.weeklyReview(this.data,new Date(),weekOffset);
    const md=Dash.formatWeeklyMarkdown(review);
    const clip=this.app?.workspace?.containerEl?.ownerDocument?.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
    if(!clip?.writeText){new Notice('当前环境不支持剪贴板写入。');return false;}
    try{await clip.writeText(md);new Notice(`已复制写作周报（${review.startDate} 至 ${review.endDate}）。`);return true;}
    catch{new Notice('复制周报失败。');return false;}
  }
  changed(){this.updateStatusBar();this.scheduleSave();this.scheduleRefresh();}
  onunload(){
    this.windowGlass?.onunload();
    this.typingMotion?.onunload();
    for(const doc of this.appearanceDocs??[]){
      for(const name of [...doc.body.classList])if(APPEARANCE.test(name))doc.body.classList.remove(name);
      doc.body.style.removeProperty('--aw-annot-font');
    }
    this.stopped=true;clearTimeout(this.saveTimer);clearTimeout(this.refreshTimer);this.documentCounts=new WeakMap();if(this.data)void this.flush();
    // Workbench tabs stay where they are: after an update they come back in place (Obsidian's
    // plugin guidelines: do not detach leaves on unload).
  }
}
module.exports=WorkbenchPlugin;
