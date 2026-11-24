'use strict';
const __awModules={"main.js":(module,exports,__awRequire)=>{
'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, TFile, editorInfoField} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const Core = __awRequire("core.js");
const Dash = __awRequire("features/dashboard-data.js");
const {WorkbenchView,VIEW,NAME,viewIcon}=__awRequire("features/workbench.js");
const {FolderNotes}=__awRequire("features/folder-notes.js");
const {Figures}=__awRequire("features/figures.js");
const {ScreenshotNames}=__awRequire("features/screenshot-names.js");
const {FigureTools}=__awRequire("features/figure-tools.js");
const {Annotations}=__awRequire("features/annotations.js");
const {ScrollRuler}=__awRequire("features/scroll-ruler.js");
const {Decor}=__awRequire("features/decor.js");
const {WindowGlass}=__awRequire("features/window-glass.js");
const {Library}=__awRequire("features/library.js");
const {MarkdownPaste}=__awRequire("features/markdown-paste.js");
// aw-palette-* and aw-style-* are listed so classes left by earlier versions are cleaned up.
const APPEARANCE=/^aw-(?:palette|style|caption|glass-fog)-|^aw-(?:figure-tools-off|glass|annot-recall)$/;
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
    this.annotations=this.addChild(new Annotations(this));
    this.scrollRuler=this.addChild(new ScrollRuler(this));
    this.decor=this.addChild(new Decor(this));
    this.windowGlass=this.addChild(new WindowGlass(this));
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
    // The image library: its own pane, opened in the right sidebar.
    this.library=this.addChild(new Library(this));
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
    return ['aw-caption-'+s.captionSize].concat(s.figureTools?[]:['aw-figure-tools-off'],this.windowGlass?.classes()??[],this.annotations?.recall?['aw-annot-recall']:[]);
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

},
"core.js":(module,exports,__awRequire)=>{
'use strict';
const Library = __awRequire("features/library-data.js");
const DEFAULT_SETTINGS = { nameScreenshots: true, folderNotes: true, openOnStartup: true, tracking: true, statusBar: true, dailyGoal: 0, recentLimit: 8, range: 90, metric: 'score', captionSize: 'normal', figureTools: true, scrollRuler: true, rulerHeadings: true, rulerMemory: true, pasteSource: true, decorImage: '', glass: true, glassFog: 'normal', annotFont: '', excludedFolders: ['Templates', 'templates'] };
const MAX_DAILY_GOAL = 100000;
const RANGES = [30, 90, 180, 365];
// Figure and table caption sizes; body class aw-caption-<id>, defined in figures.css.
const CAPTION_SIZES = [{id:'small', label:'小'}, {id:'normal', label:'标准'}, {id:'large', label:'大'}];
// How much fog lies over the paper behind the window glass.
const GLASS_FOGS = [{id:'light', label:'淡'}, {id:'normal', label:'标准'}, {id:'strong', label:'浓'}];
// Score weights are documented in the dashboard; values are derived, never stored.
const METRICS = [
  {key:'score', label:'贡献分', unit:'分'},
  {key:'characters', label:'新增字数', unit:'字'},
  {key:'minutes', label:'编辑时长', unit:'分钟'},
  {key:'focus', label:'深度专注', unit:'分钟'},
  {key:'notes', label:'新建笔记', unit:'篇'},
  {key:'tasks', label:'完成任务', unit:'项'}
];
const COUNTERS = ['minutes', 'focus', 'notes', 'tasks'];
const IDLE_GAP = 5, FOCUS_SPAN = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const dict = () => Object.create(null);
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function shiftDay(date, n) {
  const d = new Date(date); d.setHours(12,0,0,0); d.setDate(d.getDate()+n); return d;
}
function countCharacters(text) {
  let count = 0;
  for (const ch of text) if (!/\s/u.test(ch)) count++;
  return count;
}
// Weak keys do not retain closed editors or obsolete immutable documents.
function transactionCounts(tr, cache) {
  const beforeDoc = tr.startState.doc, afterDoc = tr.newDoc;
  let before = cache.get(beforeDoc);
  if (before === undefined) { before = countCharacters(beforeDoc.toString()); cache.set(beforeDoc, before); }
  let delta = 0, splitSurrogate = false;
  const splitsPair = (doc, pos) => pos > 0 && pos < doc.length && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(doc.sliceString(pos-1,pos+1));
  tr.changes.iterChanges((fromA,toA,fromB,toB,inserted) => {
    delta += countCharacters(inserted.toString()) - countCharacters(beforeDoc.sliceString(fromA,toA));
    if (splitsPair(beforeDoc,fromA) || splitsPair(beforeDoc,toA) || splitsPair(afterDoc,fromB) || splitsPair(afterDoc,toB)) splitSurrogate = true;
  });
  const after = splitSurrogate ? countCharacters(afterDoc.toString()) : before + delta;
  cache.set(afterDoc,after);
  return [before,after];
}
function pruneRecords(data, date) {
  let changed = false;
  for (const [path, record] of Object.entries(data.records)) {
    if (record.day !== date) { delete data.records[path]; changed = true; }
  }
  return changed;
}
const MAX_READING = 200;
function loadReading(raw) {
  const out = dict();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const entries = [];
  for (const [path, item] of Object.entries(raw)) {
    if (!path || !item || typeof item !== 'object') continue;
    const p = Number(item.p), at = Number.isFinite(item.at) ? Math.trunc(item.at) : 0;
    if (!(p > 0 && p < 1)) continue;
    const rec = { p: Math.round(p * 10000) / 10000, at };
    if (Number.isInteger(item.line) && item.line >= 0) rec.line = item.line;
    if (typeof item.text === 'string' && item.text.trim()) rec.text = item.text.trim().slice(0, 120);
    if (Number.isFinite(item.hp) && item.hp >= 0 && item.hp <= 1) rec.hp = Math.round(item.hp * 10000) / 10000;
    entries.push([path, rec]);
  }
  entries.sort((a, b) => b[1].at - a[1].at);
  for (const [path, rec] of entries.slice(0, MAX_READING)) out[path] = rec;
  return out;
}
function setReading(reading, path, item) {
  if (!reading || !path) return false;
  if (!item || !(item.p > 0.03 && item.p < 0.98)) {
    if (!own(reading, path)) return false;
    delete reading[path]; return true;
  }
  const prev = own(reading, path) ? reading[path] : null;
  if (prev && Math.abs(prev.p - item.p) < 0.002 && prev.line === item.line && prev.text === item.text) return false;
  reading[path] = item;
  const keys = Object.keys(reading);
  if (keys.length > MAX_READING) {
    keys.sort((a, b) => (reading[a]?.at || 0) - (reading[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - MAX_READING)) delete reading[k];
  }
  return true;
}
function emptyData(now = new Date()) {
  return { version: 2, started: dayKey(now), activityStarted: dayKey(now), settings: {...DEFAULT_SETTINGS}, days: dict(), records: dict(), library: Library.emptyLibrary(), reading: dict() };
}
function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function loadState(raw, now = new Date()) {
  if (raw === null) return emptyData(now);
  // Obsidian returns null when data.json is absent, and undefined when an existing file fails JSON.parse.
  if (raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) throw Error('无法识别统计文件格式');
  if (![1,2].includes(raw.version) || !raw.days || !raw.records || !DATE.test(raw.started)) throw Error('无法识别统计文件格式');
  // Version 1 only tracked characters; the other activity counters start at migration.
  if (raw.version === 2 && !DATE.test(raw.activityStarted)) throw Error('无法识别统计文件格式');
  const d = emptyData(now); d.started = raw.started;
  if (raw.version === 2) d.activityStarted = raw.activityStarted;
  const s = raw.settings || {};
  for (const name of ['openOnStartup', 'tracking', 'statusBar', 'folderNotes', 'nameScreenshots', 'figureTools', 'scrollRuler', 'rulerHeadings', 'rulerMemory', 'glass', 'pasteSource']) if (typeof s[name] === 'boolean') d.settings[name] = s[name];
  if (Number.isInteger(s.dailyGoal) && s.dailyGoal >= 0) d.settings.dailyGoal = Math.min(MAX_DAILY_GOAL, s.dailyGoal);
  if (RANGES.includes(s.range)) d.settings.range = s.range;
  if (METRICS.some(m => m.key === s.metric)) d.settings.metric = s.metric;
  if (CAPTION_SIZES.some(x => x.id === s.captionSize)) d.settings.captionSize = s.captionSize;
  if (typeof s.decorImage === 'string') d.settings.decorImage = s.decorImage.trim().replace(/^\/+/, '').slice(0, 500);
  if (GLASS_FOGS.some(x => x.id === s.glassFog)) d.settings.glassFog = s.glassFog;
  if (typeof s.annotFont === 'string') d.settings.annotFont = s.annotFont.replace(/[;{}<>\\]/g, '').trim().slice(0, 200);
  if (Number.isInteger(s.recentLimit)) d.settings.recentLimit = Math.min(30, Math.max(3,s.recentLimit));
  if (Array.isArray(s.excludedFolders)) d.settings.excludedFolders = s.excludedFolders.filter(x=>typeof x==='string').map(x=>x.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean);
  for (const [date, value] of Object.entries(raw.days)) {
    if (!DATE.test(date) || !value || !value.files || !validCount(value.characters)) throw Error('统计日期或数值损坏');
    const files = dict();
    for (const [path, count] of Object.entries(value.files)) {
      if (!validCount(count)) throw Error('文件统计损坏');
      files[path] = count;
    }
    if (Object.values(files).reduce((a,b)=>a+b,0) !== value.characters) throw Error('统计总数不一致');
    const day = { characters: value.characters, files };
    for (const key of COUNTERS) if (value[key] !== undefined) {
      if (!validCount(value[key])) throw Error('活动统计损坏');
      if (value[key]) day[key] = value[key];
    }
    d.days[date] = day;
  }
  for (const [path,r] of Object.entries(raw.records)) {
    if (!r || !DATE.test(r.day) || !validCount(r.peak) || !validCount(r.last) || r.peak < r.last) throw Error('计数基线损坏');
    if ((r.taskNet !== undefined && !Number.isSafeInteger(r.taskNet)) || (r.taskPeak !== undefined && !validCount(r.taskPeak))) throw Error('任务基线损坏');
    if (r.created !== undefined && typeof r.created !== 'boolean') throw Error('计数基线损坏');
    if (r.day === dayKey(now)) d.records[path] = {...r};
  }
  // Ratings and tags of the image library, plus per-note reading positions: optional, malformed dropped.
  d.library = Library.loadLibrary(raw.library);
  d.reading = loadReading(raw.reading);
  return d;
}
function isExcluded(path, folders) {
  return folders.some(folder => path === folder || path.startsWith(folder + '/'));
}
// Each day's high-water mark counts growth once. Non-user changes move the
// baseline without adding activity; no note contents are stored.
function recordChange(data, path, before, after, date, userEdit = true) {
  let r = own(data.records,path) ? data.records[path] : null;
  if (!r || r.day !== date) r = { day:date, peak:before, last:before };
  if (r.last !== before) r.peak = Math.max(before, r.peak + before-r.last);
  if (!userEdit) {
    r.peak = Math.max(after, r.peak + after-before);
    r.last = after; data.records[path] = r; return 0;
  }
  const added = Math.max(0, after-r.peak);
  r.peak = Math.max(r.peak, after); r.last = after; data.records[path] = r;
  if (added) {
    const day = ensureDay(data,date); day.characters += added;
    day.files[path] = (own(day.files,path) ? day.files[path] : 0) + added;
  }
  return added;
}
function ensureDay(data, date) {
  if (!own(data.days,date)) data.days[date] = {characters:0,files:dict()};
  return data.days[date];
}
// Editing time: minutes containing edits, plus pauses of at most IDLE_GAP minutes
// between them. Once a continuous session reaches FOCUS_SPAN it all counts as focus.
function recordActivity(data, session, now = Date.now()) {
  const minute = Math.floor(now/60000), gap = session.last == null ? Infinity : minute-session.last;
  if (gap <= 0) { if (gap < 0) session.last = minute; return 0; }
  const added = gap <= IDLE_GAP ? gap : 1;
  session.span = gap <= IDLE_GAP ? (session.span||0)+gap : 1; session.last = minute;
  const day = ensureDay(data,dayKey(new Date(now)));
  day.minutes = (day.minutes||0)+added;
  const focus = session.span < FOCUS_SPAN ? 0 : session.span-added < FOCUS_SPAN ? session.span : added;
  if (focus) day.focus = (day.focus||0)+focus;
  return added;
}
const TASK_DONE = /^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\]/gm;
function doneTasks(doc, ranges) {
  let total = 0, start = -1, end = -1;
  const flush = () => { if (end >= 0) total += (doc.sliceString(start,end).match(TASK_DONE)||[]).length; };
  for (const [from,to] of ranges) {
    const a = doc.lineAt(from).from, b = doc.lineAt(to).to;
    if (a <= end) { end = Math.max(end,b); continue; }
    flush(); start = a; end = b;
  }
  flush(); return total;
}
// Net change of checked task lines, reading only the lines a transaction touched.
function taskDelta(tr) {
  const before = [], after = [];
  tr.changes.iterChanges((fromA,toA,fromB,toB) => { before.push([fromA,toA]); after.push([fromB,toB]); });
  return doneTasks(tr.newDoc,after)-doneTasks(tr.startState.doc,before);
}
// Like characters, a per-file daily high-water mark: re-ticking the same task counts once.
function recordTasks(data, path, delta, date) {
  const r = own(data.records,path) ? data.records[path] : null;
  if (!delta || !r || r.day !== date) return 0;
  r.taskNet = (r.taskNet||0)+delta;
  const added = Math.max(0, r.taskNet-(r.taskPeak||0));
  r.taskPeak = Math.max(r.taskPeak||0, r.taskNet);
  if (added) { const day = ensureDay(data,date); day.tasks = (day.tasks||0)+added; }
  return added;
}
function recordNote(data, date, path) {
  const day = ensureDay(data,date);
  day.notes = (day.notes||0)+1;
  if (path) {
    const prev = own(data.records,path) && data.records[path].day === date ? data.records[path] : { day:date, peak:0, last:0 };
    prev.created = true;
    data.records[path] = prev;
  }
}
// Retracts a same-day newly created empty note when deleted (or moved into an excluded folder),
// while preserving historical character contributions of written notes.
function retractEmptyNewNote(data, path, date) {
  if (!path || !own(data.records,path)) return false;
  const r = data.records[path];
  delete data.records[path];
  if (!r || r.day !== date || !r.created) return false;
  const day = data.days[date];
  if (!day || (own(day.files,path) && day.files[path] > 0) || !(day.notes > 0)) return false;
  if (day.notes > 1) day.notes -= 1; else delete day.notes;
  return true;
}
const round1 = n => Math.round(n*10)/10;
function dayScore(day) {
  if (!day) return 0;
  return round1(day.characters/100 + (day.minutes||0)/10 + (day.focus||0)/10 + (day.notes||0)*2 + (day.tasks||0));
}
function metricValue(day, key) {
  if (key === 'score') return dayScore(day);
  return day ? (key === 'characters' ? day.characters : day[key]||0) : 0;
}
function lastDays(now, n) { return Array.from({length:n},(_,i)=>dayKey(shiftDay(now,i-n+1))); }
function summary(data, now, n) {
  const totals = {score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0,longest:0};
  let run = 0;
  for (const date of lastDays(now,n)) {
    const day = data.days[date], score = dayScore(day);
    for (const {key} of METRICS) totals[key] += metricValue(day,key);
    if (score > 0) { totals.active++; run++; totals.longest = Math.max(totals.longest,run); } else run = 0;
  }
  totals.score = round1(totals.score);
  return totals;
}
// A streak survives until the end of today: an idle today still shows yesterday's run.
function currentStreak(data, now = new Date()) {
  let streak = 0, offset = dayScore(data.days[dayKey(now)]) > 0 ? 0 : -1;
  while (dayScore(data.days[dayKey(shiftDay(now,offset))]) > 0) { streak++; offset--; }
  return streak;
}
// Personal intensity: a value's rank among the user's own active days in the chosen
// range, split into quarters. Ranks stay meaningful with only a few active days.
function activeValues(values) { return values.filter(v=>v>0).sort((a,b)=>a-b); }
function rankOf(value, sorted) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo+hi) >> 1; if (sorted[mid] <= value) lo = mid+1; else hi = mid; }
  return lo/sorted.length;
}
function intensity(value, sorted) {
  if (value <= 0) return 0;
  if (!sorted.length) return 4;
  return Math.min(4, Math.max(1, Math.ceil(rankOf(value,sorted)*4)));
}
function percentile(value, sorted) {
  if (value <= 0 || !sorted.length) return null;
  return Math.round(rankOf(value,sorted)*100);
}
function renamePath(data, oldPath, newPath) {
  const renamed = path => path === oldPath ? newPath : path.startsWith(oldPath+'/') ? newPath+path.slice(oldPath.length) : null;
  for (const [path,r] of Object.entries(data.records)) {
    const next = renamed(path); if (!next) continue;
    data.records[next] = r; delete data.records[path];
  }
  for (const day of Object.values(data.days)) for (const [path,n] of Object.entries(day.files)) {
    const next = renamed(path); if (!next) continue;
    day.files[next] = (own(day.files,next) ? day.files[next] : 0)+n; delete day.files[path];
  }
  if (data.library) Library.renameInLibrary(data.library, oldPath, newPath);
  if (data.reading) for (const [path, rec] of Object.entries(data.reading)) {
    const next = renamed(path); if (!next || next === path) continue;
    data.reading[next] = rec; delete data.reading[path];
  }
}
function recentFiles(files, settings) {
  return files.filter(f=>!isExcluded(f.path,settings.excludedFolders)).sort((a,b)=>b.stat.mtime-a.stat.mtime || a.path.localeCompare(b.path)).slice(0,settings.recentLimit);
}
function calendarDays(now, weeks) {
  const monday = shiftDay(now,-((now.getDay()+6)%7));
  const start = shiftDay(monday,-7*(weeks-1));
  return Array.from({length:weeks*7},(_,i)=>dayKey(shiftDay(start,i)));
}
module.exports = {transactionCounts,pruneRecords,DEFAULT_SETTINGS,MAX_DAILY_GOAL,RANGES,METRICS,CAPTION_SIZES,GLASS_FOGS,dayKey,shiftDay,countCharacters,emptyData,loadState,loadReading,setReading,isExcluded,recordChange,
  recordActivity,taskDelta,recordTasks,recordNote,retractEmptyNewNote,dayScore,metricValue,lastDays,summary,currentStreak,activeValues,intensity,percentile,renamePath,recentFiles,calendarDays};

},
"features/library-data.js":(module,exports,__awRequire)=>{
'use strict';
// The image library (素材库), data side: which vault files are images, how they are filtered,
// sorted, shuffled, grouped by folder, analysed for dominant colours and laid out in columns,
// and the ratings and tags the plugin keeps for them. Nothing here touches Obsidian or the DOM.
const STILL=['png','jpg','jpeg','webp','avif','bmp'];
const IMAGE=new Set([...STILL,'gif','svg']);
const TYPES=[{id:'all',label:'全部类型'},{id:'still',label:'图片'},{id:'gif',label:'GIF'},{id:'svg',label:'SVG'}];
const SHAPES=[
  {id:'all',label:'全部比例'},
  {id:'landscape',label:'横图'},
  {id:'portrait',label:'竖图'},
  {id:'square',label:'方图'},
  {id:'wide',label:'宽幅 16:9+'},
  {id:'long',label:'长截图'},
];
const COLORS=[
  {id:'all',label:'全部颜色',hex:''},
  {id:'red',label:'红色系',hex:'#ef5350'},
  {id:'orange',label:'橙色系',hex:'#f59e0b'},
  {id:'yellow',label:'黄色系',hex:'#eab308'},
  {id:'green',label:'绿色系',hex:'#22c55e'},
  {id:'cyan',label:'青色系',hex:'#06b6d4'},
  {id:'blue',label:'蓝色系',hex:'#3b82f6'},
  {id:'purple',label:'紫色系',hex:'#8b5cf6'},
  {id:'light',label:'浅色 / 白',hex:'#f1f5f9'},
  {id:'dark',label:'深色 / 黑',hex:'#334155'},
];
const RATINGS=[{id:'all',label:'全部星级'},{id:'5',label:'★★★★★'},{id:'4',label:'★★★★ 以上'},{id:'3',label:'★★★ 以上'},{id:'2',label:'★★ 以上'},{id:'1',label:'★ 以上'},{id:'none',label:'未评星'}];
const SORTS=[{id:'new',label:'最近修改'},{id:'old',label:'最早修改'},{id:'name',label:'名称'},{id:'large',label:'文件最大'}];
const SIZES=[{id:'s',label:'小卡片',width:150},{id:'m',label:'中卡片',width:210},{id:'l',label:'大卡片',width:300}];
const MAX_TAGS=12,MAX_TAG=32;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const dict=()=>Object.create(null);

const isImage=ext=>IMAGE.has(String(ext||'').toLowerCase());
const kindOf=ext=>{const e=String(ext||'').toLowerCase();return e==='gif'||e==='svg'?e:'still';};
// Landscape, portrait or square (within 10%), or null while the size is unknown.
function shapeOf(w,h){
  if(!(w>0&&h>0))return null;
  const r=w/h;
  return r>1.1?'landscape':r<1/1.1?'portrait':'square';
}
function matchesShape(w,h,shape){
  if(!shape||shape==='all')return true;
  if(!(w>0&&h>0))return false;
  if(shape==='wide')return w/h>=1.65;
  if(shape==='long')return h/w>=1.85;
  return shapeOf(w,h)===shape;
}
function formatSize(bytes){
  const n=Math.max(0,Number(bytes)||0);
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${Math.round(n/1024)} KB`;
  const mb=n/1024/1024;
  return `${mb<10?mb.toFixed(1):Math.round(mb)} MB`;
}

// Pure RGBA pixel analysis (from a small downsampled canvas): extracts up to 2–3 dominant colour
// families (so charts/UI with white backgrounds still match their accent hue) and up to 5 HEX swatches.
function rgbToHex(r,g,b){
  const h=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbToHsl(r,g,b){
  const rn=r/255,gn=g/255,bn=b/255,max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min,l=(max+min)/2;
  if(d===0)return [0,0,l];
  const s=d/(1-Math.abs(2*l-1));
  let h=max===rn?((gn-bn)/d)%6:max===gn?(bn-rn)/d+2:(rn-gn)/d+4;
  h=h*60;if(h<0)h+=360;
  return [h,s,l];
}
function hueBucket(h){
  if(h>=340||h<16)return 'red';
  if(h<42)return 'orange';
  if(h<70)return 'yellow';
  if(h<162)return 'green';
  if(h<200)return 'cyan';
  if(h<255)return 'blue';
  return 'purple';
}
function analyzePixels(rgba){
  if(!rgba||rgba.length<4)return {colors:[],palette:[]};
  const hueWeights=dict(),clusters=new Map();
  let opaque=0,chromatic=0,lightCount=0,darkCount=0;
  for(let i=0;i+3<rgba.length;i+=4){
    if(rgba[i+3]<96)continue;
    const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
    opaque++;
    const [h,s,l]=rgbToHsl(r,g,b);
    if(s>=0.18&&l>=0.12&&l<=0.93){
      chromatic++;
      const bucket=hueBucket(h);
      hueWeights[bucket]=(hueWeights[bucket]||0)+(0.6+s);
    }else if(l<0.28)darkCount++;
    else if(l>0.78)lightCount++;
    const key=((r>>4)<<8)|((g>>4)<<4)|(b>>4);
    let c=clusters.get(key);
    if(!c){c={n:0,r:0,g:0,b:0,s:0};clusters.set(key,c);}
    c.n++;c.r+=r;c.g+=g;c.b+=b;c.s+=s;
  }
  if(!opaque)return {colors:[],palette:[]};
  const colors=Object.entries(hueWeights)
    .filter(([,w])=>w>=opaque*0.045)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,2)
    .map(([k])=>k);
  if(darkCount>=opaque*0.42)colors.push('dark');
  else if(lightCount>=opaque*0.62&&chromatic<=opaque*0.38)colors.push('light');
  if(!colors.length)colors.push(darkCount>=lightCount?'dark':'light');

  const ranked=[...clusters.values()]
    .map(c=>({r:c.r/c.n,g:c.g/c.n,b:c.b/c.n,score:c.n*(1+(c.s/c.n)*0.85)}))
    .sort((a,b)=>b.score-a.score);
  const picked=[];
  for(const cand of ranked){
    if(picked.every(p=>Math.hypot(p.r-cand.r,p.g-cand.g,p.b-cand.b)>=38))picked.push(cand);
    if(picked.length>=5)break;
  }
  for(const cand of ranked){
    if(picked.length>=5)break;
    if(!picked.includes(cand))picked.push(cand);
  }
  const palette=[];
  for(const p of picked){
    const hex=rgbToHex(p.r,p.g,p.b);
    if(!palette.includes(hex))palette.push(hex);
  }
  return {colors,palette};
}

// Ratings (1–5) and tags per image path, kept in the plugin's data.
function emptyLibrary(){return {ratings:dict(),tags:dict()};}
// "a, b，c d" → ['a','b','c','d']: trimmed, no leading #, no repeats, at most 12 of 32 characters.
function parseTags(text){
  const out=[];
  for(const raw of String(text||'').split(/[\s,，、;；]+/)){
    const tag=raw.replace(/^#+/,'').slice(0,MAX_TAG);
    if(tag&&!out.includes(tag))out.push(tag);
    if(out.length>=MAX_TAGS)break;
  }
  return out;
}
function loadLibrary(raw){
  const lib=emptyLibrary();
  if(!raw||typeof raw!=='object')return lib;
  for(const [path,n] of Object.entries(raw.ratings||{}))if(path&&Number.isInteger(n)&&n>=1&&n<=5)lib.ratings[path]=n;
  for(const [path,list] of Object.entries(raw.tags||{})){
    const tags=Array.isArray(list)?parseTags(list.filter(t=>typeof t==='string').join(' ')):[];
    if(path&&tags.length)lib.tags[path]=tags;
  }
  return lib;
}
function setRating(lib,path,n){
  if(Number.isInteger(n)&&n>=1&&n<=5)lib.ratings[path]=n;else delete lib.ratings[path];
}
function setTags(lib,path,tags){
  const list=parseTags((tags||[]).join(' '));
  if(list.length)lib.tags[path]=list;else delete lib.tags[path];
}
// A file or a whole folder moved: its ratings and tags go with it.
function renameInLibrary(lib,oldPath,newPath){
  const moved=path=>path===oldPath?newPath:path.startsWith(oldPath+'/')?newPath+path.slice(oldPath.length):null;
  for(const table of [lib.ratings,lib.tags])for(const path of Object.keys(table)){
    const next=moved(path);
    if(next!==null&&next!==path){table[next]=table[path];delete table[path];}
  }
}
function forgetInLibrary(lib,path){
  for(const table of [lib.ratings,lib.tags])for(const key of Object.keys(table))
    if(key===path||key.startsWith(path+'/'))delete table[key];
}

// Safe names and collision-free vault paths for pasted or dropped images.
function sanitizeImageName(rawName,fallbackExt='png',now=new Date()){
  const p=n=>String(n).padStart(2,'0');
  const stamp=`${now.getFullYear()}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const raw=String(rawName||'').trim();
  const dot=raw.lastIndexOf('.');
  let stem=dot>0?raw.slice(0,dot):raw,ext=(dot>0?raw.slice(dot+1):fallbackExt).toLowerCase();
  if(ext==='jpeg')ext='jpg';
  if(!isImage(ext))ext=isImage(fallbackExt)?String(fallbackExt).toLowerCase():'png';
  stem=stem.replace(/[/\\:*?"<>|\u0000-\u001f]+/g,'-').replace(/^\.+|\.+$/g,'').trim().slice(0,64);
  if(!stem||/^(?:image|blob|clipboard|pasted image)$/i.test(stem))stem=`素材-${stamp}`;
  return {stem,ext,name:`${stem}.${ext}`};
}
function cleanFolder(raw){
  const parts=String(raw||'').replace(/\\/g,'/').split('/').filter(Boolean);
  return parts.some(p=>p==='.'||p==='..')?'':parts.join('/');
}
function uniqueVaultPath(folder,fileName,exists){
  const dir=cleanFolder(folder);
  const dot=fileName.lastIndexOf('.'),stem=dot>0?fileName.slice(0,dot):fileName,ext=dot>0?fileName.slice(dot):'';
  for(let n=0;n<10000;n++){
    const leaf=n===0?`${stem}${ext}`:`${stem}-${n}${ext}`;
    const candidate=dir?`${dir}/${leaf}`:leaf;
    if(!exists(candidate))return candidate;
  }
  throw Error('同名图片过多，请重命名后重试。');
}

// Images referenced from notes: resolvedLinks is {note: {target: count}}. Returns
// {used: Set of image paths, refs: Map image → notes linking to it}.
function references(resolvedLinks){
  const used=new Set(),refs=new Map();
  for(const [note,targets] of Object.entries(resolvedLinks||{}))for(const target of Object.keys(targets||{})){
    if(!isImage(target.split('.').pop()))continue;
    used.add(target);
    if(!refs.has(target))refs.set(target,[]);
    refs.get(target).push(note);
  }
  return {used,refs};
}
// Files (TFile-like: path, basename, extension, stat, parent) → library items.
function makeItems(files,{lib=emptyLibrary(),used=new Set(),dims=new Map(),palettes=new Map()}={}){
  const items=[];
  for(const f of files){
    if(!isImage(f.extension))continue;
    const size=dims.get(f.path),pal=palettes.get(f.path);
    items.push({path:f.path,name:f.basename,ext:String(f.extension).toLowerCase(),folder:f.parent?.path&&f.parent.path!=='/'?f.parent.path:'',
      size:f.stat?.size||0,mtime:f.stat?.mtime||0,rating:own(lib.ratings,f.path)?lib.ratings[f.path]:0,
      tags:own(lib.tags,f.path)?lib.tags[f.path]:[],used:used.has(f.path),w:size?.w||0,h:size?.h||0,
      colors:pal?.colors||[],palette:pal?.palette||[]});
  }
  return items;
}

// What the left panel points at: everything, unused images, rated ones, a folder (and the
// folders under it) or a tag.
function inScope(item,scope){
  switch(scope?.kind){
    case 'unused':return !item.used;
    case 'rated':return item.rating>0;
    case 'folder':return !scope.value||item.folder===scope.value||item.folder.startsWith(scope.value+'/');
    case 'tag':return item.tags.includes(scope.value);
    default:return true;
  }
}
// Every word must appear in the name, the folder or a tag.
function matchesText(item,text){
  const words=String(text||'').toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length)return true;
  const hay=[item.name+'.'+item.ext,item.folder,...item.tags].join('\n').toLowerCase();
  return words.every(w=>hay.includes(w.replace(/^#/,'')));
}
function matches(item,f){
  if(!inScope(item,f.scope)||!matchesText(item,f.text))return false;
  if(f.type&&f.type!=='all'&&kindOf(item.ext)!==f.type)return false;
  if(f.shape&&f.shape!=='all'&&!matchesShape(item.w,item.h,f.shape))return false;
  if(f.color&&f.color!=='all'&&!(item.colors||[]).includes(f.color))return false;
  if(f.rating==='none')return !item.rating;
  if(f.rating&&f.rating!=='all')return item.rating>=Number(f.rating);
  return true;
}
const byName=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})||a.path.localeCompare(b.path);
// Deterministic seeded Fisher-Yates shuffle so rating/tagging in roam mode never scrambles positions.
function shuffleItems(items,seed=1){
  const list=[...items];
  let s=(Number(seed)||1)>>>0;
  const rand=()=>{s=(s+0x6d2b79f5)>>>0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
  for(let i=list.length-1;i>0;i--){
    const j=Math.floor(rand()*(i+1));
    [list[i],list[j]]=[list[j],list[i]];
  }
  return list;
}
function sortItems(items,sort,seed=0){
  if(sort==='shuffle'||seed>0)return shuffleItems(items,seed||1);
  const list=[...items];
  if(sort==='name')return list.sort(byName);
  if(sort==='old')return list.sort((a,b)=>a.mtime-b.mtime||byName(a,b));
  if(sort==='large')return list.sort((a,b)=>b.size-a.size||byName(a,b));
  return list.sort((a,b)=>b.mtime-a.mtime||byName(a,b));
}
const filterItems=(items,f,seed=0)=>sortItems(items.filter(item=>matches(item,f)),f.sort,seed);

// Folders that hold images, nested, each with the number of images in it and below it.
function folderTree(items){
  const root={name:'',path:'',count:0,children:[]},index=new Map([['',root]]);
  const node=path=>{
    if(index.has(path))return index.get(path);
    const cut=path.lastIndexOf('/'),parent=node(cut<0?'':path.slice(0,cut));
    const made={name:path.slice(cut+1),path,count:0,children:[]};
    parent.children.push(made);index.set(path,made);return made;
  };
  for(const item of items){
    root.count++;
    if(!item.folder)continue;
    const parts=item.folder.split('/');
    for(let i=1;i<=parts.length;i++)node(parts.slice(0,i).join('/')).count++;
  }
  const order=n=>{n.children.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));n.children.forEach(order);return n;};
  return order(root);
}
function tagCounts(items){
  const counts=new Map();
  for(const item of items)for(const tag of item.tags)counts.set(tag,(counts.get(tag)||0)+1);
  return [...counts].map(([tag,count])=>({tag,count})).sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag,'zh-CN'));
}

// Card height for a column width: the picture at its own proportions (4:3 while unknown;
// very tall or very wide pictures are cropped to between 2.5:1 and 1:2), plus the caption.
const CAPTION=52;
function cardHeight(item,width){
  const ratio=item.w>0&&item.h>0?Math.min(2,Math.max(.4,item.h/item.w)):.75;
  return width*ratio+CAPTION+(item.tags.length?22:0);
}
// Masonry: each card goes to the currently shortest column (the leftmost on a tie). heights
// carries on from earlier batches, so loading more never moves cards already placed.
function placeCards(items,heights,width,gap){
  return items.map(item=>{
    let col=0;
    for(let i=1;i<heights.length;i++)if(heights[i]<heights[col]-.5)col=i;
    heights[col]+=cardHeight(item,width)+gap;
    return col;
  });
}
function columnCount(width,card,gap){return Math.max(1,Math.floor((width+gap)/(card+gap)));}

module.exports={IMAGE,TYPES,SHAPES,COLORS,RATINGS,SORTS,SIZES,isImage,kindOf,shapeOf,matchesShape,formatSize,
  rgbToHex,analyzePixels,emptyLibrary,parseTags,loadLibrary,setRating,setTags,renameInLibrary,forgetInLibrary,
  sanitizeImageName,cleanFolder,uniqueVaultPath,references,makeItems,inScope,matches,shuffleItems,sortItems,filterItems,
  folderTree,tagCounts,cardHeight,placeCards,columnCount};

},
"features/dashboard-data.js":(module,exports,__awRequire)=>{
'use strict';
// Numbers behind the dashboard's charts and weekly review. Pure: data in, plain values out.
const Core=__awRequire("core.js");
const round1=n=>Math.round(n*10)/10;
const WEEKDAYS=['周一','周二','周三','周四','周五','周六','周日'];

// Daily score for the last n days with a trailing 7-day mean (earlier days feed the mean).
function trendSeries(data,now,n){
  const days=Core.lastDays(now,n+6),scores=days.map(d=>Core.dayScore(data.days[d]));
  return days.slice(6).map((date,i)=>({date,score:scores[i+6],avg:round1(scores.slice(i,i+7).reduce((a,b)=>a+b,0)/7)}));
}
// A round axis maximum split into four equal, readable steps (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k).
function niceMax(value){
  if(!(value>0))return 4;
  const raw=value/4,p=10**Math.floor(Math.log10(raw));
  return [1,1.5,2,2.5,3,4,5,6,8,10].map(m=>m*p).find(step=>step>=raw-1e-9)*4;
}
// Catmull-Rom through the points as cubic Béziers; control points stay inside [top,bottom]
// so a smooth curve never dips below the zero line.
function smoothPath(points,top,bottom){
  if(!points.length)return '';
  const clamp=y=>round1(Math.min(bottom,Math.max(top,y)));
  let d=`M${round1(points[0].x)},${round1(points[0].y)}`;
  for(let i=0;i<points.length-1;i++){
    const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;
    d+=` C${round1(p1.x+(p2.x-p0.x)/6)},${clamp(p1.y+(p2.y-p0.y)/6)} ${round1(p2.x-(p3.x-p1.x)/6)},${clamp(p2.y-(p3.y-p1.y)/6)} ${round1(p2.x)},${round1(p2.y)}`;
  }
  return d;
}
// Today against the mean of the active days before it within the range, plus optional daily goal.
function todayProgress(data,now,range){
  const today=data.days[Core.dayKey(now)];
  const goal=Math.max(0,Number(data.settings?.dailyGoal)||0);
  const before=Core.lastDays(Core.shiftDay(now,-1),range).map(d=>data.days[d]).filter(d=>Core.dayScore(d)>0);
  const mean=key=>before.length?round1(before.reduce((sum,d)=>sum+Core.metricValue(d,key),0)/before.length):null;
  const characters=today?.characters||0;
  return {
    score:Core.dayScore(today),characters,minutes:today?.minutes||0,focus:today?.focus||0,
    notes:today?.notes||0,tasks:today?.tasks||0,avgCharacters:mean('characters'),avgMinutes:mean('minutes'),
    dailyGoal:goal,goalRatio:goal>0?characters/goal:null,goalMet:goal>0&&characters>=goal,
  };
}
// The last six months, oldest first, from the monthly rows (newest first).
function monthBars(rows){
  const list=rows.slice(0,6).reverse(),best=Math.max(0,...list.map(r=>r.score));
  return list.map((r,i)=>({month:r.month,score:round1(r.score),active:r.active,ratio:best>0?r.score/best:0,current:i===list.length-1}));
}

function sumPeriod(data,dates,dailyGoal=0){
  const totals={score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0,goalDays:0};
  for(const date of dates){
    const day=data.days[date],score=Core.dayScore(day);
    for(const {key} of Core.METRICS)totals[key]+=Core.metricValue(day,key);
    if(score>0)totals.active++;
    if(dailyGoal>0&&(day?.characters||0)>=dailyGoal)totals.goalDays++;
  }
  totals.score=round1(totals.score);
  return totals;
}

// Natural Monday–Sunday weekly review (weekOffset = 0 is current week, -1 is previous week, etc.).
// For the current ongoing week, week-over-week comparison uses the same elapsed weekday span so
// Monday morning is compared fairly against last Monday rather than all seven days of last week.
function weeklyReview(data,now=new Date(),weekOffset=0){
  const offset=Math.min(0,Math.trunc(Number(weekOffset)||0));
  const todayKey=Core.dayKey(now),weekday=(now.getDay()+6)%7;
  const thisMonday=Core.shiftDay(now,-weekday);
  const start=Core.shiftDay(thisMonday,offset*7);
  const dates=Array.from({length:7},(_,i)=>Core.dayKey(Core.shiftDay(start,i)));
  const prevDates=Array.from({length:7},(_,i)=>Core.dayKey(Core.shiftDay(start,i-7)));
  const compareLen=offset===0?weekday+1:7;
  const dailyGoal=Math.max(0,Number(data.settings?.dailyGoal)||0);

  const totals=sumPeriod(data,dates.slice(0,compareLen),dailyGoal);
  const prevTotals=sumPeriod(data,prevDates.slice(0,compareLen),dailyGoal);
  const deltas={};
  for(const {key} of Core.METRICS){
    const cur=totals[key],prev=prevTotals[key],diff=key==='score'?round1(cur-prev):cur-prev;
    deltas[key]={diff,pct:prev>0?Math.round((cur-prev)/prev*100):null};
  }

  const days=dates.map((date,i)=>{
    const d=data.days[date];
    return {
      date,weekday:WEEKDAYS[i],future:date>todayKey,isToday:date===todayKey,
      score:Core.dayScore(d),characters:d?.characters||0,minutes:d?.minutes||0,
      focus:d?.focus||0,notes:d?.notes||0,tasks:d?.tasks||0,
      goalMet:dailyGoal>0&&(d?.characters||0)>=dailyGoal,
    };
  });

  const fileMap=new Map(),folderMap=new Map();
  for(const date of dates){
    if(date>todayKey)continue;
    const files=data.days[date]?.files;
    if(!files)continue;
    for(const [path,chars] of Object.entries(files)){
      if(!(chars>0))continue;
      const cur=fileMap.get(path)||{path,name:path.split('/').pop().replace(/\.md$/i,''),folder:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'笔记库根目录',characters:0,days:0};
      cur.characters+=chars;cur.days++;
      fileMap.set(path,cur);
      const fcur=folderMap.get(cur.folder)||{folder:cur.folder,characters:0,notes:new Set()};
      fcur.characters+=chars;fcur.notes.add(path);
      folderMap.set(cur.folder,fcur);
    }
  }
  const topFiles=[...fileMap.values()].sort((a,b)=>b.characters-a.characters||b.days-a.days||a.path.localeCompare(b.path));
  const topFolders=[...folderMap.values()].map(f=>({folder:f.folder,characters:f.characters,noteCount:f.notes.size}))
    .sort((a,b)=>b.characters-a.characters||b.noteCount-a.noteCount||a.folder.localeCompare(b.folder));

  return {
    weekOffset:offset,startDate:dates[0],endDate:dates[6],compareDays:compareLen,dailyGoal,
    totals,prevTotals,deltas,days,topFiles,topFolders,
  };
}

function formatWeeklyMarkdown(review){
  const fmt=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
  const deltaText=(key,unit)=>{
    const d=review.deltas[key];
    if(!d||d.diff===0)return '与上期持平';
    const sign=d.diff>0?'+':'';
    const pct=d.pct===null?'':`，${d.pct>0?'+':''}${d.pct}%`;
    return `较上期${review.compareDays<7?`同期（前 ${review.compareDays} 天）`:''} ${sign}${fmt(d.diff)} ${unit}${pct}`;
  };
  const t=review.totals;
  const lines=[
    `## 写作周报（${review.startDate} 至 ${review.endDate}）`,
    '',
    `- **贡献得分**：${fmt(t.score)} 分（${deltaText('score','分')}）`,
    `- **新增字数**：${fmt(t.characters)} 字（${deltaText('characters','字')}）`,
    `- **编辑 / 专注时长**：${fmt(t.minutes)} 分钟 / ${fmt(t.focus)} 分钟`,
    `- **新建笔记 / 完成任务**：${fmt(t.notes)} 篇 / ${fmt(t.tasks)} 项`,
    `- **活跃天数**：${t.active} / ${review.compareDays} 天${review.dailyGoal>0?`（达标 ${t.goalDays} 天，目标 ${fmt(review.dailyGoal)} 字/天）`:''}`,
  ];
  if(review.topFiles.length){
    lines.push('','### 本周重点笔记','');
    review.topFiles.slice(0,8).forEach((f,i)=>{
      lines.push(`${i+1}. **${f.name}**（\`${f.folder}\`）：+${fmt(f.characters)} 字 · 活跃 ${f.days} 天`);
    });
  }
  if(review.topFolders.length>1){
    lines.push('','### 目录投入分布','');
    for(const f of review.topFolders.slice(0,6)){
      lines.push(`- \`${f.folder}\`：+${fmt(f.characters)} 字（${f.noteCount} 篇笔记）`);
    }
  }
  return lines.join('\n')+'\n';
}

module.exports={trendSeries,niceMax,smoothPath,todayProgress,monthBars,weeklyReview,formatWeeklyMarkdown};

},
"features/workbench.js":(module,exports,__awRequire)=>{
'use strict';
const {ItemView,Menu,Notice,TFile,setIcon,getIcon}=require('obsidian');
const Core=__awRequire("core.js");
const Dash=__awRequire("features/dashboard-data.js");
const VIEW='algorithm-workbench';
const NAME='写作工作台';
// notebook-pen is a newer Lucide icon; older Obsidian builds fall back to pencil.
// Probed once: getIcon builds a throwaway SVG and Obsidian asks for the view icon often.
let probedIcon=null;
const viewIcon=()=>probedIcon??=(typeof getIcon==='function'&&!getIcon('notebook-pen')?'pencil':'notebook-pen');
const WEEKS=53;
const number=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
const hours=minutes=>number(Math.round(minutes/6)/10);
const clockFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateFormat=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'});
const fullDateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'});
const TABS=[['board','看板视图'],['recent','最近笔记'],['monthly','月度汇总'],['weekly','周度复盘']];
const metricOf=key=>Core.METRICS.find(m=>m.key===key)||Core.METRICS[0];
// One companion hue per metric; cards, dots, tabs and the heatmap ramp all follow it.
const HUES={score:'tone-accent',characters:'tone-4',minutes:'tone-2',focus:'tone-3',notes:'tone-1',tasks:'tone-5'};
const tint=(node,hue)=>{node.style.setProperty('--aw-hue',`var(--ds-${hue})`);return node;};
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
// Every module shares one header: icon tile, title and an optional pill badge.
function card(parent,{name,iconName,title,badge,hue='tone-accent'}){
  const section=tint(el(parent,'section',`aw-card aw-card-${name}`),hue);
  const head=el(section,'header','aw-card-head');
  icon(head,iconName,'aw-card-icon');
  const copy=el(head,'div','aw-card-copy');el(copy,'h2','aw-card-title',title);
  const pill=el(head,'span','aw-badge',badge);
  return {section,pill,body:el(section,'div','aw-panel')};
}
function stat(parent,label,value,unit,cls='',hue){
  const item=el(parent,'div','aw-stat'+(cls?' '+cls:''));
  if(hue)tint(item,hue);
  const caption=el(item,'span','aw-stat-label');
  if(hue)tint(el(caption,'i','aw-dot'),hue).setAttribute('aria-hidden','true');
  el(caption,'span','',label);
  const line=el(item,'div','aw-stat-value');const strong=el(line,'strong','',value);el(line,'span','aw-unit',unit);
  return strong;
}
const SVG='http://www.w3.org/2000/svg';
function svg(parent,tag,attrs={},text){
  const doc=parent.ownerDocument,node=doc.createElementNS?doc.createElementNS(SVG,tag):doc.createElement(tag);
  for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));
  if(text!==undefined)node.textContent=text;
  parent.appendChild(node);return node;
}
const shortDate=key=>`${Number(key.slice(5,7))}/${Number(key.slice(8))}`;
function folderLabel(file){return file.parent?.path&&file.parent.path!=='/'?file.parent.path:'笔记库';}
function modifiedLabel(mtime,now=new Date()){
  const date=new Date(mtime),day=Core.dayKey(date);
  if(day===Core.dayKey(now))return `今天 ${clockFormat.format(date)}`;
  if(day===Core.dayKey(Core.shiftDay(now,-1)))return '昨天';
  return date.getFullYear()===now.getFullYear()?dateFormat.format(date):`${date.getFullYear()}年${dateFormat.format(date)}`;
}
function overview(data,now=new Date()){
  const s=Core.summary(data,now,data.settings.range);
  return {score:number(s.score),characters:number(s.characters),active:number(s.active),
    streak:number(Core.currentStreak(data,now)),minutes:hours(s.minutes),focus:hours(s.focus),longest:s.longest};
}
// Spreadsheet apps evaluate cells starting with =, +, - or @ as formulas; a leading apostrophe
// keeps text literal, while commas, quotes and line breaks are RFC 4180 quoted.
function csvCell(value){
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  let text=String(value??'');
  if(/^[=+\-@\t\r]/.test(text))text="'"+text;
  return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
function csv(data){
  const rows=[['日期','贡献分','新增字数','编辑分钟','专注分钟','新建笔记','完成任务']];
  for(const date of Object.keys(data.days).sort()){
    const day=data.days[date];rows.push([date,Core.dayScore(day),...Core.METRICS.slice(1).map(m=>Core.metricValue(day,m.key))]);
  }
  return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\n')+'\n';
}
function months(data,now=new Date()){
  const list=[];
  for(let i=11;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);list.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);}
  const rows=new Map(list.map(m=>[m,{month:m,score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0}]));
  for(const [date,day] of Object.entries(data.days)){
    const row=rows.get(date.slice(0,7));if(!row)continue;
    for(const {key} of Core.METRICS)row[key]+=Core.metricValue(day,key);
    if(Core.dayScore(day)>0)row.active++;
  }
  return [...rows.values()].reverse();
}

class WorkbenchView extends ItemView{
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.selectedDate=Core.dayKey();this.tab='board';this.weekOffset=0;this.creatingNote=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return NAME;}
  getIcon(){return viewIcon();}
  async onOpen(){this.render();}
  async onClose(){
    this.contentEl.replaceChildren();this.dayEl=null;this.recentEl=null;
    this.heatCells=null;this.statNumbers=null;this.longestEl=null;this.liveParts=[];this.renderStamp=null;this.recentStamp=null;this.dayStamp=null;
  }
  stamp(){return [Core.dayKey(),JSON.stringify(this.plugin.data.settings),this.plugin.saveError,this.plugin.folderNotes?.getFolder()?.path??'',this.tab==='weekly'?`weekly:${this.weekOffset}`:this.tab].join('|');}
  daySignature(){
    const day=this.plugin.data.days[this.selectedDate],records=day?.files||{};
    return this.selectedDate+'|'+JSON.stringify(day||null)+'|'+(this.ranked||[]).join()+'|'+JSON.stringify(Object.keys(records).map(path=>this.app.vault.getAbstractFileByPath(path) instanceof TFile));
  }
  refresh(){
    if(this.contentEl.getClientRects().length===0)return;
    if(this.renderStamp!==this.stamp()||this.tab==='monthly'||this.tab==='weekly'){this.render();return;}
    if(this.statNumbers){
      const values=overview(this.plugin.data);
      for(const [key,node] of this.statNumbers)if(node.textContent!==values[key])node.textContent=values[key];
      if(this.longestEl)this.longestEl.textContent=`最长连续 ${values.longest} 天`;
    }
    for(const part of this.liveParts||[]){const value=part.read(),key=JSON.stringify(value);if(key!==part.stamp){part.stamp=key;part.draw(value);}}
    if(this.heatCells)this.paintHeat();
    const files=Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings);
    if(this.recentEl&&this.recentStamp!==JSON.stringify(files.map(f=>[f.path,f.stat.mtime])))this.renderRecent(files);
    if(this.dayEl&&this.dayStamp!==this.daySignature())this.renderDay();
  }
  render(){
    const active=this.contentEl.ownerDocument.activeElement;
    const focusDate=active?.dataset?.awDate,focusKey=active?.dataset?.awFocus;
    const scrollTop=this.contentEl.scrollTop;
    const heatScroll=this.contentEl.querySelector('.aw-heat-scroll')?.scrollLeft;
    this.contentEl.replaceChildren();this.contentEl.classList.add('aw-view');
    this.statNumbers=null;this.longestEl=null;this.heatCells=null;this.dayEl=null;this.recentEl=null;this.liveParts=[];
    const data=this.plugin.data,settings=data.settings;
    const root=el(this.contentEl,'div','aw-page');
    this.renderHero(root);
    if(!settings.tracking)el(root,'p','aw-notice','活动统计已暂停，可在插件设置中恢复。');
    if(this.plugin.saveError)el(root,'p','aw-notice','统计暂未保存成功，请检查磁盘空间或权限；插件会重试。').setAttribute('role','status');
    // The board is a bento grid of modules; the other views stack full-width cards.
    const board=this.tab==='board';
    const stack=el(root,'div',board?'aw-bento':'aw-stack');
    let heatWrap=null;
    if(board){
      this.renderKpis(stack);this.renderToday(stack);this.renderTrend(stack);
      heatWrap=this.renderPulse(stack);
      this.dayEl=el(stack,'div','aw-day-slot');this.renderDay();
      this.renderMonths(stack);this.renderRecentCard(stack,Math.min(settings.recentLimit,5));
    }else if(this.tab==='recent')this.renderRecentCard(stack,settings.recentLimit);
    else if(this.tab==='weekly')this.renderWeekly(stack);
    else this.renderMonthly(stack);
    this.renderStamp=this.stamp();this.contentEl.scrollTop=scrollTop;
    if(heatWrap)heatWrap.scrollLeft=heatScroll??heatWrap.scrollWidth;
    if(focusDate)this.heatCells?.get(focusDate)?.focus({preventScroll:true});
    else if(focusKey)this.contentEl.querySelector(`[data-aw-focus="${focusKey}"]`)?.focus({preventScroll:true});
  }
  renderHero(root){
    const settings=this.plugin.data.settings;
    const hero=el(root,'header','aw-hero');
    const bar=el(hero,'div','aw-hero-bar'),brand=el(bar,'div','aw-brand');
    icon(brand,viewIcon(),'aw-brand-mark');el(brand,'h1','aw-title',NAME);
    const tabs=el(bar,'nav','aw-tabs');tabs.setAttribute('aria-label','视图');
    for(const [key,label] of TABS){
      const tab=button(tabs,label,'aw-tab',()=>{if(this.tab!==key){this.tab=key;this.render();}});
      tab.dataset.awFocus='tab-'+key;tab.setAttribute('aria-pressed',String(this.tab===key));
    }
    const tools=el(hero,'div','aw-toolbar');
    const range=button(tools,'','aw-chip',event=>this.chooseRange(event));range.dataset.awFocus='range';
    el(range,'span','aw-chip-key','时间:');el(range,'span','',`最近 ${settings.range} 天`);icon(range,'chevron-down','aw-chip-icon');
    const create=button(tools,'','aw-chip aw-new-note',()=>this.newNote());icon(create,'plus','aw-chip-icon');el(create,'span','','新建笔记');
    const folder=this.plugin.folderNotes?.getFolder();
    create.title=folder?`在 ${folder.path==='/'?'笔记库根目录':folder.path} 中新建`:'按 Obsidian 当前的新建笔记设置创建';
    button(tools,'复制本周周报','aw-chip aw-copy-weekly',()=>void this.copyWeekly(0));
    button(tools,'导出全量 CSV','aw-chip aw-export',()=>this.exportCSV());
    const refresh=button(tools,'刷新','aw-chip aw-refresh',()=>this.render());refresh.setAttribute('aria-label','刷新看板');
  }
  chooseRange(event){
    const settings=this.plugin.data.settings;
    const choose=value=>{if(settings.range===value)return;settings.range=value;this.plugin.changed();this.render();};
    if(typeof Menu!=='function'){choose(Core.RANGES[(Core.RANGES.indexOf(settings.range)+1)%Core.RANGES.length]);return;}
    const menu=new Menu();
    for(const value of Core.RANGES)menu.addItem(item=>item.setTitle(`最近 ${value} 天`).setChecked(settings.range===value).onClick(()=>choose(value)));
    menu.showAtMouseEvent(event);
  }
  // A part that redraws itself on refresh() whenever the value read() returns changes.
  // read() runs once per check and its value goes straight to draw().
  live(read,draw){const value=read(),part={read,stamp:JSON.stringify(value),draw};this.liveParts.push(part);draw(value);return part;}
  renderKpis(stack){
    const data=this.plugin.data,values=overview(data);this.statNumbers=new Map();
    const kpis=[
      {key:'score',label:'累计贡献分',unit:'分',iconName:'sparkles',badge:`近 ${data.settings.range} 天`,foot:['active','活跃天数','天']},
      {key:'characters',label:'新增字数',unit:'字',iconName:'pen-line',badge:`最长连续 ${values.longest} 天`,foot:['streak','当前连续','天'],longest:true},
      {key:'minutes',label:'编辑时长',unit:'小时',iconName:'clock',badge:'',foot:['focus','深度专注','小时']},
    ];
    for(const k of kpis){
      const box=tint(el(stack,'section',`aw-kpi aw-kpi-${k.key}`),HUES[k.key]);
      el(box,'i','aw-kpi-glow').setAttribute('aria-hidden','true');
      const head=el(box,'header','aw-kpi-head');icon(head,k.iconName,'aw-kpi-icon');el(head,'h2','aw-kpi-label',k.label);
      const pill=el(head,'span','aw-badge',k.badge);if(k.longest)this.longestEl=pill;
      const line=el(box,'div','aw-kpi-value');this.statNumbers.set(k.key,el(line,'strong','',values[k.key]));el(line,'span','aw-unit',k.unit);
      const [fk,fl,fu]=k.foot,foot=el(box,'div','aw-kpi-foot');
      el(foot,'span','',fl);this.statNumbers.set(fk,el(foot,'strong','',values[fk]));el(foot,'span','',fu);
    }
  }
  renderToday(stack){
    const c=card(stack,{name:'today',iconName:'sun',title:'今日进度',badge:'',hue:'tone-accent'});
    const box=el(c.body,'div','aw-today'),range=this.plugin.data.settings.range;
    const read=()=>Dash.todayProgress(this.plugin.data,new Date(),range);
    this.live(read,t=>{
      c.pill.textContent=`${number(t.score)} 分`;box.replaceChildren();
      const charTarget=t.dailyGoal>0?t.dailyGoal:t.avgCharacters;
      const charRatio=charTarget?t.characters/charTarget:0;
      const minRatio=t.avgMinutes?t.minutes/t.avgMinutes:0;
      for(const [key,label,value,target,ratio,unit] of [
        ['characters','新增字数',t.characters,t.dailyGoal>0?t.dailyGoal:0,charRatio,'字'],
        ['minutes','编辑时长',t.minutes,0,minRatio,'分钟'],
      ]){
        const row=tint(el(box,'div','aw-progress-row'),HUES[key]),top=el(row,'div','aw-progress-top');
        el(top,'span','aw-progress-label',label);
        const v=el(top,'span','aw-progress-value');el(v,'strong','',number(value));
        el(v,'span','aw-unit',target>0?`/ ${number(target)} ${unit}`:unit);
        const bar=el(row,'div','aw-progress');bar.setAttribute('role','presentation');
        el(bar,'i').style.setProperty('--aw-progress',String(Math.min(1,ratio)));
      }
      const foot=el(box,'div','aw-today-foot');
      for(const [label,value,unit] of [['专注',t.focus,'分钟'],['新建',t.notes,'篇'],['任务',t.tasks,'项']]){
        const item=el(foot,'span','aw-today-item');el(item,'span','',label);el(item,'strong','',number(value));el(item,'span','',unit);
      }
    });
    const create=button(c.body,'','aw-primary',()=>this.newNote());create.dataset.awFocus='today-new';
    icon(create,'plus','aw-chip-icon');el(create,'span','','新建笔记');
  }
  renderTrend(stack){
    const range=this.plugin.data.settings.range,n=range<=30?30:90;
    const c=card(stack,{name:'trend',iconName:'trending-up',title:'活跃趋势',badge:'',hue:HUES.score});
    const legend=el(c.body,'div','aw-chart-legend');
    for(const [cls,text] of [['aw-key-bar','每日贡献分'],['aw-key-line','7 日均线']]){
      const key=el(legend,'span','aw-key');el(key,'i',cls).setAttribute('aria-hidden','true');el(key,'span','',text);
    }
    const plot=el(c.body,'div','aw-trend-plot');
    const read=()=>Dash.trendSeries(this.plugin.data,new Date(),n);
    this.live(read,series=>{plot.replaceChildren();this.drawTrend(plot,series,c.pill);});
  }
  drawTrend(plot,series,pill){
    const W=640,H=220,L=34,R=10,T=16,B=192,n=series.length,step=(W-L-R)/(n-1);
    const peak=series.reduce((best,d)=>d.score>best.score?d:best,series[0]);
    const max=Dash.niceMax(Math.max(peak.score,...series.map(d=>d.avg)));
    const x=i=>L+i*step,y=v=>B-v/max*(B-T);
    pill.textContent=peak.score>0?`峰值 ${number(peak.score)} 分`:'暂无活动';
    const chart=svg(plot,'svg',{class:'aw-trend',viewBox:`0 0 ${W} ${H}`,role:'img',
      'aria-label':`最近 ${n} 天每日贡献分，峰值 ${number(peak.score)} 分（${peak.date}），今天 ${number(series[n-1].score)} 分`});
    const grid=svg(chart,'g',{class:'aw-trend-grid'});
    for(let k=0;k<=4;k++){const v=max*k/4,yy=y(v);svg(grid,'line',{x1:L,x2:W-R,y1:yy,y2:yy});svg(grid,'text',{x:L-8,y:yy+4,'text-anchor':'end'},number(v));}
    const every=Math.ceil(n/6);
    for(let i=n-1;i>=0;i-=every){if(x(i)<L+18)break;svg(grid,'text',{x:x(i),y:H-8,'text-anchor':i===n-1?'end':'middle'},i===n-1?'今天':shortDate(series[i].date));}
    // Daily values as thin columns; the 7-day mean is the smooth line that carries the trend.
    const bars=svg(chart,'g',{class:'aw-trend-bars'}),bw=Math.max(1.5,Math.min(8,step-2));
    series.forEach((d,i)=>{if(d.score>0)svg(bars,'rect',{x:x(i)-bw/2,y:y(d.score),width:bw,height:B-y(d.score),rx:Math.min(2,bw/2)});});
    const line=Dash.smoothPath(series.map((d,i)=>({x:x(i),y:y(d.avg)})),T,B);
    svg(chart,'path',{class:'aw-trend-area',d:`${line} L${x(n-1)},${B} L${L},${B} Z`});
    svg(chart,'path',{class:'aw-trend-line',d:line});
    if(peak.score>0){
      const i=series.indexOf(peak),px=x(i),py=y(peak.score);
      svg(chart,'circle',{class:'aw-trend-peak',cx:px,cy:py-4,r:3});
      svg(chart,'text',{class:'aw-trend-peak-label',x:Math.min(W-R,Math.max(L,px)),y:Math.max(12,py-12),'text-anchor':px>W-60?'end':px<L+40?'start':'middle'},`峰值 ${number(peak.score)}`);
    }
    // Hover: a crosshair per day plus one HTML tooltip.
    const hits=svg(chart,'g',{class:'aw-trend-hits'});
    const tip=el(plot,'div','aw-tip');tip.setAttribute('aria-hidden','true');
    series.forEach((d,i)=>{
      const g=svg(hits,'g',{class:'aw-trend-hit'});
      svg(g,'rect',{x:x(i)-step/2,y:T,width:step,height:B-T,'data-aw-index':i});
      svg(g,'line',{x1:x(i),x2:x(i),y1:T,y2:B});svg(g,'circle',{cx:x(i),cy:y(d.avg),r:4.5});
    });
    const show=i=>{
      const d=series[i];if(!d)return;tip.replaceChildren();
      el(tip,'span','aw-tip-date',d.date);
      const a=el(tip,'span','aw-tip-row');el(a,'i','aw-key-bar');el(a,'span','',`贡献分 ${number(d.score)}`);
      const b=el(tip,'span','aw-tip-row');el(b,'i','aw-key-line');el(b,'span','',`7 日均 ${number(d.avg)}`);
      tip.style.setProperty('--aw-x',String(x(i)/W));tip.classList.add('is-shown');plot.dataset.awHover=String(i);
    };
    hits.addEventListener('pointerover',event=>{
      const i=Number(event.target.getAttribute?.('data-aw-index'));if(Number.isInteger(i))show(i);
    });
    hits.addEventListener('pointerleave',()=>{tip.classList.remove('is-shown');delete plot.dataset.awHover;});
    // A live redraw while typing keeps the day under the pointer on show.
    if(plot.dataset.awHover!==undefined)show(Number(plot.dataset.awHover));
  }
  renderMonths(stack){
    const c=card(stack,{name:'months',iconName:'calendar-range',title:'月度贡献',badge:'',hue:HUES.score});
    const read=()=>Dash.monthBars(months(this.plugin.data));
    this.live(read,bars=>{
      const current=bars[bars.length-1];c.body.replaceChildren();
      c.pill.textContent=`本月 ${current.active} 天活跃`;
      const chart=el(c.body,'div','aw-bars');chart.setAttribute('role','list');
      for(const b of bars){
        const label=`${b.month.slice(0,4)}年${Number(b.month.slice(5))}月 · 贡献分 ${number(b.score)} · 活跃 ${b.active} 天`;
        const col=el(chart,'div','aw-bar-col'+(b.current?' is-current':''));col.setAttribute('role','listitem');col.title=label;col.setAttribute('aria-label',label);
        el(col,'span','aw-bar-value',number(b.score));
        const track=el(col,'div','aw-bar-track');el(track,'i','aw-bar-fill'+(b.score>0?'':' is-empty')).style.setProperty('--aw-bar',String(b.ratio));
        el(col,'span','aw-bar-label',`${Number(b.month.slice(5))}月`);
      }
    });
  }
  renderPulse(stack){
    const data=this.plugin.data,settings=data.settings,metric=metricOf(settings.metric);
    const c=card(stack,{name:'pulse',iconName:'calendar-days',title:'年度活跃热力图',badge:'',hue:HUES[metric.key]});
    this.activeEl=c.pill;
    const tabs=el(c.body,'div','aw-segment');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','热力图指标');
    for(const m of Core.METRICS){
      const tab=tint(button(tabs,'','aw-segment-item',()=>{if(settings.metric===m.key)return;settings.metric=m.key;this.plugin.changed();this.render();}),HUES[m.key]);
      el(tab,'i','aw-dot').setAttribute('aria-hidden','true');el(tab,'span','',m.label);
      tab.dataset.awFocus='metric-'+m.key;tab.setAttribute('aria-pressed',String(settings.metric===m.key));
    }
    const heatWrap=el(c.body,'div','aw-heat-scroll'),heat=el(heatWrap,'div','aw-heatmap');heat.style.setProperty('--aw-weeks',String(WEEKS));
    const grid=el(heat,'div','aw-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label','活跃日历，方向键移动，回车选择日期');
    const days=Core.calendarDays(new Date(),WEEKS),today=Core.dayKey();let previousMonth='';
    this.heatCells=new Map();this.calendar=days;
    for(let week=0;week<WEEKS;week++){
      const column=el(grid,'div','aw-week'),month=days[week*7].slice(0,7);
      el(column,'span','aw-month',month!==previousMonth?`${Number(month.slice(5))}月`:'');previousMonth=month;
      for(let row=0;row<7;row++){
        const date=days[week*7+row];
        const cell=button(column,'','aw-cell',()=>{
          this.selectedDate=date;
          for(const [day,node] of this.heatCells){node.setAttribute('aria-pressed',String(day===date));node.tabIndex=day===date?0:-1;}
          this.renderDay();
        });
        cell.dataset.awDate=date;cell.setAttribute('aria-pressed',String(date===this.selectedDate));
        cell.tabIndex=date===(days.includes(this.selectedDate)?this.selectedDate:today)?0:-1;
        cell.disabled=date>today;this.heatCells.set(date,cell);
      }
    }
    grid.addEventListener('keydown',event=>{
      const offset={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}[event.key];
      if(offset===undefined||!event.target.dataset.awDate)return;
      event.preventDefault();const date=days[days.indexOf(event.target.dataset.awDate)+offset],target=this.heatCells.get(date);
      if(target&&!target.disabled){event.target.tabIndex=-1;target.tabIndex=0;target.focus();}
    });
    const caption=el(c.body,'div','aw-heat-caption');
    const legend=el(caption,'span','aw-legend');el(legend,'span','','少');
    for(let level=0;level<=4;level++)el(legend,'i',`aw-level-${level}`).setAttribute('aria-hidden','true');
    el(legend,'span','','多');
    this.paintHeat();return heatWrap;
  }
  // Recolour in place; personal quartiles move as new activity arrives.
  paintHeat(){
    const data=this.plugin.data,metric=metricOf(data.settings.metric),today=Core.dayKey();
    const windowDays=Core.lastDays(new Date(),data.settings.range),from=windowDays[0];
    const values=windowDays.map(d=>Core.metricValue(data.days[d],metric.key));
    this.ranked=Core.activeValues(values);
    this.activeEl.textContent=`${values.filter(v=>v>0).length} 天活跃`;
    const started=metric.key==='characters'?data.started:data.activityStarted;
    for(const [date,cell] of this.heatCells){
      const value=Core.metricValue(data.days[date],metric.key),future=date>today,untracked=date<started;
      const cls=`aw-cell aw-level-${Core.intensity(value,this.ranked)}${date<from||future?' aw-out':''}${untracked&&!value?' aw-untracked':''}`;
      if(cell.className!==cls)cell.className=cls;
      const label=`${date} · ${future?'未来日期':untracked&&!value?'启用前，无记录':`${metric.label} ${number(value)} ${metric.unit}`}`;
      if(cell.title!==label){cell.title=label;cell.setAttribute('aria-label',label);}
    }
  }
  renderDay(){
    if(!this.dayEl)return;
    this.dayEl.replaceChildren();this.dayStamp=this.daySignature();
    const data=this.plugin.data,day=data.days[this.selectedDate],score=Core.dayScore(day);
    const date=new Date(this.selectedDate+'T12:00:00');
    const c=card(this.dayEl,{name:'day',iconName:'file-text',title:`${fullDateFormat.format(date)} 明细`,badge:`${number(score)} 分`,hue:'tone-1'});
    c.section.querySelector('.aw-card-title').title=this.selectedDate;
    const row=el(c.body,'div','aw-stats aw-stats-compact');
    stat(row,'贡献得分',number(score),'分','',HUES.score);
    stat(row,'新增字数',number(day?.characters||0),'字','',HUES.characters);
    stat(row,'编辑时长',number(day?.minutes||0),'分钟','',HUES.minutes);
    stat(row,'新建笔记',number(day?.notes||0),'篇','',HUES.notes);
    stat(row,'完成任务',number(day?.tasks||0),'项','',HUES.tasks);
    const entries=Object.entries(day?.files||{}).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){el(c.body,'p','aw-empty','暂无记录');return;}
    const list=el(c.body,'div','aw-day-list');
    for(const [path,count] of entries){
      const file=this.app.vault.getAbstractFileByPath(path),exists=file instanceof TFile;
      const row=button(list,'','aw-day-row',()=>this.openFile(path));row.disabled=!exists;row.title=exists?path:`${path}（已移除）`;
      icon(row,'file-text','aw-row-icon');el(row,'span','aw-day-name',exists?file.basename:path);el(row,'span','aw-day-count',`+${number(count)} 字`);
      row.setAttribute('aria-label',`${exists?file.basename:path}，新增 ${number(count)} 字${exists?'':'，文件已移除'}`);
    }
  }
  renderRecentCard(stack,limit){
    const c=card(stack,{name:'recent',iconName:'history',title:'继续编辑',badge:'',hue:'tone-2'});
    this.recentEl=c.body;this.recentPill=c.pill;this.recentLimit=limit;
    this.renderRecent(Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings));
  }
  renderRecent(files){
    if(!this.recentEl)return;
    const area=this.recentEl;area.replaceChildren();
    this.recentStamp=JSON.stringify(files.map(f=>[f.path,f.stat.mtime]));
    const shown=files.slice(0,this.recentLimit);this.recentPill.textContent=`${shown.length} 篇`;
    if(!shown.length){el(area,'p','aw-empty','暂无笔记');return;}
    const list=el(area,'div','aw-file-list');
    shown.forEach((file,i)=>{
      const row=button(list,'',i===0?'aw-file-row aw-file-latest':'aw-file-row',()=>this.openFile(file.path));row.title=file.path;
      if(i===0)row.setAttribute('aria-label',`继续编辑：${file.basename}`);
      icon(row,'file-text','aw-row-icon');
      const info=el(row,'span','aw-file-info');el(info,'span','aw-file-name',file.basename);
      el(info,'span','aw-file-path',folderLabel(file));
      const time=el(row,'time','aw-file-time',modifiedLabel(file.stat.mtime));time.dateTime=new Date(file.stat.mtime).toISOString();
      if(i===0)icon(row,'arrow-up-right','aw-row-open');
    });
  }
  renderMonthly(stack){
    const rows=months(this.plugin.data),best=Math.max(1,...rows.map(r=>r.score));
    const c=card(stack,{name:'monthly',iconName:'table',title:'月度汇总',badge:`${rows.filter(r=>r.active).length} 个月活跃`,hue:'tone-3'});
    const wrap=el(c.body,'div','aw-table-scroll'),table=el(wrap,'table','aw-table');
    const head=el(el(table,'thead'),'tr');
    for(const label of ['月份','贡献分','','新增字数','活跃天数','编辑时长','深度专注','新建笔记','完成任务'])el(head,'th','',label);
    const body=el(table,'tbody');
    for(const r of rows){
      const tr=el(body,'tr',r.active?'':'aw-row-idle');
      el(tr,'td','aw-month-name',`${r.month.slice(0,4)}年${Number(r.month.slice(5))}月`);
      const cells=[number(Math.round(r.score*10)/10),'',number(r.characters),`${r.active} 天`,`${hours(r.minutes)} 时`,`${hours(r.focus)} 时`,number(r.notes),number(r.tasks)];
      cells.forEach((value,i)=>{
        const td=el(tr,'td',i===1?'aw-bar-cell':'',r.active||i===1?value:'—');
        if(i===1&&r.active)el(td,'span','aw-bar').style.setProperty('--aw-bar',String(r.score/best));
      });
    }
  }
  renderWeekly(stack){
    const review=Dash.weeklyReview(this.plugin.data,new Date(),this.weekOffset);
    const c=card(stack,{name:'weekly',iconName:'calendar-range',title:`周度复盘 · ${review.startDate} 至 ${review.endDate}`,badge:`${number(review.totals.score)} 分`,hue:'tone-accent'});
    const nav=el(c.body,'div','aw-week-nav');
    const prevBtn=button(nav,'上一周','aw-chip aw-week-prev',()=>{this.weekOffset-=1;this.render();});prevBtn.dataset.awFocus='week-prev';
    if(this.weekOffset<0){
      const curBtn=button(nav,'回到本周','aw-chip aw-week-now',()=>{this.weekOffset=0;this.render();});curBtn.dataset.awFocus='week-now';
    }
    const nextBtn=button(nav,'下一周','aw-chip aw-week-next',()=>{if(this.weekOffset<0){this.weekOffset+=1;this.render();}});
    nextBtn.disabled=this.weekOffset>=0;nextBtn.dataset.awFocus='week-next';
    const copyBtn=button(nav,'复制 Markdown 周报','aw-chip aw-week-copy',()=>void this.copyWeekly(this.weekOffset));
    copyBtn.dataset.awFocus='week-copy';

    const row=el(c.body,'div','aw-stats aw-week-stats');
    const items=[
      ['score','贡献得分',number(review.totals.score),'分','分'],
      ['characters','新增字数',number(review.totals.characters),'字','字'],
      ['minutes','编辑时长',number(review.totals.minutes),'分钟','分钟'],
      ['focus','深度专注',number(review.totals.focus),'分钟','分钟'],
      ['notes','新建笔记',number(review.totals.notes),'篇','篇'],
      ['tasks','完成任务',number(review.totals.tasks),'项','项'],
    ];
    for(const [key,label,val,unit,deltaUnit] of items){
      const strong=stat(row,label,val,unit,'',HUES[key]),cell=strong.parentElement.parentElement;
      const d=review.deltas[key];
      const delta=d.diff===0?'持平':`${d.diff>0?'+':''}${number(d.diff)} ${deltaUnit}${d.pct===null?'':` · ${d.pct>0?'+':''}${d.pct}%`}`;
      el(cell,'div','aw-stat-delta'+(d.diff>0?' is-up':d.diff<0?' is-down':''),delta);
    }

    const strip=el(c.body,'div','aw-week-strip'),maxScore=Math.max(1,...review.days.map(d=>d.score));
    for(const d of review.days){
      const col=button(strip,'','aw-week-day'+(d.isToday?' is-today':'')+(d.future?' is-future':''),()=>{
        if(d.future)return;
        this.selectedDate=d.date;this.tab='board';this.render();
      });
      col.disabled=d.future;
      col.title=d.future?d.date:`${d.date} · ${number(d.characters)} 字`;
      el(col,'span','aw-week-day-val',d.future?'—':number(d.characters)+' 字');
      const track=el(col,'span','aw-week-day-track');
      const fill=el(track,'i','aw-week-day-fill'+(d.score>0?'':' is-empty')+(d.goalMet?' is-goal-met':''));
      fill.style.setProperty('--aw-bar',String(d.future?0:d.score/maxScore));
      el(col,'span','aw-week-day-name',d.isToday?`${d.weekday} · 今`:d.weekday);
    }

    const cols=el(c.body,'div','aw-week-columns');
    const filesBox=el(cols,'div','aw-week-col');
    el(filesBox,'h3','aw-week-heading','重点笔记');
    if(!review.topFiles.length)el(filesBox,'p','aw-empty','暂无记录');
    else{
      const list=el(filesBox,'div','aw-day-list aw-week-list');
      for(const item of review.topFiles.slice(0,8)){
        const file=this.app.vault.getAbstractFileByPath(item.path),exists=file instanceof TFile;
        const r=button(list,'','aw-day-row',()=>this.openFile(item.path));r.disabled=!exists;
        r.title=exists?item.path:`${item.path}（已移除）`;
        icon(r,'file-text','aw-row-icon');
        el(r,'span','aw-day-name',exists?file.basename:item.name);
        el(r,'span','aw-day-count',`+${number(item.characters)} 字 · ${item.days} 天`);
      }
    }
    const folderBox=el(cols,'div','aw-week-col');
    el(folderBox,'h3','aw-week-heading','目录分布');
    if(!review.topFolders.length)el(folderBox,'p','aw-empty','暂无数据');
    else{
      const topChars=Math.max(1,...review.topFolders.map(f=>f.characters));
      const flist=el(folderBox,'div','aw-week-folders');
      for(const f of review.topFolders.slice(0,6)){
        const frow=el(flist,'div','aw-week-folder');
        const head=el(frow,'div','aw-week-folder-head');
        el(head,'span','aw-week-folder-name',f.folder);
        el(head,'span','aw-week-folder-val',`+${number(f.characters)} 字 · ${f.noteCount} 篇`);
        const fbar=el(frow,'div','aw-progress');
        el(fbar,'i').style.setProperty('--aw-progress',String(f.characters/topChars));
      }
    }
  }
  async copyWeekly(offset=0){
    if(typeof this.plugin.copyWeeklySummary==='function')return this.plugin.copyWeeklySummary(offset);
    const review=Dash.weeklyReview(this.plugin.data,new Date(),offset);
    const md=Dash.formatWeeklyMarkdown(review);
    const clip=this.contentEl.ownerDocument?.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
    if(!clip?.writeText){new Notice('当前环境不支持剪贴板写入。');return false;}
    try{await clip.writeText(md);new Notice(`已复制写作周报（${review.startDate} 至 ${review.endDate}）。`);return true;}
    catch{new Notice('复制周报失败。');return false;}
  }
  async exportCSV(){
    const vault=this.app.vault,stamp=Core.dayKey().replace(/-/g,'');
    let path=`${NAME}-${stamp}.csv`;
    for(let i=2;vault.getAbstractFileByPath(path);i++)path=`${NAME}-${stamp}-${i}.csv`;
    try{await vault.create(path,csv(this.plugin.data));new Notice(`已导出到笔记库根目录：${path}`);}
    catch{new Notice('导出失败，请检查笔记库写入权限。');}
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
module.exports={WorkbenchView,VIEW,NAME,viewIcon,overview,modifiedLabel,csv,csvCell,months};

},
"features/folder-notes.js":(module,exports,__awRequire)=>{
'use strict';
const {Component, TFolder, TFile, Notice, Setting} = require('obsidian');

// One child component owns this feature's listeners and transient selection.
class FolderNotes extends Component {
  constructor(plugin) {
    super(); this.plugin=plugin; this.app=plugin.app;
    this.selectedPath=null; this.creating=false; this.stopped=false;
    this.documents=new Map(); this.nativeHooks=[];
  }
  onload() {
    this.attachDocument(this.app.workspace.containerEl?.ownerDocument);
    for(const type of ['file-explorer','markdown']) for(const leaf of this.app.workspace.getLeavesOfType(type))this.attachDocument(leaf.view.containerEl?.ownerDocument);
    this.hookNativeCommand();
    this.app.workspace.onLayoutReady(()=>{if(!this.stopped)this.hookNativeCommand();});
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.attachDocument(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>{
      const owner=this.documents.get(win.document);
      if(owner){this.removeChild(owner);this.documents.delete(win.document);}
    }));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      if(this.selectedPath===oldPath)this.selectedPath=file.path;
      else if(this.selectedPath?.startsWith(oldPath+'/'))this.selectedPath=file.path+this.selectedPath.slice(oldPath.length);
      this.plugin.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on('delete',file=>{
      if(this.selectedPath===file.path || this.selectedPath?.startsWith(file.path+'/')){
        this.selectedPath=null; this.plugin.scheduleRefresh();
      }
    }));
    this.plugin.addCommand({id:'new-folder-in-selected-folder',name:'在选中文件夹中新建文件夹',checkCallback:checking=>{
      if(!this.getFolder())return false;
      if(!checking)void this.createFolder();
      return true;
    }});
    this.plugin.addCommand({id:'new-note-in-selected-folder',name:'在选中文件夹中新建笔记',checkCallback:checking=>{
      if(!this.getFolder())return false;
      if(!checking)void this.createNote();
      return true;
    }});
  }
  attachDocument(doc) {
    if(!doc || this.documents.has(doc))return;
    const owner=this.addChild(new Component()); this.documents.set(doc,owner);
    owner.registerDomEvent(doc,'click',event=>this.handleClick(event),true);

  }
  getFolder() {
    if(this.stopped || !this.plugin.data.settings.folderNotes || this.selectedPath===null)return null;
    const file=this.app.vault.getAbstractFileByPath(this.selectedPath);
    return file instanceof TFolder ? file : null;
  }
  handleClick(event) {
    if(this.stopped || !this.plugin.data.settings.folderNotes || event.button!==0 || event.defaultPrevented)return;
    const target=event.target?.closest ? event.target : event.target?.parentElement;
    if(!target?.closest('.workspace-leaf-content[data-type="file-explorer"]'))return;
    const action=target.closest('.nav-header .nav-action-button');
    if(action && this.getFolder()){
      // Match icons, not translated labels or button positions. Only the file
      // explorer header is eligible; explicit right-click destinations are untouched.
      const kind=action.querySelector?.('.lucide-folder-plus') ? 'folder'
        : action.querySelector?.('.lucide-edit, .lucide-file-plus, .lucide-pen-line, .lucide-square-pen') ? 'note' : null;
      if(kind){
        event.preventDefault(); event.stopImmediatePropagation();
        void this.createItem(kind); return;
      }
    }
    const row=target.closest('.nav-folder-title[data-path], .nav-file-title[data-path]');
    if(!row)return;
    const file=this.app.vault.getAbstractFileByPath(row.getAttribute('data-path'));
    const folder=file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
    if(folder instanceof TFolder){this.selectedPath=folder.path;this.plugin.scheduleRefresh();}
  }
  hookNativeCommand() {
    // Narrow compatibility hooks for native commands with no public destination API.
    for(const [id,kind] of [['file-explorer:new-file','note'],['file-explorer:new-folder','folder']]){
      const command=this.app.commands?.commands?.[id];
      if(typeof command?.callback!=='function' || this.nativeHooks.some(h=>h.command===command))continue;
      const original=command.callback, feature=this;
      const wrapped=function(...args){
        if(feature.getFolder()){
          if(args[0]?.repeat)return;
          return feature.createItem(kind);
        }
        return original.apply(this,args);
      };
      command.callback=wrapped; this.nativeHooks.push({command,original,wrapped});
    }
  }
  createNote(){return this.createItem('note');}
  createFolder(){return this.createItem('folder');}
  async createItem(kind) {
    const folder=this.getFolder();
    if(!folder || this.creating)return;
    this.creating=true;
    const isFolder=kind==='folder', label=isFolder?'文件夹':'笔记';
    try {
      let created=null;
      for(let i=0;i<10000;i++) {
        if(this.stopped)return;
        if(this.app.vault.getAbstractFileByPath(folder.path)!==folder){new Notice('目标文件夹已不存在，请重新选择。');return;}
        const base=isFolder?'未命名文件夹':'未命名';
        const name=i===0?base:`${base} ${i}`;
        const path=(folder.path==='/'?'':folder.path+'/')+name+(isFolder?'':'.md');
        if(this.app.vault.getAbstractFileByPath(path))continue;
        try {created=isFolder?await this.app.vault.createFolder(path):await this.app.vault.create(path,'');break;}
        catch(error) {if(!this.app.vault.getAbstractFileByPath(path))throw error;}
      }
      if(!created)throw Error('没有可用的名称');
      if(this.stopped)return;
      if(isFolder){
        const explorer=this.app.workspace.getLeavesOfType('file-explorer')[0];
        if(explorer){
          // Same file-explorer state used by the native new-folder action:
          // reveal the new folder and enter inline rename without opening a note.
          await explorer.setViewState({type:'file-explorer',state:{newFile:created.path},active:true});
          if(!this.stopped)await this.app.workspace.revealLeaf(explorer);
        }
        this.plugin.scheduleRefresh();
      // As Obsidian's own new note: focused, in the editor, with the title selected for renaming.
      }else await this.app.workspace.getLeaf('tab').openFile(created,{active:true,state:{mode:'source'},eState:{rename:'all'}});
    } catch(error) {new Notice(`新建${label}失败，请检查目标目录或写入权限。`);console.error('Workbench folder creation:',error);}
    finally {this.creating=false;}
  }
  displaySettings(container) {
    new Setting(container).setName('跟随选中文件夹新建')
      .setDesc('左键选择目录后，⌘N 及文件列表顶部的新建笔记、新建文件夹按钮均在其中创建；点击文件时跟随其父目录。未选择目录时保留原行为。')
      .addToggle(toggle=>toggle.setValue(this.plugin.data.settings.folderNotes).onChange(value=>{
        this.plugin.data.settings.folderNotes=value;this.selectedPath=null;this.plugin.changed();
      }));
  }
  onunload(){
    this.stopped=true; this.selectedPath=null; this.documents.clear();
    for(const hook of this.nativeHooks)if(hook.command.callback===hook.wrapped)hook.command.callback=hook.original;
    this.nativeHooks=[];
  }
}
module.exports={FolderNotes};

},
"features/figures.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,Modal,FuzzySuggestModal,Setting,Notice,TFile}=require('obsidian');
const {imageReference,figureMarkdown,spacedFigure}=__awRequire("features/figure-format.js");
const IMAGE=/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;
class ImagePicker extends FuzzySuggestModal {
  constructor(feature,choose){
    super(feature.app);this.feature=feature;this.choose=choose;
    this.files=this.app.vault.getFiles().filter(f=>IMAGE.test(f.path));
    this.setPlaceholder('搜索笔记库中的图片');feature.modals.add(this);
  }
  getItems(){return this.files;}
  getItemText(file){return file.path;}
  onChooseItem(file){this.choose(file);}
  onClose(){super.onClose();this.feature.modals.delete(this);this.files=[];}
}
class FigureModal extends Modal {
  constructor(feature,editor,ctx){
    super(feature.app);this.feature=feature;this.editor=editor;this.ctx=ctx;this.source=ctx.file;
    this.snapshot=editor.getValue();this.from=editor.getCursor('from');this.to=editor.getCursor('to');
    const selected=editor.getSelection().trim().split(/\r?\n/).filter(line=>line.trim()).map(imageReference);
    const multi=selected.length>1&&selected.every(Boolean);
    this.sources=multi?selected.map(reference=>({reference})):[{reference:imageReference(editor.getSelection())}];
    this.layout=multi?'grid-2':'single';this.width='640';this.align='center';this.caption='';
    this.closed=false;this.busy=false;feature.modals.add(this);
  }
  onOpen(){
    this.setTitle('插入排版图片');this.contentEl.addClass('aw-figure-modal');
    new Setting(this.contentEl).setName('布局').addDropdown(d=>{
      this.layoutDropdown=d;
      d.addOptions({single:'单张图片','grid-1':'多图 · 1 列','grid-2':'多图 · 2 列','grid-3':'多图 · 3 列','grid-4':'多图 · 4 列','mosaic-left':'多图 · 大图在左（一大多小）','mosaic-right':'多图 · 大图在右（一大多小）'}).setValue(this.layout).onChange(value=>{
        if(this.busy){d.setValue(this.layout);return;}
        if(value==='single'&&this.sources.length>1){new Notice('请先移除多余图片，或选择多图布局。');d.setValue(this.layout);return;}
        this.layout=value;this.updateLayout();
      });
    });
    new Setting(this.contentEl).setName('添加图片').addButton(b=>b.setButtonText('从笔记库添加').onClick(()=>{
      if(this.busy)return;
      new ImagePicker(this.feature,file=>{if(!this.closed&&!this.busy)this.addSources([{existing:file}]);}).open();
    }));
    const upload=this.contentEl.createEl('input',{type:'file'});
    upload.multiple=true;upload.accept='.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.avif';upload.setAttribute('aria-label','从电脑添加图片，可多选');
    upload.addEventListener('change',()=>{
      if(this.busy)return;
      const files=Array.from(upload.files||[]);
      if(files.some(file=>!IMAGE.test(file.name))){new Notice('请选择支持的图片文件。');return;}
      this.addSources(files.map(local=>({local})));upload.value='';
    });
    this.sourceList=this.contentEl.createDiv({cls:'aw-figure-list'});this.renderSources();
    new Setting(this.contentEl).setName('图注').addText(t=>t.setPlaceholder('图 1 · 训练损失曲线').onChange(v=>this.caption=v));
    this.widthSetting=new Setting(this.contentEl).setName('宽度（px）').addText(t=>t.setPlaceholder('原图').setValue(this.width).onChange(v=>this.width=v));
    this.alignSetting=new Setting(this.contentEl).setName('对齐').addDropdown(d=>d.addOptions({left:'左对齐',center:'居中',right:'右对齐'}).setValue(this.align).onChange(v=>this.align=v));
    this.updateLayout();
    new Setting(this.contentEl).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>{
      this.insertButton=b;b.setButtonText('插入').setCta().onClick(()=>this.insert());
    });
  }
  addSources(sources){
    if(this.closed||this.busy||!sources.length)return;
    this.sources=this.sources.filter(s=>s.reference||s.existing||s.local).concat(sources);
    if(this.sources.length>1&&this.layout==='single')this.layout='grid-2';
    this.layoutDropdown?.setValue(this.layout);this.renderSources();this.updateLayout();
  }
  moveSource(index,offset){
    const target=index+offset;
    if(this.closed||this.busy||index<0||target<0||index>=this.sources.length||target>=this.sources.length)return;
    [this.sources[index],this.sources[target]]=[this.sources[target],this.sources[index]];
    this.renderSources();
  }
  removeSource(index){
    if(this.closed||this.busy||index<0||index>=this.sources.length)return;
    this.sources.splice(index,1);
    if(this.sources.length<=1)this.layout='single';
    this.layoutDropdown?.setValue(this.layout);this.renderSources();this.updateLayout();
  }
  renderSources(){
    if(!this.sourceList)return;
    this.sourceList.empty();
    this.sources.forEach((source,index)=>{
      const label=source.existing?.path||source.local?.name||source.reference||'尚未选择图片';
      new Setting(this.sourceList).setName(`图片 ${index+1}`).setDesc(label)
        .addButton(b=>b.setButtonText('上移').setDisabled(index===0).onClick(()=>this.moveSource(index,-1)))
        .addButton(b=>b.setButtonText('下移').setDisabled(index===this.sources.length-1).onClick(()=>this.moveSource(index,1)))
        .addButton(b=>b.setButtonText('移除').onClick(()=>this.removeSource(index)));
    });
  }
  updateLayout(){
    const grid=this.layout!=='single';
    if(this.widthSetting)this.widthSetting.settingEl.hidden=grid;
    if(this.alignSetting)this.alignSetting.settingEl.hidden=grid;
  }
  unchanged(){return !this.closed && !this.feature.stopped && this.ctx.file===this.source && this.editor.getValue()===this.snapshot;}
  async insert(){
    if(this.busy || this.closed)return;
    let imported=0;
    try {
      const mode=this.layout==='single'?this.align:this.layout;
      const sources=this.sources.slice();
      // Validate all slots before importing; insert the complete group atomically.
      if(!sources.length||sources.some(source=>!source.reference&&!source.existing&&!source.local))throw Error('请为每个位置选择图片，或移除空位置。');
      figureMarkdown(sources.map(()=> '![[validation.png]]'),this.caption,this.width,mode);
      if(!this.unchanged())throw Error('原笔记已变化，请关闭窗口并重新插入，避免覆盖内容。');
      this.busy=true;this.insertButton.setDisabled(true);
      const references=[];
      for(const source of sources){
        if(source.local){
          const bytes=await source.local.arrayBuffer();
          if(!this.unchanged())throw Error('原笔记已变化或插入已取消。');
          const path=await this.app.fileManager.getAvailablePathForAttachment(source.local.name,this.source.path);
          if(!this.unchanged())throw Error('原笔记已变化或插入已取消。');
          source.existing=await this.app.vault.createBinary(path,bytes);
          source.local=null;imported++;
        }
        if(!this.unchanged())throw Error('原笔记已变化或插入已取消。');
        let reference=source.reference;
        if(source.existing){
          if(this.app.vault.getAbstractFileByPath(source.existing.path)!==source.existing)throw Error('图片已被移除，请重新选择。');
          reference='!'+this.app.fileManager.generateMarkdownLink(source.existing,this.source.path);
        }
        references.push(reference);
      }
      const markdown=figureMarkdown(references,this.caption,this.width,mode);
      const before=this.editor.getRange({line:0,ch:0},this.from);
      const end={line:this.editor.lastLine(),ch:this.editor.getLine(this.editor.lastLine()).length};
      const after=this.editor.getRange(this.to,end);
      this.editor.replaceRange(spacedFigure(before,after,markdown),this.from,this.to);
      this.close();this.editor.focus();
    }catch(error){new Notice((error.message||'插图失败，请重试。')+(imported?' 已导入的图片保留在附件目录，可继续使用。':''));}
    finally{this.busy=false;if(!this.closed)this.insertButton.setDisabled(false);}
  }
  onClose(){
    this.closed=true;this.feature.modals.delete(this);this.contentEl.empty();
    this.snapshot='';this.sources=[];this.sourceList=null;this.layoutDropdown=null;this.widthSetting=null;this.alignSetting=null;
  }
}
class Figures extends Component {
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.modals=new Set();this.stopped=false;}
  onload(){
    this.plugin.addCommand({id:'insert-figure',name:'插入排版图片',editorCheckCallback:(checking,editor,ctx)=>{
      if(!(ctx.file instanceof TFile)||ctx.file.extension!=='md')return false;
      if(!checking)new FigureModal(this,editor,ctx).open();return true;
    }});
  }
  onunload(){this.stopped=true;for(const modal of [...this.modals])modal.close();this.modals.clear();}
}
module.exports={Figures,FigureModal};

},
"features/figure-format.js":(module,exports,__awRequire)=>{
'use strict';
// The one list of figure layouts. Single images: left / center / right. Multi-image groups:
// grid-N (N columns) and mosaic-left/right (one large image beside a stack of the others).
const GROUP=/^(?:grid-[1-4]|mosaic-(?:left|right))$/;
const LAYOUT=/^(?:left|center|right|grid-[1-4]|mosaic-(?:left|right))$/;
// Which family a figure renders as. Matches the stylesheet's [data-callout-metadata^="grid-"]
// prefix test, so a hand-typed grid-5 still behaves as a group and can be switched to a valid one.
const isGroup=meta=>/^(?:grid|mosaic)-/.test(meta);
function imageReference(text) {
  const s=text.trim();
  if((s.match(/!\[/g)||[]).length!==1)return null;
  return /^!\[\[[^\r\n]+\]\]$/.test(s) || /^!\[[^\]\r\n]*\]\([^\r\n]+\)$/.test(s) ? s : null;
}
function figureMarkdown(reference, caption, width='640', align='center') {
  const references=Array.isArray(reference)?reference:[reference];
  const grid=GROUP.test(align);
  if(grid ? references.length<2 : references.length!==1)throw Error(grid?'多图布局至少需要两张图片。':'多张图片请选择多图布局。');
  const images=references.map(imageReference);
  if(images.some(image=>!image))throw Error('请为每个位置选择一张图片。');
  const size=grid?'':String(width).trim();
  if(size && (!/^\d+$/.test(size) || Number(size)<1 || Number(size)>4096))throw Error('宽度请输入 1–4096 的整数，留空使用原图宽度。');
  if(!grid&&!['left','center','right'].includes(align))throw Error('不支持的对齐方式。');
  const title=String(caption).replace(/[\r\n]+/g,' ').trim();
  if(!title)throw Error('请填写图注，例如「图 1 · 训练损失曲线」。');
  const embeds=images.map(image=>{
  let embed;
  if(image.startsWith('![[')) {
    const target=image.slice(3,-2).split('|')[0];
    embed=`![[${target}${size?'|'+Number(size):''}]]`;
  } else {
    embed=image.replace(/^!\[([^\]]*)\]/,(_m,alt)=>`![${alt.replace(/\|\d+(?:x\d+)?$/,'')}${size?'|'+Number(size):''}]`);
  }
  return embed;
  });
  return `> [!figure|${align}] ${title}\n${embeds.map(embed=>'> '+embed).join('\n')}`;
}
function spacedFigure(before,after,figure) {
  return (before && !before.endsWith('\n\n') ? before.endsWith('\n')?'\n':'\n\n' : '')
    +figure+(after ? after.startsWith('\n\n')?'':after.startsWith('\n')?'\n':'\n\n' : '\n');
}
module.exports={imageReference,figureMarkdown,spacedFigure,GROUP,LAYOUT,isGroup};

},
"features/screenshot-names.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,TFile,Setting,Notice}=require('obsidian');
function screenshotStem(noteName,date=new Date()) {
  const cleaned=String(noteName).normalize('NFC').replace(/[<>:"/\\|?*\[\]#^\x00-\x1f]/g,'-').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'');
  // 32 code points keeps the UTF-8 filename comfortably below filesystem limits.
  const title=Array.from(cleaned||'笔记').slice(0,32).join('');
  const pad=(n,size=2)=>String(n).padStart(size,'0');
  return `${title}-截图-${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(),3)}`;
}
function isDefaultScreenshot(name,extension) {
  return /^Pasted image(?:[\s_-]*\d[\d\s_.-]*)?$/i.test(name) && /^(png|jpe?g|webp)$/i.test(extension);
}
class ScreenshotNames extends Component {
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.stopped=false;this.lastStem='';this.sequence=0;}
  onload(){
    const vault=this.app.vault, original=vault.getAvailablePathForAttachments;
    // Native paste calls this resolver directly, before writing the image/link.
    // Only the default screenshot basename is replaced; the native destination,
    // collision resolution, clipboard handling and editor insertion stay intact.
    if(typeof original!=='function')return;
    const feature=this;
    this.original=original;
    this.wrapped=function(name,extension,source,...rest){
      let stem=name;
      const note=source || feature.app.workspace.getActiveFile();
      if(!feature.stopped && feature.plugin.data.settings.nameScreenshots && note instanceof TFile && note.extension==='md' && isDefaultScreenshot(name,extension)){
        stem=screenshotStem(note.basename);
        if(stem===feature.lastStem)feature.sequence++;else {feature.lastStem=stem;feature.sequence=0;}
        if(feature.sequence)stem+=`-${feature.sequence}`;
      }
      return original.call(this,stem,extension,source,...rest);
    };
    vault.getAvailablePathForAttachments=this.wrapped;
  }
  displaySettings(container){
    new Setting(container).setName('截图按笔记命名').setDesc('新粘贴的默认截图命名为“笔记名-截图-日期-时间”；保存目录沿用附件设置。已有图片和自定义名称不变。')
      .addToggle(t=>t.setValue(this.plugin.data.settings.nameScreenshots).onChange(value=>{
        this.plugin.data.settings.nameScreenshots=value;this.plugin.changed();
        if(value&&!this.wrapped)new Notice('当前 Obsidian 版本的截图命名接口不兼容，暂保留默认名称。');
      }));
  }
  onunload(){
    this.stopped=true;
    if(this.wrapped && this.app.vault.getAvailablePathForAttachments===this.wrapped)this.app.vault.getAvailablePathForAttachments=this.original;
    this.original=null;this.wrapped=null;this.lastStem='';
  }
}
module.exports={ScreenshotNames,screenshotStem,isDefaultScreenshot};

},
"features/figure-tools.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,Notice,Setting,TFile,setIcon}=require('obsidian');
const Edit=__awRequire("features/figure-edit.js");
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

},
"features/figure-edit.js":(module,exports,__awRequire)=>{
'use strict';
// Line-level edits of a figure callout. Every function takes the note's lines and
// returns new lines; nothing here touches the DOM or the vault.
const {LAYOUT,isGroup}=__awRequire("features/figure-format.js");
const HEADER=/^(\s*>\s*)\[!(figure|table)(?:\|([^\]]*))?\]([+-]?)(.*)$/i;
const QUOTED=/^\s*>/;
const IMAGE=/!\[\[([^\]|]+)(?:\|(\d+)(?:x\d+)?)?\]\]|!\[([^\]|]*)(?:\|(\d+)(?:x\d+)?)?\]\(([^)]+)\)/g;

function imagesIn(text) {
  return [...text.matchAll(IMAGE)].map(m=>({text:m[0],index:m.index,width:Number(m[2]||m[4])||null}));
}
// Walk up to the callout header and down to its last quoted line.
function findBlock(lines, line) {
  if(line<0||line>=lines.length||!QUOTED.test(lines[line]))return null;
  let start=line;
  while(start>0&&!HEADER.test(lines[start])&&QUOTED.test(lines[start-1]))start--;
  const header=HEADER.exec(lines[start]);
  if(!header||header[2].toLowerCase()!=='figure')return null;
  let end=start;
  while(end+1<lines.length&&QUOTED.test(lines[end+1])&&!HEADER.test(lines[end+1]))end++;
  // Every image, in the order they render: its line and its place on that line.
  const images=[];
  for(let i=start+1;i<=end;i++)imagesIn(lines[i]).forEach((found,at)=>images.push({line:i,at,width:found.width}));
  return {start,end,prefix:header[1],meta:(header[3]||'').trim(),fold:header[4],caption:header[5],images};
}
function replaceWidth(embed, width) {
  const size=width?'|'+width:'';
  if(embed.startsWith('![['))return embed.replace(/^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/,(_m,target)=>`![[${target}${size}]]`);
  return embed.replace(/^!\[([^\]|]*)(?:\|[^\]]*)?\]/,(_m,alt)=>`![${alt}${size}]`);
}
function setWidth(lines, block, imageIndex, width) {
  const image=block.images[imageIndex];
  if(!image)throw Error('找不到这张图片。');
  if(width!==null&&(!Number.isInteger(width)||width<1||width>4096))throw Error('宽度需为 1–4096 的整数。');
  const next=lines.slice();
  next[image.line]=replaceImage(lines[image.line],image.at,found=>replaceWidth(found.text,width));
  return next;
}
// The line with its at-th image rewritten.
function replaceImage(text,at,rewrite){
  const found=imagesIn(text)[at];
  if(!found)throw Error('找不到这张图片。');
  return text.slice(0,found.index)+rewrite(found)+text.slice(found.index+found.text.length);
}
function setMeta(lines, block, meta) {
  if(!LAYOUT.test(meta))throw Error('不支持的布局。');
  const grid=isGroup(meta),wasGrid=isGroup(block.meta);
  if(grid!==wasGrid)throw Error(grid?'单图不能切换为多图布局。':'多图组只能切换多图布局。');
  const next=lines.slice();
  next[block.start]=`${block.prefix}[!figure|${meta}]${block.fold}${block.caption}`;
  return next;
}
// Reorder images; captions, blank quoted lines and other content stay put. With one image per
// line the image lines move; when images share a line, the embeds trade places instead.
function moveImage(lines, block, from, to) {
  const images=block.images;
  const valid=i=>Number.isInteger(i)&&i>=0&&i<images.length;
  if(!valid(from)||!valid(to))throw Error('找不到要移动的图片。');
  const shared=new Set(images.map(image=>image.line)).size<images.length;
  const order=images.map(image=>shared?imagesIn(lines[image.line])[image.at].text:lines[image.line]);
  const [moved]=order.splice(from,1);order.splice(to,0,moved);
  const next=lines.slice();
  // From the last image back, so the positions of earlier images on a line stay valid.
  for(let i=images.length-1;i>=0;i--){
    const {line,at}=images[i];
    next[line]=shared?replaceImage(next[line],at,()=>order[i]):order[i];
  }
  return next;
}
// "图 1"、"表 2-3"、"Figure 4"、"Fig. 5"、"Table 6": the label part of a caption.
const LABEL=/^\s*((?:图|表|Fig\.?|Figure|Table)\s*\d+(?:[.\-–]\d+)*)/i;
function captionLabel(text) {
  const m=LABEL.exec(text);
  return m?{label:m[1],rest:text.slice(m[0].length)}:null;
}
module.exports={findBlock,setWidth,setMeta,moveImage,captionLabel,imagesIn,isGroup};

},
"features/annotations.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,MarkdownView,Modal,Notice,Setting,TFile,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
let syntaxTree=null;
try{({syntaxTree}=require('@codemirror/language'));}catch{}
const Format=__awRequire("features/annotation-format.js");
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

},
"features/annotation-format.js":(module,exports,__awRequire)=>{
'use strict';
// Handwritten annotations: ==target=={note} or ==target=={note|options}. The braces sit right
// after the closing == with no space, on one line. The note is up to 80 characters; options
// after the last "|" set where the note sits, its colour and its line:
//   position  右下 (default) 下 左下 右 左 右上 上 左上, or the arrows ↘ ↓ ↙ → ← ↗ ↑ ↖
//   colour    蓝 (default) 中性 琥珀 橙 绿 红 紫 彩虹, or #rgb / #rrggbb
//   line      双线 (default) 虚线 实线 波浪 螺旋
//   无高亮     the target keeps no tinted background
// Text after a "|" that isn't all options belongs to the note. Nothing here touches the DOM.
const MAX_NOTE=80;
const DIRECTIONS=[
  {id:'nw',arrow:'↖',label:'左上'},{id:'n',arrow:'↑',label:'上'},{id:'ne',arrow:'↗',label:'右上'},
  {id:'w',arrow:'←',label:'左'},{id:'e',arrow:'→',label:'右'},
  {id:'sw',arrow:'↙',label:'左下'},{id:'s',arrow:'↓',label:'下'},{id:'se',arrow:'↘',label:'右下'},
];
const COLORS=[
  {id:'neutral',label:'中性'},{id:'amber',label:'琥珀'},{id:'orange',label:'橙'},
  {id:'blue',label:'蓝'},{id:'green',label:'绿'},{id:'red',label:'红'},
  {id:'purple',label:'紫'},{id:'rainbow',label:'彩虹'},
];
const LINES=[
  {id:'double',label:'双线'},{id:'dashed',label:'虚线'},{id:'solid',label:'实线'},
  {id:'wavy',label:'波浪'},{id:'spiral',label:'螺旋'},
];
const DEFAULTS={dir:'se',color:'blue',custom:null,line:'double',highlight:true};
const SPEC_KEYS=['note','dir','color','custom','line','highlight'];
const sameSpec=(a,b)=>Boolean(a&&b)&&SPEC_KEYS.every(k=>a[k]===b[k]);
const HEX=/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NO_HIGHLIGHT=['无高亮','不高亮'];

// One option word, or null when the word isn't an option.
function option(word){
  const dir=DIRECTIONS.find(d=>d.arrow===word||d.label===word);
  if(dir)return {dir:dir.id};
  const color=COLORS.find(c=>c.label===word||c.label+'色'===word);
  if(color)return {color:color.id,custom:null};
  if(HEX.test(word))return {color:'custom',custom:word.toLowerCase()};
  const line=LINES.find(l=>l.label===word);
  if(line)return {line:line.id};
  if(NO_HIGHLIGHT.includes(word))return {highlight:false};
  return null;
}
// "note|options" (the text inside the braces) to a full annotation, or null.
function parseBody(body){
  let note=body,spec={...DEFAULTS};
  const bar=body.lastIndexOf('|');
  if(bar>=0){
    const words=body.slice(bar+1).trim().split(/\s+/).filter(Boolean);
    const options=words.map(option);
    if(words.length&&options.every(Boolean)){note=body.slice(0,bar);for(const o of options)Object.assign(spec,o);}
  }
  note=note.trim();
  if(!note||note.length>MAX_NOTE)return null;
  return {...spec,note};
}
// Braces, with up to 80 characters of note and room for a few options.
const BODY='[^{}\\n]{1,120}';
const NOTE=new RegExp(`^\\{(${BODY})\\}`);
const SOURCE=new RegExp(`==([^=\\n]+)==\\{(${BODY})\\}`,'g');

// Reading view: the text that follows a rendered <mark>.
function parseAnnotation(text) {
  const m=NOTE.exec(text||'');
  const spec=m&&parseBody(m[1]);
  return spec?{...spec,rest:text.slice(m[0].length)}:null;
}
// Live Preview: offsets of every annotation in a stretch of source text. markFrom is the opening
// ==, targetFrom..targetTo the highlighted words, from..to the braces.
function findAnnotations(text, offset=0) {
  const found=[];
  for(const m of text.matchAll(SOURCE)){
    const spec=parseBody(m[2]);
    if(!spec)continue;
    const markFrom=offset+m.index,targetFrom=markFrom+2,targetTo=targetFrom+m[1].length;
    found.push({...spec,markFrom,targetFrom,targetTo,from:targetTo+2,to:markFrom+m[0].length});
  }
  return found;
}
// The braces for an annotation; defaults are left out, so a plain note stays {note}.
function formatAnnotation(spec){
  const s={...DEFAULTS,...spec},note=String(s.note||'').replace(/[{}\r\n]+/g,' ').trim().slice(0,MAX_NOTE);
  if(!note)throw Error('请填写标注内容。');
  const words=[];
  if(s.dir!==DEFAULTS.dir)words.push(DIRECTIONS.find(d=>d.id===s.dir)?.label??DIRECTIONS.find(d=>d.id===DEFAULTS.dir).label);
  if(s.color==='custom'&&HEX.test(s.custom||''))words.push(s.custom.toLowerCase());
  else if(s.color!==DEFAULTS.color&&COLORS.some(c=>c.id===s.color))words.push(COLORS.find(c=>c.id===s.color).label);
  if(s.line!==DEFAULTS.line&&LINES.some(l=>l.id===s.line))words.push(LINES.find(l=>l.id===s.line).label);
  if(s.highlight===false)words.push(NO_HIGHLIGHT[0]);
  // A note that itself ends in "|option" would be misread; spell out the default position then.
  if(!words.length&&note.includes('|')&&parseBody(note)?.note!==note)words.push(DIRECTIONS.find(d=>d.id===DEFAULTS.dir).label);
  return `{${note}${words.length?'|'+words.join(' '):''}}`;
}
// Where the note goes relative to its target: pinned outside the line (the eight positions),
// or in the text flow after / before the target (右, 左).
function placement(spec){
  if(spec.dir==='e')return 'after';
  if(spec.dir==='w')return 'before';
  return 'pin';
}
// Classes for the highlighted target. A pinned note is laid out against the target's box.
// A pinned note hangs off its target's box, so a short target is kept on one line (it wraps
// to the next line as a whole): split over two lines, its box would span both and the note
// would drift. Targets longer than KEEP characters may still wrap, so they never overflow.
const KEEP=24;
function targetClasses(spec,target){
  const pin=placement(spec)==='pin',keep=pin&&target!=null&&[...String(target)].length<=KEEP;
  return ['aw-annot-target','aw-annot-c-'+spec.color].concat(spec.highlight?[]:['aw-annot-plain'],pin?['aw-annot-holds']:[],keep?['aw-annot-keep']:[]);
}
// Visual width in the note's own em; pinned notes wrap at 13.5em and reserve room per line.
function noteLines(note){
  let em=0;
  for(const ch of String(note||''))em+=ch.codePointAt(0)>0x2e7f?1:0.56;
  return Math.min(6,Math.max(1,Math.ceil(em/13)));
}
const LEADER_PATHS={
  double:['M3.8 4.7 Q17.5 6.7 31.5 4.5','M4.2 7.3 Q17.8 9.3 31.5 7.2'],
  dashed:['M3.4 5.9 Q17.5 8.1 31.5 5.8'],
  solid:['M3.4 5.9 Q17.5 8.1 31.5 5.8'],
  wavy:['M3.6 6 C7.2 2.9,10.6 9.1,14.2 6 C17.8 2.9,21.2 9.1,24.8 6 C27.4 3.8,29.6 7.5,31.5 6'],
  spiral:['M3.5 6 C9.5 6.8,16.5 8.8,19.2 6.8 C21.4 5.1,20.4 1.6,17.2 1.6 C14 1.6,13.2 5.4,15.8 7.5 C19.2 10.1,26.2 7.4,31.5 5.9'],
};
// The note as a plain tree ({tag, cls, attrs, text, children, svg}); the plugin turns it into
// DOM and the preview script into HTML, so both draw the same thing.
function noteTree(spec){
  const where=placement(spec),lines=where==='pin'?noteLines(spec.note):1;
  const strokes=LEADER_PATHS[spec.line]||LEADER_PATHS.double;
  const leader={tag:'svg',svg:true,attrs:{class:'aw-annot-arrow',viewBox:'0 0 32 12','aria-hidden':'true'},children:[
    {tag:'path',svg:true,attrs:{d:'M8.6 2.3 Q5.3 4.2 2.3 5.8 Q5.2 7.7 8.2 10',class:'aw-annot-head'}},
    ...strokes.map(d=>({tag:'path',svg:true,attrs:{d,class:'aw-annot-line'}})),
  ]};
  const text={tag:'span',cls:'aw-annot-text',text:spec.note};
  let children;
  if(where==='pin')children=[{tag:'span',cls:'aw-annot-room',attrs:{'aria-hidden':'true'}},{tag:'span',cls:'aw-annot-pin',children:[leader,text]}];
  else children=where==='before'?[text,leader]:[leader,text];
  const cls=['aw-annot','aw-annot-'+spec.dir,'aw-annot-'+spec.line,'aw-annot-c-'+spec.color,where==='pin'?'aw-annot-pinned':'aw-annot-flow'];
  if(lines>1)cls.push('aw-annot-l'+lines);
  // A pinned note starts with a word joiner (U+2060): no line break between the target's last
  // character and the note's room block, so the room stays on the target's line.
  return {tag:'span',text:where==='pin'?'\u2060':null,cls:cls.join(' '),
    attrs:{title:'标注：'+spec.note},color:spec.color==='custom'?spec.custom:null,children};
}
// Replace inline code, inline math and comments with equal-length spaces so character offsets stay exact.
function maskVerbatimInLine(line){
  return line.replace(/(`+)[^`]*?\1|\$\$[^$]+?\$\$|\$(?!\s)[^$\n]+?(?<!\s)\$|%%.*?%%|<!--.*?-->/g,m=>' '.repeat(m.length));
}
// Scan a Markdown document (or section), skipping YAML front matter, fenced code and $$ math blocks.
function collectNoteAnnotations(markdown,{allowFrontMatter=true}={}){
  const lines=String(markdown||'').split(/\r?\n/),out=[];
  let i=0,fence=null,mathBlock=false;
  if(allowFrontMatter&&lines[0]?.trim()==='---'){
    let end=1;while(end<lines.length&&!/^(?:---|\.\.\.)\s*$/.test(lines[end]))end++;
    if(end<lines.length)i=end+1;
  }
  for(;i<lines.length;i++){
    const raw=lines[i];
    if(fence){
      if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(raw))fence=null;
      continue;
    }
    const open=/^\s*(`{3,}|~{3,})/.exec(raw);
    if(open){fence=open[1];continue;}
    if(/^\s*\$\$\s*$/.test(raw)){mathBlock=!mathBlock;continue;}
    if(mathBlock)continue;
    for(const a of findAnnotations(maskVerbatimInLine(raw),0)){
      out.push({...a,lineIndex:i,target:raw.slice(a.targetFrom,a.targetTo)});
    }
  }
  return out;
}
// Rewrite or remove one annotation inside a Markdown section after verifying target and spec match.
function replaceSectionAnnotation(sectionText,target,oldSpec,ordinal,replacement){
  const eol=sectionText.includes('\r\n')?'\r\n':'\n',lines=sectionText.split(eol);
  const hits=collectNoteAnnotations(lines.join('\n'),{allowFrontMatter:false})
    .filter(a=>a.target===target&&sameSpec(a,oldSpec));
  const hit=hits[ordinal]??(hits.length===1?hits[0]:null);
  if(!hit)throw Error('笔记内容已变化，请稍后重试。');
  const line=lines[hit.lineIndex];
  lines[hit.lineIndex]=line.slice(0,hit.from)+replacement+line.slice(hit.to);
  return lines.join(eol);
}
// Markdown list of all annotations in a note for copying or review.
function formatAnnotationSummary(title,items){
  const heading=`## 标注汇总：${String(title||'当前笔记').trim()||'当前笔记'}`;
  if(!items?.length)return `${heading}\n\n（暂无标注）`;
  const rows=items.map((a,idx)=>{
    const dir=DIRECTIONS.find(d=>d.id===a.dir)?.label||DIRECTIONS[7].label;
    return `${idx+1}. **${a.target}**（${dir}）：${a.note} *(第 ${a.lineIndex+1} 行)*`;
  });
  return `${heading}\n\n${rows.join('\n')}`;
}
module.exports={parseAnnotation,findAnnotations,formatAnnotation,parseBody,placement,targetClasses,noteLines,noteTree,collectNoteAnnotations,replaceSectionAnnotation,formatAnnotationSummary,sameSpec,DIRECTIONS,COLORS,LINES,DEFAULTS,MAX_NOTE,KEEP};

},
"features/scroll-ruler.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,MarkdownView}=require('obsidian');

// Reading progress as a fraction, or null when the note does not scroll.
function progressOf(top,height,client){
  const range=height-client;
  return range>4?Math.min(1,Math.max(0,top/range)):null;
}
function topFor(fraction,height,client){return Math.round(Math.min(1,Math.max(0,fraction))*Math.max(0,height-client));}
const clamp01=x=>Math.min(1,Math.max(0,x));

// Strips inline Markdown, wiki/Markdown links, comments and attached annotation braces so
// ruler labels match what Reading view renders, while preserving text inside inline code.
function cleanHeading(raw){
  const codes=[];
  let text=String(raw||'').replace(/%%[\s\S]*?%%/g,'')
    .replace(/(`+)([^`]+?)\1/g,(_m,_ticks,code)=>`\u0000${codes.push(code)-1}\u0000`);
  // Annotations right after ==target==: both {标注|...} and {ann ...}.
  text=text.replace(/==([^=\n]+)==\{[^{}\n]{1,200}\}/g,'$1');
  text=text.replace(/!?\[\[([^\]]+)\]\]/g,(_m,inner)=>{
    const clean=inner.replace(/\\\|/g,'|'),bar=clean.lastIndexOf('|');
    return bar>=0?clean.slice(bar+1):clean;
  });
  for(let prev='';prev!==text;){
    prev=text;
    text=text.replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g,'$1');
  }
  text=text
    .replace(/\*\*\*([^*]+)\*\*\*/g,'$1')
    .replace(/\*\*([^*]+)\*\*/g,'$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g,'$1$2')
    .replace(/__([^_]+)__/g,'$1')
    .replace(/(^|[^\w])_([^_]+)_(?![\w])/g,'$1$2')
    .replace(/~~([^~]+)~~/g,'$1')
    .replace(/==([^=\n]+)==/g,'$1')
    .replace(/^#{1,6}\s+/,'')
    .replace(/\u0000(\d+)\u0000/g,(_m,i)=>codes[Number(i)]??'')
    .replace(/\s+/g,' ')
    .trim();
  return text;
}

// 2D Gaussian wave offset (px leftward) for ticks near the pointer or active drag position.
const WAVE_SIGMA=26,WAVE_AMP=7,WAVE_RADIUS=78;
function waveOffset(dy,sigma=WAVE_SIGMA,amp=WAVE_AMP){
  return Math.abs(dy)>sigma*3?0:amp*Math.exp(-(dy*dy)/(2*sigma*sigma));
}

// Semantic reading-position memory: re-anchors to the heading that was active when saved
// if content above it grew or shrank, falling back to the saved fraction.
function resolveResume(saved,headings=[],fractions=[]){
  if(!saved||!(saved.p>0&&saved.p<1))return null;
  let idx=-1;
  if(Number.isInteger(saved.line)&&saved.text)
    idx=headings.findIndex(h=>h.line===saved.line&&h.text===saved.text);
  if(idx<0&&saved.text){
    const hits=headings.map((h,i)=>h.text===saved.text?i:-1).filter(i=>i>=0);
    if(hits.length===1)idx=hits[0];
  }
  if(idx>=0&&Number.isFinite(fractions[idx]))
    return clamp01(Number.isFinite(saved.hp)?saved.p+(fractions[idx]-saved.hp):fractions[idx]);
  return clamp01(saved.p);
}
function makeMemory(progress,headings=[],fractions=[],current=-1,now=Date.now()){
  if(!Number.isFinite(progress)||progress<=0.03||progress>=0.98)return null;
  const rec={p:Math.round(progress*10000)/10000,at:now};
  if(current>=0&&headings[current]){
    rec.line=headings[current].line;rec.text=headings[current].text;
    if(Number.isFinite(fractions[current]))rec.hp=Math.round(fractions[current]*10000)/10000;
  }
  return rec;
}

// The heading being read: the last one whose tick is at or above the dot (-1 before the first).
function currentHeading(fractions,progress){
  let current=-1;
  fractions.forEach((f,i)=>{if(f<=progress+.002)current=i;});
  return current;
}
// Which headings fit beside the ruler. items are {index, level, top} (top in px down the ruler);
// labels need `gap` px between them. The heading being read always stays, then higher levels
// win a clash, then earlier headings. Returns the kept indexes in order.
function layoutHeadings(items,gap,current=-1){
  const rank=item=>[item.index===current?0:1,item.level,item.index];
  const order=[...items].sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];});
  const kept=[];
  for(const item of order)if(kept.every(k=>Math.abs(k.top-item.top)>=gap))kept.push(item);
  return kept.map(k=>k.index).sort((a,b)=>a-b);
}
const inside=(root,node)=>{for(let cur=node;cur;cur=cur.parentNode)if(cur===root)return true;return false;};
const reducedMotion=win=>!!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
const HEADING_LEVELS=3,HEADING_GAP=16,MIN_MARGIN=120,LIST_WIDTH=220,GLIDE_MS=160,MEMORY_DELAY=1200;

class ScrollRuler extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.entries=new Map();}
  onload(){
    for(const event of ['layout-change','active-leaf-change','file-open','resize'])this.registerEvent(this.app.workspace.on(event,()=>this.sync()));
    // Headings added, renamed or removed while typing.
    this.registerEvent(this.app.metadataCache.on('changed',file=>{for(const view of this.entries.keys())if(view.file===file)this.schedule(view);}));
    this.plugin.addCommand?.({
      id:'jump-reading-memory',
      name:'跳到上次阅读位置',
      checkCallback:checking=>{
        const view=this.app.workspace.getActiveViewOfType?.(MarkdownView),entry=view&&this.entries.get(view);
        if(!entry||!this.memoryEnabled()||entry.resumeFraction===null)return false;
        if(!checking)this.jumpTo(view,entry.resumeFraction,true);
        return true;
      }
    });
    this.app.workspace.onLayoutReady(()=>this.sync());
  }
  onunload(){for(const view of [...this.entries.keys()])this.detach(view);}
  enabled(){return this.plugin.data.settings.scrollRuler!==false;}
  showHeadings(){return this.plugin.data.settings.rulerHeadings!==false;}
  memoryEnabled(){return this.plugin.data.settings.rulerMemory!==false;}
  sync(){
    const views=this.enabled()?this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).filter(v=>v instanceof MarkdownView):[];
    for(const view of [...this.entries.keys()])if(!views.includes(view)||!view.contentEl?.isConnected)this.detach(view);
    for(const view of views){if(!this.entries.has(view))this.attach(view);this.update(view);}
  }
  attach(view){
    const host=view.contentEl,doc=host.ownerDocument,owner=this.addChild(new Component());
    const el=doc.createElement('div');el.className='aw-ruler';el.setAttribute('aria-hidden','true');
    const ticksBox=doc.createElement('div');ticksBox.className='aw-ruler-ticks';
    const heads=doc.createElement('div');heads.className='aw-ruler-heads';
    const panel=doc.createElement('div');panel.className='aw-ruler-panel';
    const resume=doc.createElement('div');resume.className='aw-ruler-resume';resume.hidden=true;resume.title='上次阅读位置（点击返回）';
    const knob=doc.createElement('div');knob.className='aw-ruler-knob';
    const label=doc.createElement('span');label.className='aw-ruler-label';
    knob.appendChild(label);
    el.appendChild(ticksBox);el.appendChild(heads);el.appendChild(panel);el.appendChild(resume);el.appendChild(knob);
    host.appendChild(el);host.classList.add('aw-has-ruler');
    // Frames come from the ruler's own window: a popout keeps updating while the main window
    // is minimised or covered (its frames would pause).
    const win=doc.defaultView||window;
    const entry={
      owner,el,ticksBox,ticks:[],heads,marks:[],panel,panelItems:[],resume,knob,label,
      frame:0,glideFrame:0,memoryTimer:0,pendingMemory:null,win,
      hoverY:null,dragging:false,endDrag:null,
      sectionSig:'',knownStarts:new Map(),
      filePath:undefined,savedMemory:null,resumeFraction:null
    };
    this.entries.set(view,entry);
    resume.addEventListener('pointerdown',event=>{
      if(event.button!==0||entry.resumeFraction===null)return;
      event.preventDefault();event.stopPropagation();
      this.jumpTo(view,entry.resumeFraction,true);
    });
    panel.addEventListener('pointerdown',event=>event.stopPropagation());
    // scroll does not bubble; capture it from whichever scroller the current mode uses.
    owner.registerDomEvent(host,'scroll',()=>this.schedule(view),{capture:true});
    owner.registerDomEvent(host,'wheel',event=>{if(!inside(el,event.target))this.stopGlide(entry);},{passive:true});
    owner.registerDomEvent(el,'pointerdown',event=>this.drag(view,event));
    owner.registerDomEvent(el,'pointermove',event=>{
      if(inside(panel,event.target)){if(entry.hoverY!==null){entry.hoverY=null;this.paintWave(entry);}return;}
      const rect=el.getBoundingClientRect();
      if(rect.height>0){entry.hoverY=event.clientY-rect.top;this.paintWave(entry);}
    });
    owner.registerDomEvent(el,'pointerleave',()=>{entry.hoverY=null;if(!entry.dragging)this.paintWave(entry);});
    // The ruler and its headings sit beside the scroller, not in it: pass the wheel on, except
    // when scrolling a dense outline panel that overflows its own box.
    owner.registerDomEvent(el,'wheel',event=>{
      if(inside(panel,event.target)&&panel.scrollHeight>panel.clientHeight)return;
      const s=this.scroller(view);if(!s)return;
      this.stopGlide(entry);
      event.preventDefault();s.scrollTop+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?s.clientHeight:1);
    },{passive:false});
  }
  detach(view){
    const entry=this.entries.get(view);if(!entry)return;
    entry.endDrag?.();
    this.stopGlide(entry);
    this.flushMemory(entry);
    entry.win.cancelAnimationFrame?.(entry.frame);
    entry.el.remove();view.contentEl?.classList.remove('aw-has-ruler');
    this.removeChild(entry.owner);this.entries.delete(view);
  }
  scroller(view){
    const preview=view.getMode?.()==='preview';
    return view.contentEl.querySelector(preview?'.markdown-reading-view .markdown-preview-view':'.markdown-source-view .cm-scroller');
  }
  schedule(view){
    const entry=this.entries.get(view);
    if(entry&&!entry.frame)entry.frame=entry.win.requestAnimationFrame(()=>{entry.frame=0;this.update(view);});
  }
  syncFileMemory(view,entry){
    const nextPath=view.file?.path||null;
    if(entry.filePath===nextPath)return;
    this.flushMemory(entry);
    entry.filePath=nextPath;
    const raw=nextPath&&this.plugin.data?.reading?.[nextPath];
    entry.savedMemory=raw?{...raw}:null;
    entry.resumeFraction=null;
  }
  queueMemory(entry,sample){
    if(!entry.filePath||!this.memoryEnabled()||typeof this.plugin.saveReading!=='function')return;
    entry.pendingMemory={path:entry.filePath,sample};
    if(typeof entry.win.setTimeout!=='function'){this.flushMemory(entry);return;}
    entry.win.clearTimeout?.(entry.memoryTimer);
    entry.memoryTimer=entry.win.setTimeout(()=>{entry.memoryTimer=0;this.flushMemory(entry);},MEMORY_DELAY);
  }
  flushMemory(entry){
    if(entry.memoryTimer){entry.win.clearTimeout?.(entry.memoryTimer);entry.memoryTimer=0;}
    const pending=entry.pendingMemory;entry.pendingMemory=null;
    if(pending&&typeof this.plugin.saveReading==='function')this.plugin.saveReading(pending.path,pending.sample);
  }
  syncTicks(entry,height){
    if(!(height>0))return;
    const count=Math.max(9,Math.floor(height/8)+1);
    if(entry.ticks.length===count)return;
    for(const t of entry.ticks)t.remove();
    entry.ticks=[];
    const doc=entry.el.ownerDocument;
    for(let i=0;i<count;i++){
      const tick=doc.createElement('i');
      tick.className=i%8===0?'aw-ruler-tick is-major':'aw-ruler-tick';
      tick.style.top=`${(i/(count-1)*100).toFixed(2)}%`;
      entry.ticksBox.appendChild(tick);entry.ticks.push(tick);
    }
    entry.el.classList.toggle('has-ticks',true);
  }
  paintWave(entry,progress=entry.lastProgress){
    if(!entry.ticks.length)return;
    const height=entry.el.getBoundingClientRect().height;
    const center=reducedMotion(entry.win)?null:entry.dragging&&Number.isFinite(progress)?progress*height:entry.hoverY;
    const count=entry.ticks.length;
    for(let i=0;i<count;i++){
      const tick=entry.ticks[i],y=count>1?i/(count-1)*height:0;
      const off=center===null||!(height>0)?0:waveOffset(y-center);
      tick.style.transform=off>=0.25?`translateX(${-off.toFixed(1)}px)`:'';
      tick.classList.toggle('is-near',off>=1.5);
    }
  }
  update(view){
    const entry=this.entries.get(view),s=entry&&this.scroller(view);
    if(!entry)return;
    this.syncFileMemory(view,entry);
    const progress=s?progressOf(s.scrollTop,s.scrollHeight,s.clientHeight):null;
    entry.lastProgress=progress;
    entry.el.classList.toggle('is-idle',progress===null);
    if(progress===null){entry.resume.hidden=true;return;}
    entry.knob.style.top=`${(progress*100).toFixed(2)}%`;entry.label.textContent=progress.toFixed(2);
    const height=entry.el.getBoundingClientRect().height;
    this.syncTicks(entry,height);
    this.paintWave(entry,progress);
    const {headings,fractions,current}=this.updateHeadings(view,entry,s,progress,height);
    const resume=this.memoryEnabled()?resolveResume(entry.savedMemory,headings,fractions):null;
    entry.resumeFraction=resume;
    if(resume!==null){
      entry.resume.hidden=false;
      entry.resume.style.top=`${(resume*100).toFixed(2)}%`;
    }else entry.resume.hidden=true;
    if(entry.savedMemory===null||Math.abs(progress-(resume??-1))>0.01)
      this.queueMemory(entry,makeMemory(progress,headings,fractions,current));
  }
  // Headings of levels 1–3 with their cleaned display text and 0-based source lines.
  headings(view){
    const list=view.file&&this.app.metadataCache.getFileCache(view.file)?.headings||[];
    return list.map(h=>({text:cleanHeading(h.heading),level:h.level,line:h.position?.start?.line}))
      .filter(h=>h.level<=HEADING_LEVELS&&h.text&&Number.isInteger(h.line));
  }
  // Where each heading's top sits in the scroller's content, as a fraction of its whole height.
  fractions(view,s,headings){
    const entry=this.entries.get(view);
    const height=s.scrollHeight,top=s.getBoundingClientRect().top-s.scrollTop;
    const cm=view.getMode?.()==='preview'?null:view.editor?.cm;
    if(height>0&&cm?.lineBlockAt&&cm.state?.doc&&Number.isFinite(cm.documentTop)){
      const lines=cm.state.doc.lines,base=cm.documentTop-top;
      return headings.map(h=>clamp01((base+cm.lineBlockAt(cm.state.doc.line(Math.min(h.line+1,lines)).from).top)/height));
    }
    const renderer=view.previewMode?.renderer,sections=renderer?.sections;
    const ui=x=>x===renderer?.header||x===renderer?.footer;
    const text=Array.isArray(sections)?sections.map((x,i)=>i).filter(i=>!ui(sections[i])):[];
    if(height>0&&text.length&&sections.every(x=>Number.isFinite(x?.height))&&text.every(i=>Number.isInteger(sections[i].start?.line)&&Number.isInteger(sections[i].end?.line))){
      const sig=`${view.file?.path||''}:${s.clientWidth||0}:${sections.length}:${headings.map(h=>`${h.line}:${h.level}`).join(',')}`;
      if(entry&&entry.sectionSig!==sig){entry.sectionSig=sig;entry.knownStarts.clear();}
      const known=entry?entry.knownStarts:new Map();
      sections.forEach((x,idx)=>{
        if(x.el?.isConnected&&x.el.offsetParent)known.set(idx,x.el.getBoundingClientRect().top-top);
      });
      // Next known anchor ahead of each index prevents off-screen height estimates from overshooting.
      const nextAnchor=Array(sections.length).fill(Infinity);
      let bound=Infinity;
      for(let idx=sections.length-1;idx>=0;idx--){
        if(known.has(idx))bound=known.get(idx);
        nextAnchor[idx]=bound;
      }
      const sizer=s.querySelector('.markdown-preview-sizer');
      let y=sizer?sizer.getBoundingClientRect().top-top:0;
      const starts=sections.map((x,idx)=>{
        if(known.has(idx))y=known.get(idx);
        else if(y>nextAnchor[idx])y=nextAnchor[idx];
        const at=y;y+=x.height;return at;
      });
      let j=0;const last=sections[text.at(-1)].end.line;
      return headings.map(h=>{
        while(j<text.length-1&&sections[text[j]].end.line<h.line)j++;
        const x=sections[text[j]],insideSec=x.start.line<=h.line&&h.line<=x.end.line;
        return clamp01(insideSec?starts[text[j]]/height:h.line/Math.max(1,last+1));
      });
    }
    const lines=Math.max(1,view.editor?.lineCount?.()||String(view.data||'').split('\n').length);
    return headings.map(h=>clamp01(h.line/lines));
  }
  // Room between the text column and the ruler, in px.
  margin(entry,s){
    const column=s.querySelector('.cm-sizer, .markdown-preview-sizer');
    if(!column)return 0;
    const pad=parseFloat(entry.el.ownerDocument.defaultView?.getComputedStyle?.(column)?.paddingRight)||0;
    return entry.el.getBoundingClientRect().left-(column.getBoundingClientRect().right-pad);
  }
  updateHeadings(view,entry,s,progress,height=entry.el.getBoundingClientRect().height){
    const headings=this.showHeadings()?this.headings(view):[];
    if(!headings.length){this.clearHeadings(entry);return {headings:[],fractions:[],current:-1};}
    const margin=this.margin(entry,s),compact=margin<MIN_MARGIN;
    entry.el.classList.toggle('is-compact',compact);
    entry.heads.style.setProperty('--aw-heads-width',`${Math.round(compact?LIST_WIDTH:Math.min(LIST_WIDTH,margin-24))}px`);
    const fractions=this.fractions(view,s,headings);
    const current=currentHeading(fractions,progress);
    const kept=layoutHeadings(headings.map((h,i)=>({index:i,level:h.level,top:fractions[i]*height})),HEADING_GAP,current);
    const dense=kept.length<headings.length;
    entry.el.classList.toggle('is-dense',dense);
    const doc=entry.el.ownerDocument;
    let near=false;
    kept.forEach((i,n)=>{
      const h=headings[i];
      let mark=entry.marks[n];
      if(!mark){
        mark=doc.createElement('div');
        const text=doc.createElement('span');text.className='aw-ruler-head-text';mark.appendChild(text);
        mark.addEventListener('pointerdown',event=>{
          if(event.button!==0)return;
          event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(mark.dataset.fraction),true);
        });
        entry.heads.appendChild(mark);entry.marks.push(mark);
      }
      mark.className=`aw-ruler-head is-level-${h.level}${i===current?' is-current':''}`;
      mark.dataset.line=String(h.line);mark.dataset.fraction=String(fractions[i]);mark.title=h.text;mark.firstChild.textContent=h.text;
      mark.style.top=`${(fractions[i]*100).toFixed(2)}%`;
      if(Math.abs(fractions[i]-progress)*height<12)near=true;
    });
    for(const extra of entry.marks.splice(kept.length))extra.remove();
    // Dense notes expose all headings in a scrollable popover on hover so clashing subsections stay reachable.
    if(dense){
      const minLevel=Math.min(...headings.map(h=>h.level));
      headings.forEach((h,i)=>{
        let item=entry.panelItems[i];
        if(!item){
          item=doc.createElement('div');
          item.addEventListener('pointerdown',event=>{
            if(event.button!==0)return;
            event.preventDefault();event.stopPropagation();this.jumpTo(view,Number(item.dataset.fraction),true);
          });
          entry.panel.appendChild(item);entry.panelItems.push(item);
        }
        const wasCurrent=item.className.includes('is-current');
        item.className=`aw-ruler-item is-level-${h.level}${i===current?' is-current':''}`;
        item.style.setProperty('--aw-head-indent',String(h.level-minLevel));
        item.dataset.line=String(h.line);item.dataset.fraction=String(fractions[i]);
        item.title=h.text;item.textContent=h.text;
        if(i===current&&!wasCurrent)item.scrollIntoView?.({block:'nearest'});
      });
      for(const extra of entry.panelItems.splice(headings.length))extra.remove();
    }else for(const extra of entry.panelItems.splice(0))extra.remove();
    // On a heading the dot's number would sit on the heading's name: the name says more.
    entry.el.classList.toggle('is-on-heading',near);
    return {headings,fractions,current};
  }
  clearHeadings(entry){
    for(const mark of entry.marks)mark.remove();
    for(const item of entry.panelItems)item.remove();
    entry.marks=[];entry.panelItems=[];
    entry.el.classList.toggle('is-on-heading',false);
    entry.el.classList.toggle('is-compact',false);
    entry.el.classList.toggle('is-dense',false);
  }
  stopGlide(entry){
    if(entry?.glideFrame){entry.win.cancelAnimationFrame?.(entry.glideFrame);entry.glideFrame=0;}
  }
  jumpTo(view,fraction,smooth=false){
    const s=this.scroller(view),entry=this.entries.get(view);
    if(!s||!Number.isFinite(fraction))return;
    this.stopGlide(entry);
    const target=topFor(fraction,s.scrollHeight,s.clientHeight);
    if(!smooth||!entry||typeof entry.win?.requestAnimationFrame!=='function'||reducedMotion(entry.win)||Math.abs(target-s.scrollTop)<=2){
      s.scrollTop=target;return;
    }
    const start=s.scrollTop,nowFn=()=>entry.win.performance?.now?.()??Date.now(),t0=nowFn();
    const step=()=>{
      const elapsed=nowFn()-t0,t=Math.min(1,Math.max(0,elapsed/GLIDE_MS));
      const eased=1-(1-t)**3;
      const latestTarget=topFor(fraction,s.scrollHeight,s.clientHeight);
      s.scrollTop=t>=1?latestTarget:Math.round(start+(latestTarget-start)*eased);
      if(t<1)entry.glideFrame=entry.win.requestAnimationFrame(step);
      else entry.glideFrame=0;
    };
    entry.glideFrame=entry.win.requestAnimationFrame(step);
  }
  drag(view,event){
    const entry=this.entries.get(view),s=this.scroller(view);
    if(!entry||!s||event.button!==0)return;
    event.preventDefault();
    entry.endDrag?.();
    this.stopGlide(entry);
    const doc=entry.el.ownerDocument,jump=e=>{
      const rect=entry.el.getBoundingClientRect();
      if(!(rect.height>0))return;
      const f=clamp01((e.clientY-rect.top)/rect.height);
      s.scrollTop=topFor(f,s.scrollHeight,s.clientHeight);
      entry.hoverY=e.clientY-rect.top;
      this.paintWave(entry,f);
    };
    entry.dragging=true;entry.el.classList.add('is-dragging');jump(event);
    const up=()=>{
      doc.removeEventListener?.('pointermove',jump);
      doc.removeEventListener?.('pointerup',up);
      doc.removeEventListener?.('pointercancel',up);
      entry.win.removeEventListener?.('blur',up);
      entry.dragging=false;entry.endDrag=null;
      entry.el.classList.remove('is-dragging');
      this.paintWave(entry);
    };
    entry.endDrag=up;
    doc.addEventListener('pointermove',jump);
    doc.addEventListener('pointerup',up);
    doc.addEventListener('pointercancel',up);
    entry.win.addEventListener?.('blur',up);
  }
  displaySettings(container,Setting){
    new Setting(container).setName('滚动刻度尺').setDesc('在笔记右侧显示阅读位置刻度；可点击或拖动跳转。')
      .addToggle(t=>t.setValue(this.plugin.data.settings.scrollRuler!==false).onChange(v=>{this.plugin.data.settings.scrollRuler=v;this.sync();this.plugin.changed();}));
    new Setting(container).setName('刻度尺旁显示标题').setDesc('在刻度尺左侧的页边列出一到三级标题，位置对应它们在全文中的位置；正在读的标题颜色加深，点击标题平滑跳转。页边窄或标题密集时，指针移到刻度尺上展开完整标题列表。')
      .addToggle(t=>t.setValue(this.showHeadings()).onChange(v=>{this.plugin.data.settings.rulerHeadings=v;this.sync();this.plugin.changed();}));
    new Setting(container).setName('记住上次阅读位置').setDesc('重新打开长笔记时，在刻度尺上用小菱形标出上次读到的位置，点击即可返回。')
      .addToggle(t=>t.setValue(this.memoryEnabled()).onChange(v=>{this.plugin.data.settings.rulerMemory=v;this.sync();this.plugin.changed();}));
  }
}
module.exports={ScrollRuler,progressOf,topFor,cleanHeading,waveOffset,resolveResume,makeMemory,currentHeading,layoutHeadings};

},
"features/decor.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,TFile}=require('obsidian');
const IMAGE=/^(png|jpe?g|gif|webp|avif|svg)$/i;

// An optional decoration image from the vault, floating in the window's lower-right corner
// (it never takes clicks and is not printed).
class Decor extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.el=null;}
  onload(){
    this.app.workspace.onLayoutReady(()=>this.refresh());
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      if(oldPath!==this.plugin.data.settings.decorImage)return;
      this.plugin.data.settings.decorImage=file.path;this.plugin.changed();this.refresh();
    }));
    this.registerEvent(this.app.vault.on('delete',file=>{if(file.path===this.plugin.data.settings.decorImage)this.refresh(file);}));
  }
  onunload(){this.el?.remove();this.el=null;}
  file(){
    const file=this.app.vault.getAbstractFileByPath(this.plugin.data.settings.decorImage||'');
    return file instanceof TFile&&IMAGE.test(file.extension)?file:null;
  }
  refresh(deleted=null){
    const file=this.file(),host=this.app.workspace.containerEl;
    if(!file||file===deleted||!host){this.el?.remove();this.el=null;return;}
    if(!this.el){
      this.el=host.ownerDocument.createElement('img');
      this.el.className='aw-decor';this.el.alt='';this.el.setAttribute('aria-hidden','true');
    }
    if(this.el.parentNode!==host)host.appendChild(this.el);
    const src=this.app.vault.getResourcePath(file);
    if(this.el.getAttribute('src')!==src)this.el.setAttribute('src',src);
  }
  displaySettings(container,Setting){
    new Setting(container).setName('角落装饰图').setDesc('在窗口右下角显示一张笔记库内的图片，例如 assets/mascot.png；留空则不显示。不响应点击，不打印。')
      .addText(t=>t.setPlaceholder('assets/mascot.png').setValue(this.plugin.data.settings.decorImage||'').onChange(v=>{
        this.plugin.data.settings.decorImage=v.trim().replace(/^\/+/,'');this.refresh();this.plugin.changed();
      }));
  }
}
module.exports={Decor};

},
"features/window-glass.js":(module,exports,__awRequire)=>{
'use strict';
const {Component}=require('obsidian');
const Core=__awRequire("core.js");

// Frosted paper window: the theme lays a sheet of paper (drawn in CSS from fractal noise, no
// picture) behind the whole window with frosted glass over it, and the sidebar, tabs and note
// sit on that one sheet. The plugin only switches it on and says how thick the fog is.
//
// This replaces Obsidian's own "Translucent window" on macOS, which shows no desktop since
// 1.8.9 and leaves ghosted text behind (an Electron compositing bug CSS can't fix). The window
// stays opaque here, so nothing ghosts.
class WindowGlass extends Component{
  constructor(plugin){super();this.plugin=plugin;}
  // Body classes for the glass, or none when it is switched off.
  classes(){
    const {glass,glassFog}=this.plugin.data.settings;
    return glass?['aw-glass','aw-glass-fog-'+(Core.GLASS_FOGS.some(f=>f.id===glassFog)?glassFog:'normal')]:[];
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings,apply=()=>{this.plugin.applyAppearanceEverywhere();this.plugin.changed();};
    new Setting(container).setName('窗口毛玻璃').setDesc('整个窗口铺一层类纸的磨砂玻璃：浅灰的纸面带柔和的明暗云纹和细颗粒，不带颜色，侧栏和正文连成同一层玻璃，正文略亮，白色卡片浮在上面。不需要任何图片，也不需要打开 Obsidian 的「半透明窗口」（它在 macOS 上会产生重影）。关闭则保持纯白外观。')
      .addToggle(t=>t.setValue(!!s.glass).onChange(v=>{s.glass=v;apply();}));
    new Setting(container).setName('毛玻璃雾的浓度').setDesc('纸面上那层白雾（深色模式为暗雾）的厚度：越浓越亮越素净，越淡纸纹越明显。')
      .addDropdown(d=>{
        for(const f of Core.GLASS_FOGS)d.addOption(f.id,f.label);
        d.setValue(s.glassFog||'normal').onChange(v=>{s.glassFog=v;apply();});
      });
  }
}
module.exports={WindowGlass};

},
"features/library.js":(module,exports,__awRequire)=>{
'use strict';
const {Component,ItemView,Menu,Modal,Notice,Setting,TFile,MarkdownView,setIcon}=require('obsidian');
const L=__awRequire("features/library-data.js");
const VIEW='aw-library',NAME='素材库',ICON='images';
// Cards are added a page at a time as the grid scrolls; GAP matches the CSS gap.
const PAGE=60,GAP=12,SAMPLE=24;
// Top-level folders take turns with the theme's tones, as in the reference.
const TONES=['tone-accent','tone-amber','tone-2','tone-3','tone-4','tone-1','tone-5'];
const FILTER={scope:{kind:'all',value:''},text:'',type:'all',shape:'all',color:'all',rating:'all',sort:'new',size:'m'};
const pick=(list,id,fallback)=>list.some(x=>x.id===id)?id:fallback;
const basename=path=>path.split('/').pop().replace(/\.md$/i,'');
const MIME_EXT={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/bmp':'bmp','image/svg+xml':'svg'};

// A saved filter (leaf state) back into a safe one.
function cleanFilter(raw){
  const f={...FILTER,scope:{...FILTER.scope}};
  if(!raw||typeof raw!=='object')return f;
  const kind=raw.scope?.kind;
  if(['all','unused','rated','folder','tag'].includes(kind)){
    const rawVal=typeof raw.scope.value==='string'?raw.scope.value:'';
    const value=kind==='folder'?L.cleanFolder(rawVal):rawVal;
    f.scope=kind==='folder'&&rawVal&&!value?{...FILTER.scope}:{kind,value};
  }
  f.type=pick(L.TYPES,raw.type,'all');f.shape=pick(L.SHAPES,raw.shape,'all');
  f.color=pick(L.COLORS,raw.color,'all');f.rating=pick(L.RATINGS,raw.rating,'all');
  f.sort=pick(L.SORTS,raw.sort,'new');f.size=pick(L.SIZES,raw.size,'m');
  return f;
}

// Downsample an already-decoded <img> onto a 24×24 canvas and extract its dominant colour families & HEX swatches.
function sampleImageColors(img,doc){
  if(!img||!(img.naturalWidth>0&&img.naturalHeight>0)||!doc?.createElement)return null;
  try{
    const canvas=doc.createElement('canvas');
    if(!canvas?.getContext)return null;
    canvas.width=SAMPLE;canvas.height=SAMPLE;
    const g=canvas.getContext('2d',{willReadFrequently:true})||canvas.getContext('2d');
    if(!g)return null;
    g.clearRect(0,0,SAMPLE,SAMPLE);
    g.drawImage(img,0,0,SAMPLE,SAMPLE);
    return L.analyzePixels(g.getImageData(0,0,SAMPLE,SAMPLE).data);
  }catch{return null;}
}

function extractImageFiles(list){
  const out=[];
  for(const item of list||[]){
    if(!item)continue;
    const file=typeof item.getAsFile==='function'?item.getAsFile():item;
    if(!file)continue;
    const ext=(file.name||'').includes('.')?file.name.split('.').pop():MIME_EXT[String(file.type||'').toLowerCase()];
    if(L.isImage(ext)||/^image\//i.test(file.type||''))out.push(file);
  }
  return out;
}

function migratePathMap(map,oldPath,newPath){
  for(const key of [...map.keys()]){
    const next=key===oldPath?newPath:key.startsWith(oldPath+'/')?newPath+key.slice(oldPath.length):null;
    if(next&&next!==key){map.set(next,map.get(key));map.delete(key);}
  }
}
function deletePathMap(map,path){
  for(const key of [...map.keys()])if(key===path||key.startsWith(path+'/'))map.delete(key);
}

// The index every library view reads: the vault's images with their ratings, tags, pixel sizes,
// dominant colours and the notes that embed or link them.
class Library extends Component{
  constructor(plugin){
    super();this.plugin=plugin;this.app=plugin.app;
    this.cache=null;this.links=null;this.dims=new Map();this.palettes=new Map();
    this.failed=new Set();this.queue=[];this.probing=new Set();this.active=0;this.timer=0;
    this.lastMarkdownLeaf=null;
  }
  onload(){
    this.plugin.registerView(VIEW,leaf=>new LibraryView(leaf,this));
    this.plugin.addRibbonIcon(ICON,'打开'+NAME,()=>void this.open());
    this.plugin.addCommand({id:'open-library',name:'打开'+NAME,callback:()=>void this.open()});
    const vault=this.app.vault,ws=this.app.workspace;
    if(typeof ws?.on==='function'){
      this.registerEvent(ws.on('active-leaf-change',leaf=>{
        if(MarkdownView&&leaf?.view instanceof MarkdownView)this.lastMarkdownLeaf=leaf;
      }));
    }
    // Notes come and go all the time; only pictures and folders change the library.
    const counts=(file,path=file.path)=>!(file instanceof TFile)||L.isImage(path.split('.').pop());
    this.registerEvent(vault.on('create',file=>{if(counts(file))this.changed();}));
    this.registerEvent(vault.on('rename',(file,oldPath)=>{
      migratePathMap(this.dims,oldPath,file.path);
      migratePathMap(this.palettes,oldPath,file.path);
      if(counts(file)||counts(file,oldPath))this.changed();
    }));
    this.registerEvent(vault.on('modify',file=>{
      this.failed.delete(file.path);
      const had=this.dims.delete(file.path)||this.palettes.delete(file.path);
      if(had)this.changed();
    }));
    this.registerEvent(vault.on('delete',file=>{
      const lib=this.plugin.data?.library;
      if(lib&&[lib.ratings,lib.tags].some(t=>Object.keys(t).some(p=>p===file.path||p.startsWith(file.path+'/')))){L.forgetInLibrary(lib,file.path);this.plugin.changed();}
      deletePathMap(this.dims,file.path);
      deletePathMap(this.palettes,file.path);
      this.changed();
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
      this.cache=L.makeItems(this.app.vault.getFiles(),{lib:this.plugin.data.library,used,dims:this.dims,palettes:this.palettes});
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
    if(this.views().some(v=>v.filter.shape!=='all'))this.changed();
  }
  setPalette(path,info){
    if(!info||(!info.colors?.length&&!info.palette?.length))return;
    const prev=this.palettes.get(path);
    if(prev&&prev.palette.join()===info.palette.join()&&prev.colors.join()===info.colors.join())return;
    this.palettes.set(path,info);
    const item=this.cache?.find(i=>i.path===path);
    if(item){item.colors=info.colors;item.palette=info.palette;}
    if(this.views().some(v=>v.filter.color!=='all'))this.changed();
  }
  // Load pictures whose sizes or colours are still unknown when filtering by shape or colour, four at a time.
  probe(items,doc,{needColor=false}={}){
    for(const item of items){
      const missing=!item.w||(needColor&&!this.palettes.has(item.path));
      if(missing&&!this.probing.has(item.path)&&!this.failed.has(item.path)){
        this.probing.add(item.path);this.queue.push(item.path);
      }
    }
    const win=doc?.defaultView||window;
    while(this.active<4&&this.queue.length){
      const path=this.queue.shift(),file=this.file(path);
      if(!file){this.probing.delete(path);continue;}
      this.active++;
      const img=new win.Image();
      const done=()=>{
        this.active--;this.probing.delete(path);img.onload=img.onerror=null;
        if(img.naturalWidth>0&&img.naturalHeight>0){
          this.setDims(path,img.naturalWidth,img.naturalHeight);
          const pal=sampleImageColors(img,doc);
          if(pal)this.setPalette(path,pal);
        }else this.failed.add(path);
        this.probe([],doc,{needColor});
      };
      img.onload=done;img.onerror=done;img.src=this.app.vault.getResourcePath(file);
    }
  }
  setRating(path,n){L.setRating(this.plugin.data.library,path,n);this.plugin.changed();this.refreshNow();}
  setTags(path,tags){L.setTags(this.plugin.data.library,path,tags);this.plugin.changed();this.refreshNow();}
  editableMarkdownLeaf(){
    const ok=leaf=>Boolean(leaf?.view&&MarkdownView&&leaf.view instanceof MarkdownView&&leaf.view.getMode?.()!=='preview');
    if(ok(this.lastMarkdownLeaf))return this.lastMarkdownLeaf;
    const recent=this.app.workspace.getMostRecentLeaf?.();
    if(ok(recent))return recent;
    return this.app.workspace.getLeavesOfType?.('markdown')?.find(ok)??null;
  }
  async ingest(files,{folder='',doc=null}={}){
    const valid=extractImageFiles(files);
    if(!valid.length)return [];
    const vault=this.app.vault,saved=[],dir=L.cleanFolder(folder);
    try{
      if(dir&&!vault.getAbstractFileByPath(dir)&&typeof vault.createFolder==='function'){
        try{await vault.createFolder(dir);}catch{}
      }
      const sourcePath=this.editableMarkdownLeaf()?.view?.file?.path||'';
      for(const raw of valid){
        const fallbackExt=MIME_EXT[String(raw.type||'').toLowerCase()]||'png';
        const clean=L.sanitizeImageName(raw.name,fallbackExt);
        let targetPath;
        if(dir||typeof this.app.fileManager?.getAvailablePathForAttachment!=='function'){
          targetPath=L.uniqueVaultPath(dir,clean.name,p=>Boolean(vault.getAbstractFileByPath(p)));
        }else{
          targetPath=await this.app.fileManager.getAvailablePathForAttachment(clean.name,sourcePath);
        }
        const bytes=await raw.arrayBuffer();
        await vault.createBinary(targetPath,bytes);
        saved.push(targetPath);
      }
      this.refreshNow();
      if(saved.length&&doc){
        const where=dir?`「${dir}」`:'附件目录';
        new Notice(saved.length===1?`已导入图片：${saved[0]}`:`已导入 ${saved.length} 张图片到${where}。`);
      }
      return saved;
    }catch(error){
      if(saved.length)this.refreshNow();
      new Notice(error?.message||'导入图片失败，请检查磁盘空间或权限。');
      return saved;
    }
  }
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
    this.filter=cleanFilter(null);this.shuffleSeed=0;this.internalDrag=false;
    this.expanded=new Set();this.list=[];this.listKey='';this.shown=0;this.cards=new Map();this.cols=[];
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
    const root=this.contentEl,doc=root.ownerDocument;root.empty();root.addClass('aw-lib');root.tabIndex=-1;
    const head=root.createDiv({cls:'aw-lib-head'});
    const title=head.createDiv({cls:'aw-lib-title'});
    setIcon(title.createSpan({cls:'aw-lib-title-icon'}),ICON);title.createSpan({cls:'aw-lib-title-text',text:NAME});
    this.countEl=title.createSpan({cls:'aw-lib-count'});
    const tools=title.createDiv({cls:'aw-lib-tools'});
    const upload=root.createEl('input',{attr:{type:'file',multiple:'multiple',accept:'.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.bmp',hidden:'hidden'}});
    this.registerDomEvent(upload,'change',()=>{
      const chosen=Array.from(upload.files||[]);upload.value='';
      if(chosen.length)void this.ingestHere(chosen);
    });
    const importBtn=tools.createEl('button',{cls:'aw-lib-tool',attr:{type:'button','aria-label':'导入图片',title:'导入图片'}});
    setIcon(importBtn.createSpan({cls:'aw-lib-tool-icon'}),'upload');importBtn.createSpan({text:'导入'});
    this.registerDomEvent(importBtn,'click',()=>upload.click());

    this.roamBtn=tools.createEl('button',{cls:'aw-lib-tool',attr:{type:'button','aria-label':'随机漫游',title:'随机漫游'}});
    setIcon(this.roamBtn.createSpan({cls:'aw-lib-tool-icon'}),'shuffle');this.roamBtn.createSpan({text:'漫游'});
    this.registerDomEvent(this.roamBtn,'click',()=>{
      this.shuffleSeed=((Date.now()^(this.shuffleSeed*1664525+1013904223))>>>0)||1;
      this.syncControls();this.refresh(true);
    });

    const search=head.createDiv({cls:'aw-lib-search'});setIcon(search.createSpan({cls:'aw-lib-search-icon'}),'search');
    this.searchEl=search.createEl('input',{attr:{type:'search',placeholder:'搜索素材','aria-label':'搜索素材'}});
    let typing=0;
    this.registerDomEvent(this.searchEl,'input',()=>{window.clearTimeout(typing);typing=window.setTimeout(()=>{this.filter.text=this.searchEl.value;this.refresh();},150);});
    const bar=head.createDiv({cls:'aw-lib-filters'});
    // Narrow panes have no side list: the scope is a dropdown instead.
    this.scopeEl=bar.createEl('select',{cls:'dropdown aw-lib-pill aw-lib-scope',attr:{'aria-label':'范围'}});
    this.registerDomEvent(this.scopeEl,'change',()=>{const [kind,...rest]=this.scopeEl.value.split(':');this.setScope(kind,rest.join(':'));});
    this.selects={};
    this.colorDot=bar.createSpan({cls:'aw-lib-color-indicator',attr:{'aria-hidden':'true'}});
    for(const [key,list,label] of [['color',L.COLORS,'颜色'],['type',L.TYPES,'类型'],['shape',L.SHAPES,'比例'],['rating',L.RATINGS,'星级'],['sort',L.SORTS,'排序']]){
      const sel=bar.createEl('select',{cls:'dropdown aw-lib-pill',attr:{'aria-label':label}});
      for(const o of list)sel.createEl('option',{text:o.label,attr:{value:o.id}});
      this.registerDomEvent(sel,'change',()=>{
        this.filter[key]=sel.value;
        if(key==='sort')this.shuffleSeed=0;
        this.syncControls();this.saveState();this.refresh(key==='sort');
      });
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

    // Clipboard image paste & external file drop capture.
    this.registerDomEvent(doc,'paste',event=>{
      const active=doc.activeElement;
      const inPane=root.contains(active)||this.app.workspace.activeLeaf===this.leaf;
      if(!inPane||doc.querySelector('.modal-container'))return;
      const imgs=extractImageFiles(event.clipboardData?.items?.length?event.clipboardData.items:event.clipboardData?.files);
      if(!imgs.length)return;
      event.preventDefault();
      void this.ingestHere(imgs);
    });
    const hasExternalFiles=event=>!this.internalDrag&&Array.from(event.dataTransfer?.types||[]).includes('Files');
    this.registerDomEvent(root,'dragover',event=>{
      if(!hasExternalFiles(event))return;
      event.preventDefault();
      if(event.dataTransfer)event.dataTransfer.dropEffect='copy';
      root.classList.add('is-drop-target');
    });
    this.registerDomEvent(root,'dragleave',event=>{
      if(!event.relatedTarget||!root.contains(event.relatedTarget))root.classList.remove('is-drop-target');
    });
    this.registerDomEvent(root,'drop',event=>{
      root.classList.remove('is-drop-target');
      if(this.internalDrag)return;
      const imgs=extractImageFiles(event.dataTransfer?.files);
      if(!imgs.length)return;
      event.preventDefault();
      void this.ingestHere(imgs);
    });

    const win=doc.defaultView||window;
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
  ingestHere(files){
    const folder=this.filter.scope.kind==='folder'?this.filter.scope.value:'';
    return this.library.ingest(files,{folder,doc:this.contentEl.ownerDocument});
  }
  syncControls(){
    if(!this.selects)return;
    for(const [key,sel] of Object.entries(this.selects))sel.value=this.filter[key];
    for(const b of this.sizeButtons)b.setAttribute('aria-pressed',String(b.dataset.size===this.filter.size));
    this.roamBtn?.setAttribute('aria-pressed',String(this.shuffleSeed>0));
    if(this.colorDot){
      const picked=L.COLORS.find(c=>c.id===this.filter.color);
      this.colorDot.hidden=!picked?.hex;
      if(picked?.hex)this.colorDot.style.background=picked.hex;
    }
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
    const all=this.library.items(),needColor=this.filter.color!=='all';
    const waiting=all.filter(i=>!this.library.failed.has(i.path)&&((this.filter.shape!=='all'&&!i.w)||(needColor&&!this.library.palettes.has(i.path))));
    if(waiting.length)this.library.probe(waiting,this.contentEl.ownerDocument,{needColor});
    const list=L.filterItems(all,this.filter,this.shuffleSeed);
    this.renderSide(all);
    this.countEl.textContent=list.length===all.length?`${all.length}`:`${list.length} / ${all.length}`;
    this.countEl.title=waiting.length?`正在读取剩余 ${waiting.length} 张图片的尺寸或主色`:'';
    const key=this.filter.size+'\n'+this.shuffleSeed+'\n'+list.map(i=>i.path).join('\n');
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
    row(scopes,{kind:'unused',icon:'inbox',text:'待整理',count:unused});
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
      this.emptyEl.setText(!all?'笔记库里还没有图片，可直接拖入或按 ⌘V 粘贴图片。':this.filter.scope.kind==='unused'&&!this.filter.text?'所有图片都被笔记引用了。':'没有符合条件的图片。');
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
    img.addEventListener('load',()=>{
      this.library.setDims(item.path,img.naturalWidth,img.naturalHeight);
      if(!this.library.palettes.has(item.path)){
        const pal=sampleImageColors(img,doc);
        if(pal)this.library.setPalette(item.path,pal);
      }
      const now=this.library.dims.get(item.path);
      if(now)this.fillDims(card,now.w,now.h);
      const pal=this.library.palettes.get(item.path);
      if(pal)this.fillSwatches(card,pal.palette);
    },{once:true});
    img.addEventListener('error',()=>card.addClass('is-broken'),{once:true});
    const badges=thumb.createDiv({cls:'aw-lib-badges'});
    badges.createSpan({cls:'aw-lib-dims'});
    const kind=L.kindOf(item.ext);
    if(kind!=='still')badges.createSpan({cls:'aw-lib-kind aw-lib-kind-'+kind,text:kind.toUpperCase()});
    thumb.createDiv({cls:'aw-lib-mini-swatches'});
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
    card.addEventListener('click',event=>{
      if(event.defaultPrevented)return;
      if(event.metaKey||event.ctrlKey)this.openFile(item.path);
      else this.inspect(item.path);
    });
    card.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&event.target===card){
        event.preventDefault();
        if(event.metaKey||event.ctrlKey)this.openFile(item.path);
        else this.inspect(item.path);
      }
    });
    card.addEventListener('contextmenu',event=>{event.preventDefault();this.menu(event,item.path);});
    card.addEventListener('dragstart',event=>{this.internalDrag=true;this.drag(event,item.path);});
    card.addEventListener('dragend',()=>{this.internalDrag=false;});
    this.fillCard(card,item);
    this.cards.set(item.path,card);
    return card;
  }
  // The parts of a card that change without a re-render: size, swatches, stars, tags.
  fillCard(card,item){
    this.fillDims(card,item.w,item.h);
    this.fillSwatches(card,item.palette||this.library.palettes.get(item.path)?.palette||[]);
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
  fillSwatches(card,palette){
    const box=card.querySelector('.aw-lib-mini-swatches');
    if(!box)return;
    const key=(palette||[]).slice(0,4).join(',');
    if(box.dataset.swatches===key)return;
    box.dataset.swatches=key;box.empty();
    for(const hex of (palette||[]).slice(0,4)){
      const dot=box.createSpan({cls:'aw-lib-mini-swatch'});
      dot.style.background=hex;
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
  inspect(path){new ImagePreviewModal(this,path).open();}
  openFile(path){const file=this.library.file(path);if(file)void this.app.workspace.getLeaf('tab').openFile(file);}
  embed(file,source){const link=this.app.fileManager.generateMarkdownLink(file,source);return link.startsWith('!')?link:'!'+link;}
  // Into the note last edited, at its cursor; reading view and other panes are refused.
  insert(path){
    const file=this.library.file(path),leaf=this.library.editableMarkdownLeaf(),view=leaf?.view;
    if(!file)return false;
    if(!view){new Notice('请先在编辑模式下打开一篇笔记。');return false;}
    view.editor.replaceSelection(this.embed(file,view.file?.path||''));
    this.app.workspace.setActiveLeaf(leaf,{focus:true});
    return true;
  }
  async copyText(text,msg){
    try{
      const clip=this.contentEl.ownerDocument.defaultView?.navigator?.clipboard??globalThis.navigator?.clipboard;
      await clip.writeText(text);
      new Notice(msg);
    }catch{new Notice('复制失败。');}
  }
  async copy(path){
    const file=this.library.file(path);if(!file)return;
    await this.copyText(this.embed(file,''),'已复制嵌入链接。');
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
    menu.addItem(i=>i.setTitle('大图预览').setIcon('maximize-2').onClick(()=>this.inspect(path)));
    menu.addItem(i=>i.setTitle('在新标签页打开').setIcon('image').onClick(()=>this.openFile(path)));
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
  editTags(path,after){
    const item=this.library.items().find(i=>i.path===path);if(!item)return;
    new TagsModal(this.app,{name:item.name+'.'+item.ext,tags:item.tags,known:L.tagCounts(this.library.items()).map(t=>t.tag)},tags=>{
      this.library.setTags(path,tags);
      after?.();
    }).open();
  }
}

// Vault-native Lightbox & Inspector: ← / → keyboard roaming, 1–5 star rating, dominant HEX swatches,
// tag editor, note references, and direct insert/open actions.
class ImagePreviewModal extends Modal{
  constructor(view,path){
    super(view.app);this.view=view;this.library=view.library;
    this.path=path;this.zoomed=false;
  }
  pool(){
    const list=this.view.list;
    if(list.some(i=>i.path===this.path))return list;
    const one=this.library.items().find(i=>i.path===this.path);
    return one?[one]:list;
  }
  current(){
    const pool=this.pool(),idx=pool.findIndex(i=>i.path===this.path);
    const item=pool[idx>=0?idx:0]||this.library.items().find(i=>i.path===this.path)||null;
    if(item)this.path=item.path;
    return {item,pool,index:Math.max(0,idx)};
  }
  step(delta){
    const {pool,index}=this.current();
    if(pool.length<=1)return;
    const next=(index+delta+pool.length)%pool.length;
    this.path=pool[next].path;this.zoomed=false;
    this.render();
  }
  onOpen(){
    const el=this.contentEl,doc=el.ownerDocument;
    this.modalEl?.classList?.add?.('aw-lib-modal','aw-lib-lightbox-modal');
    el.addClass('aw-lib-modal');el.addClass('aw-lib-lightbox');
    this.onKey=event=>{
      const modals=doc.querySelectorAll?.('.modal-container');
      if(modals&&modals.length>1)return;
      const tag=event.target?.tagName;
      if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
      if(event.key==='ArrowLeft'){event.preventDefault();this.step(-1);}
      else if(event.key==='ArrowRight'){event.preventDefault();this.step(1);}
      else if(/^[0-5]$/.test(event.key)&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
        event.preventDefault();
        const n=Number(event.key),cur=this.current().item;
        if(cur){this.library.setRating(cur.path,cur.rating===n?0:n);this.render();}
      }
    };
    doc.addEventListener?.('keydown',this.onKey);
    this.render();
  }
  render(){
    const el=this.contentEl,doc=el.ownerDocument,{item,pool,index}=this.current();
    el.empty();
    if(!item){this.close();return;}
    this.setTitle(`${item.name}.${item.ext}`);
    const wrap=el.createDiv({cls:'aw-lib-lightbox-body'});
    const stage=wrap.createDiv({cls:'aw-lib-stage'});
    if(pool.length>1){
      const prev=stage.createEl('button',{cls:'aw-lib-nav is-prev',attr:{type:'button','aria-label':'上一张'}});
      setIcon(prev,'chevron-left');prev.addEventListener('click',()=>this.step(-1));
      const next=stage.createEl('button',{cls:'aw-lib-nav is-next',attr:{type:'button','aria-label':'下一张'}});
      setIcon(next,'chevron-right');next.addEventListener('click',()=>this.step(1));
    }
    const frame=stage.createDiv({cls:'aw-lib-stage-frame'+(this.zoomed?' is-zoomed':'')});
    const file=this.library.file(item.path);
    const img=frame.createEl('img',{cls:'aw-lib-stage-img',attr:{alt:item.name}});
    if(file)img.src=this.app.vault.getResourcePath(file);
    img.addEventListener('click',()=>{this.zoomed=!this.zoomed;frame.classList.toggle('is-zoomed',this.zoomed);});
    if(pool.length>1)stage.createDiv({cls:'aw-lib-stage-counter',text:`${index+1} / ${pool.length}`});

    const side=wrap.createDiv({cls:'aw-lib-inspect'});
    const metaSec=side.createDiv({cls:'aw-lib-inspect-sec'});
    metaSec.createDiv({cls:'aw-lib-inspect-label',text:'信息'});
    const dimsText=metaSec.createDiv({cls:'aw-lib-inspect-val',text:`${item.w&&item.h?`${item.w} × ${item.h} · `:''}${item.ext.toUpperCase()} · ${L.formatSize(item.size)}`});
    if(item.folder){
      const folderBtn=metaSec.createEl('button',{cls:'aw-lib-inspect-folder',text:`目录：${item.folder}`,attr:{type:'button'}});
      folderBtn.addEventListener('click',()=>{this.view.setScope('folder',item.folder);this.close();});
    }

    const rateSec=side.createDiv({cls:'aw-lib-inspect-sec'});
    rateSec.createDiv({cls:'aw-lib-inspect-label',text:'星级'});
    const starRow=rateSec.createDiv({cls:'aw-lib-inspect-stars'});
    for(let n=1;n<=5;n++){
      const b=starRow.createEl('button',{cls:'aw-lib-inspect-star'+(n<=item.rating?' is-on':''),text:'★',attr:{type:'button','aria-label':`${n} 星`}});
      b.addEventListener('click',()=>{this.library.setRating(item.path,item.rating===n?0:n);this.render();});
    }

    const palSec=side.createDiv({cls:'aw-lib-inspect-sec'});
    palSec.createDiv({cls:'aw-lib-inspect-label',text:'主色板'});
    const swatchRow=palSec.createDiv({cls:'aw-lib-swatches'});
    const familyRow=palSec.createDiv({cls:'aw-lib-color-chips'});
    const fillPalette=(palInfo)=>{
      swatchRow.empty();familyRow.empty();
      const swatches=palInfo?.palette||[];
      if(!swatches.length){swatchRow.createSpan({cls:'aw-lib-hint',text:'读取中…'});return;}
      for(const hex of swatches){
        const chip=swatchRow.createEl('button',{cls:'aw-lib-swatch',attr:{type:'button',title:hex}});
        const dot=chip.createSpan({cls:'aw-lib-swatch-dot'});
        dot.style.background=hex;
        chip.createSpan({cls:'aw-lib-swatch-hex',text:hex});
        chip.addEventListener('click',()=>void this.view.copyText(hex,`已复制色值 ${hex}`));
      }
      for(const cid of palInfo?.colors||[]){
        const def=L.COLORS.find(c=>c.id===cid);
        if(!def)continue;
        const b=familyRow.createEl('button',{cls:'aw-lib-chip',text:`筛选：${def.label}`,attr:{type:'button'}});
        b.addEventListener('click',()=>{this.view.filter.color=cid;this.view.syncControls();this.view.saveState();this.view.refresh();this.close();});
      }
    };
    fillPalette(this.library.palettes.get(item.path));
    img.addEventListener('load',()=>{
      this.library.setDims(item.path,img.naturalWidth,img.naturalHeight);
      dimsText.textContent=`${img.naturalWidth} × ${img.naturalHeight} · ${item.ext.toUpperCase()} · ${L.formatSize(item.size)}`;
      let pal=this.library.palettes.get(item.path);
      if(!pal){pal=sampleImageColors(img,doc);if(pal)this.library.setPalette(item.path,pal);}
      fillPalette(pal);
    },{once:true});

    const tagSec=side.createDiv({cls:'aw-lib-inspect-sec'});
    tagSec.createDiv({cls:'aw-lib-inspect-label',text:'标签'});
    const tagRow=tagSec.createDiv({cls:'aw-lib-card-tags'});
    for(const tag of item.tags){
      const b=tagRow.createEl('button',{cls:'aw-lib-chip',text:'#'+tag,attr:{type:'button'}});
      b.addEventListener('click',()=>{this.view.setScope('tag',tag);this.close();});
    }
    const editTagBtn=tagRow.createEl('button',{cls:'aw-lib-chip is-action',text:item.tags.length?'编辑…':'+ 添加标签',attr:{type:'button'}});
    editTagBtn.addEventListener('click',()=>this.view.editTags(item.path,()=>this.render()));

    const refSec=side.createDiv({cls:'aw-lib-inspect-sec'});
    const refs=this.library.refsOf(item.path);
    refSec.createDiv({cls:'aw-lib-inspect-label',text:`引用笔记（${refs.length}）`});
    if(!refs.length)refSec.createDiv({cls:'aw-lib-hint',text:'暂未被笔记引用'});
    else{
      const refList=refSec.createDiv({cls:'aw-lib-inspect-refs'});
      for(const note of refs.slice(0,6)){
        const b=refList.createEl('button',{cls:'aw-lib-inspect-ref',text:basename(note),attr:{type:'button',title:note}});
        b.addEventListener('click',()=>{
          const target=this.app.vault.getAbstractFileByPath(note);
          if(target instanceof TFile){void this.app.workspace.getLeaf('tab').openFile(target);this.close();}
        });
      }
    }

    const actions=side.createDiv({cls:'aw-lib-inspect-actions'});
    const insertBtn=actions.createEl('button',{cls:'mod-cta aw-lib-inspect-primary',text:'插入到当前笔记',attr:{type:'button'}});
    insertBtn.addEventListener('click',()=>{if(this.view.insert(item.path))this.close();});
    const subActions=actions.createDiv({cls:'aw-lib-inspect-sub'});
    const copyBtn=subActions.createEl('button',{text:'复制链接',attr:{type:'button'}});
    copyBtn.addEventListener('click',()=>void this.view.copy(item.path));
    const tabBtn=subActions.createEl('button',{text:'新标签打开',attr:{type:'button'}});
    tabBtn.addEventListener('click',()=>{this.view.openFile(item.path);this.close();});
  }
  onClose(){
    this.contentEl.ownerDocument?.removeEventListener?.('keydown',this.onKey);
    this.contentEl.empty();
  }
}

class TagsModal extends Modal{
  constructor(app,{name,tags,known},submit){super(app);this.name=name;this.tags=tags;this.known=known;this.submit=submit;}
  onOpen(){
    const el=this.contentEl;el.addClass('aw-lib-modal');this.setTitle('编辑标签');
    let input;
    new Setting(el).setName(this.name).addText(t=>{
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

module.exports={Library,LibraryView,ImagePreviewModal,TagsModal,sampleImageColors,extractImageFiles,cleanFilter,VIEW};

},
"features/markdown-paste.js":(module,exports,__awRequire)=>{
'use strict';
const {Component}=require('obsidian');

// Pasting Markdown source. Code editors such as VS Code put the copied text on the clipboard
// twice: as plain text and as HTML, one <div> per line. Obsidian prefers the HTML and converts
// it to Markdown ("Auto convert HTML"), so every line becomes its own paragraph: a table falls
// apart into rows separated by blank lines. When the clipboard is clearly source text, the
// plain text is pasted as it is instead.

// A Markdown table: a row with a pipe, then the delimiter row (| --- | :-: | ...).
const TABLE=/^[ \t]*\|?[^\n]*\|[^\n]*\r?\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;
// Code editors (VS Code and its kin) wrap the copy in one <div> styled white-space: pre. Only
// that outer element counts: rich text from documents and web pages often carries pre-wrap or
// pre-line on inner spans (Google Docs does on every one), and keeps Obsidian's conversion.
const LEAD=/^(?:\s|<meta\b[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<!--[\s\S]*?-->)*/i;
const OUTER=/^<div\b[^>]*?\sstyle\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/i;
const PRE=/(?:^|;)\s*white-space\s*:\s*pre\s*(?:;|$)/i;
function fromCodeEditor(html){
  const outer=OUTER.exec(html.replace(LEAD,''));
  return !!outer&&PRE.test(outer[2]);
}

// The text to paste instead of Obsidian's HTML conversion, or null to leave the paste alone.
function sourceText(html,text){
  if(!html||!text)return null;
  if(!fromCodeEditor(html)&&!TABLE.test(text))return null;
  return text.replace(/\r\n?/g,'\n');
}

class MarkdownPaste extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;}
  onload(){this.registerEvent(this.app.workspace.on('editor-paste',(evt,editor)=>this.paste(evt,editor)));}
  paste(evt,editor){
    if(evt.defaultPrevented||!this.plugin.data?.settings?.pasteSource)return;
    const data=evt.clipboardData;
    // Files (pasted images) and Obsidian's own Markdown flavour keep their usual handling.
    if(!data||data.files?.length||data.getData('text/markdown'))return;
    const text=sourceText(data.getData('text/html'),data.getData('text/plain'));
    if(text==null)return;
    evt.preventDefault();
    // Marked as a paste, like Obsidian's own: counted as writing, and its own undo step.
    editor.replaceSelection(text,'input.paste');
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings;
    new Setting(container).setName('粘贴 Markdown 源码保持原样')
      .setDesc('从 VS Code 等代码编辑器复制的内容，或带 Markdown 表格的文字，粘贴时按原文插入，不经过 Obsidian 的「自动转换 HTML」，表格不会被拆成一行一段。其他粘贴不受影响；需要临时按原文粘贴任何内容时，可用 ⌘⇧V（Windows 为 Ctrl+Shift+V）。')
      .addToggle(t=>t.setValue(!!s.pasteSource).onChange(v=>{s.pasteSource=v;this.plugin.changed();}));
  }
}
module.exports={MarkdownPaste,sourceText};

}};
const __awCache=Object.create(null);
function __awRequire(id){if(__awCache[id])return __awCache[id].exports;const m={exports:{}};__awCache[id]=m;__awModules[id](m,m.exports,__awRequire);return m.exports;}
module.exports=__awRequire("main.js");
