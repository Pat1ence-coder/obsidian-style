'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, TFile, editorInfoField} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const Core = require('./core');
const {WorkbenchView,VIEW,NAME,viewIcon}=require('./features/workbench');
const {FolderNotes}=require('./features/folder-notes');
const {Figures}=require('./features/figures');
const {ScreenshotNames}=require('./features/screenshot-names');
const {FigureTools}=require('./features/figure-tools');
const {Annotations}=require('./features/annotations');
const {ScrollRuler}=require('./features/scroll-ruler');
const {Decor}=require('./features/decor');
const {WindowGlass}=require('./features/window-glass');
// aw-palette-* and aw-style-* are listed so classes left by earlier versions are cleaned up.
const APPEARANCE=/^aw-(?:palette|style|caption|glass-fog)-|^aw-(?:figure-tools-off|glass)$/;

class WorkbenchSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display() {
    this.containerEl.replaceChildren(); const s=this.plugin.data.settings;
    this.containerEl.createEl('h3',{text:'文件与新建'});
    this.plugin.folderNotes.displaySettings(this.containerEl);
    this.containerEl.createEl('h3',{text:'图片与附件'});
    this.plugin.screenshotNames.displaySettings(this.containerEl);
    this.plugin.figureTools.displaySettings(this.containerEl);
    this.containerEl.createEl('h3',{text:'外观'});
    new Setting(this.containerEl).setName('图注与表注字号').setDesc('标准为比正文小一号（打印 9pt，对应小五号）；小为 8pt，大为 10pt。编号「图 1」「表 1」自动加粗。').addDropdown(d=>{
      for(const c of Core.CAPTION_SIZES)d.addOption(c.id,c.label);
      d.setValue(s.captionSize).onChange(v=>this.plugin.setCaptionSize(v));
    });
    this.plugin.windowGlass.displaySettings(this.containerEl,Setting);
    this.plugin.annotations.displaySettings(this.containerEl);
    this.plugin.scrollRuler.displaySettings(this.containerEl,Setting);
    this.plugin.decor.displaySettings(this.containerEl,Setting);
    this.containerEl.createEl('h3',{text:'工作台与写作统计'});
    new Setting(this.containerEl).setName('启动时打开工作台').setDesc('在新标签页打开，保留原有笔记标签页。').addToggle(t=>t.setValue(s.openOnStartup).onChange(v=>{s.openOnStartup=v;this.plugin.changed();}));
    new Setting(this.containerEl).setName('记录写作量').setDesc('从启用后开始，仅统计本机编辑；关闭时不补记。').addToggle(t=>t.setValue(s.tracking).onChange(v=>{s.tracking=v;this.plugin.data.records={};this.plugin.changed();}));
    new Setting(this.containerEl).setName('最近编辑篇数').addSlider(t=>t.setLimits(3,30,1).setValue(s.recentLimit).setDynamicTooltip().onChange(v=>{s.recentLimit=v;this.plugin.changed();}));
    new Setting(this.containerEl).setName('排除文件夹').setDesc('每行一个相对笔记库的路径；同时影响新统计和最近编辑列表，保留历史记录。').addTextArea(t=>t.setValue(s.excludedFolders.join('\n')).onChange(v=>{
      s.excludedFolders=v.split('\n').map(x=>x.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean);this.plugin.data.records={};this.plugin.changed();
    }));
    new Setting(this.containerEl).setName('立即打开工作台').addButton(b=>b.setButtonText('打开').onClick(()=>this.plugin.openWorkbench()));
    this.containerEl.createEl('p',{text:'数据保存在此插件目录的 data.json，仅包含设置、日期、文件路径和计数。针对单台设备，不合并多设备统计。'});
  }
}

class WorkbenchPlugin extends Plugin {
  async onload() {
    this.saveQueue=Promise.resolve(); this.saving=false; this.saveRequested=false;
    this.documentCounts=new WeakMap(); this.recordDay=Core.dayKey(); this.session={last:null,span:0};
    // Created first: features added below may already ask for the appearance to be applied.
    this.stopped=false; this.saveError=false; this.appearanceDocs=new Set();
    try {this.data=Core.loadState(await this.loadData());}
    catch(error){new Notice('工作台统计数据无法读取，已停止加载，原文件未改动。请先备份 data.json。',10000);throw error;}
    this.folderNotes=this.addChild(new FolderNotes(this));
    this.figures=this.addChild(new Figures(this));
    this.figureTools=this.addChild(new FigureTools(this));
    this.screenshotNames=this.addChild(new ScreenshotNames(this));
    this.annotations=this.addChild(new Annotations(this));
    this.scrollRuler=this.addChild(new ScrollRuler(this));
    this.decor=this.addChild(new Decor(this));
    this.windowGlass=this.addChild(new WindowGlass(this));
    this.registerView(VIEW,leaf=>new WorkbenchView(leaf,this));
    this.addRibbonIcon(viewIcon(),`打开${NAME}`,()=>this.openWorkbench());
    this.addCommand({id:'open-workbench',name:`打开${NAME}`,callback:()=>this.openWorkbench()});
    // Palette and caption size are body classes read by both stylesheets; popout windows get
    // them too. Windows already open (plugin re-enabled, restored layout) are found via leaves.
    this.applyAppearanceEverywhere();
    this.app.workspace.onLayoutReady(()=>{if(!this.stopped)this.applyAppearanceEverywhere();});
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.applyAppearance(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>this.appearanceDocs.delete(win.document)));
    this.addSettingTab(new WorkbenchSettings(this.app,this));
    this.registerEditorExtension(EditorView.updateListener.of(update=>this.trackUpdate(update)));
    for(const event of ['create','modify','delete']) this.registerEvent(this.app.vault.on(event,file=>{
      if(event==='delete'&&file instanceof TFile){delete this.data.records[file.path];this.scheduleSave();}
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{Core.renamePath(this.data,oldPath,file.path);this.changed();}));
    this.registerInterval(window.setInterval(()=>{
      if(this.stopped)return;
      this.cleanRecords(); this.scheduleRefresh(); if(this.saveError)this.scheduleSave();
    },60000));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.scheduleRefresh()));
    this.app.workspace.onLayoutReady(()=>{
      if(this.stopped)return;
      // Vault emits create for every existing file while indexing; count only later ones.
      this.registerEvent(this.app.vault.on('create',file=>this.trackCreate(file)));
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
    this.changed();
  }
  // Pasted or dragged lists are not newly completed work. A checkbox toggle may carry
  // no user-event annotation, so tiny unannotated replacements are accepted as well.
  countsTasks(tr,user){
    if(user)return !tr.isUserEvent('input.paste')&&!tr.isUserEvent('move');
    let size=0;tr.changes.iterChanges((fromA,toA,fromB,toB)=>{size+=(toA-fromA)+(toB-fromB);});
    return size<=2;
  }
  trackCreate(file){
    if(this.stopped||!this.data.settings.tracking||!(file instanceof TFile)||file.extension!=='md'||Core.isExcluded(file.path,this.data.settings.excludedFolders))return;
    Core.recordNote(this.data,Core.dayKey());this.changed();
  }
  cleanRecords(date=Core.dayKey()) {
    if(this.recordDay===date)return;
    this.recordDay=date;
    if(Core.pruneRecords(this.data,date))this.scheduleSave();
  }
  scheduleSave(){
    if(this.stopped)return;
    if(this.saving){this.saveRequested=true;return;}
    if(!this.saveTimer)this.saveTimer=setTimeout(()=>{this.saveTimer=null;void this.flush();},750);
  }
  flush(){
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
    return ['aw-caption-'+s.captionSize].concat(s.figureTools?[]:['aw-figure-tools-off'],this.windowGlass?.classes()??[]);
  }
  applyAppearance(doc){
    if(!doc?.body)return;
    (this.appearanceDocs??=new Set()).add(doc);
    const body=doc.body,wanted=this.appearanceClasses();
    for(const name of [...body.classList])if(APPEARANCE.test(name)&&!wanted.includes(name))body.classList.remove(name);
    for(const name of wanted)body.classList.add(name);
    // The window glass picture, read by the theme as var(--aw-glass-image).
    const image=this.windowGlass?.image()||'';
    if(image)body.style.setProperty('--aw-glass-image',image);else body.style.removeProperty('--aw-glass-image');
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
  changed(){this.scheduleSave();this.scheduleRefresh();}
  onunload(){
    for(const doc of this.appearanceDocs??[]){
      for(const name of [...doc.body.classList])if(APPEARANCE.test(name))doc.body.classList.remove(name);
      doc.body.style.removeProperty('--aw-glass-image');
      doc.body.style.removeProperty('--aw-annot-font');
    }
    this.stopped=true;clearTimeout(this.saveTimer);clearTimeout(this.refreshTimer);this.documentCounts=new WeakMap();if(this.data)void this.flush();this.app.workspace.detachLeavesOfType(VIEW);}
}
module.exports=WorkbenchPlugin;
