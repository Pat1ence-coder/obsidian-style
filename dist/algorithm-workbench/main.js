'use strict';
const __awModules={"main.js":(module,exports,__awRequire)=>{
'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, TFile, editorInfoField} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const Core = __awRequire("core.js");
const {WorkbenchView,VIEW}=__awRequire("features/workbench.js");
const {FolderNotes}=__awRequire("features/folder-notes.js");
const {Figures}=__awRequire("features/figures.js");
const {ScreenshotNames}=__awRequire("features/screenshot-names.js");

class WorkbenchSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display() {
    this.containerEl.replaceChildren(); const s=this.plugin.data.settings;
    this.containerEl.createEl('h3',{text:'文件与新建'});
    this.plugin.folderNotes.displaySettings(this.containerEl);
    this.containerEl.createEl('h3',{text:'图片与附件'});
    this.plugin.screenshotNames.displaySettings(this.containerEl);
    this.containerEl.createEl('h3',{text:'外观'});
    new Setting(this.containerEl).setName('配色方案').setDesc('同时作用于知识脉冲看板和文档样式；浅色与深色模式各有对应版本。').addDropdown(d=>{
      for(const p of Core.PALETTES)d.addOption(p.id,p.label);
      d.setValue(s.palette).onChange(v=>this.plugin.setPalette(v));
    });
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
    this.stopped=false; this.saveError=false;
    try {this.data=Core.loadState(await this.loadData());}
    catch(error){new Notice('工作台统计数据无法读取，已停止加载，原文件未改动。请先备份 data.json。',10000);throw error;}
    this.folderNotes=this.addChild(new FolderNotes(this));
    this.figures=this.addChild(new Figures(this));
    this.screenshotNames=this.addChild(new ScreenshotNames(this));
    this.registerView(VIEW,leaf=>new WorkbenchView(leaf,this));
    this.addRibbonIcon('activity','打开知识脉冲看板',()=>this.openWorkbench());
    this.addCommand({id:'open-workbench',name:'打开知识脉冲看板',callback:()=>this.openWorkbench()});
    this.addCommand({id:'cycle-palette',name:'切换配色方案',callback:()=>{
      const list=Core.PALETTES,next=list[(list.findIndex(p=>p.id===this.data.settings.palette)+1)%list.length];
      this.setPalette(next.id);new Notice(`配色方案：${next.label}`);
    }});
    // The palette is a body class read by both stylesheets; popout windows get it too.
    // Windows already open (plugin re-enabled, restored layout) are collected from their leaves.
    this.paletteDocs=new Set();this.applyPaletteEverywhere();
    this.app.workspace.onLayoutReady(()=>{if(!this.stopped)this.applyPaletteEverywhere();});
    this.registerEvent(this.app.workspace.on('window-open',(_leaf,win)=>this.applyPalette(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_leaf,win)=>this.paletteDocs.delete(win.document)));
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
  changed(){this.scheduleSave();this.scheduleRefresh();}
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
  applyPalette(doc){
    if(!doc?.body)return;
    this.paletteDocs.add(doc);
    const body=doc.body,wanted='aw-palette-'+this.data.settings.palette;
    for(const name of [...body.classList])if(name.startsWith('aw-palette-')&&name!==wanted)body.classList.remove(name);
    body.classList.add(wanted);
  }
  applyPaletteEverywhere(){
    const docs=new Set(this.paletteDocs);
    docs.add(this.app.workspace.containerEl?.ownerDocument);
    this.app.workspace.iterateAllLeaves?.(leaf=>docs.add(leaf.view?.containerEl?.ownerDocument));
    for(const doc of docs)this.applyPalette(doc);
  }
  setPalette(id){
    if(!Core.PALETTES.some(p=>p.id===id)||this.data.settings.palette===id)return;
    this.data.settings.palette=id;
    this.applyPaletteEverywhere();
    this.changed();
  }
  onunload(){
    for(const doc of this.paletteDocs??[])for(const name of [...doc.body.classList])if(name.startsWith('aw-palette-'))doc.body.classList.remove(name);
    this.stopped=true;clearTimeout(this.saveTimer);clearTimeout(this.refreshTimer);this.documentCounts=new WeakMap();if(this.data)void this.flush();this.app.workspace.detachLeavesOfType(VIEW);}
}
module.exports=WorkbenchPlugin;

},
"core.js":(module,exports,__awRequire)=>{
'use strict';
const DEFAULT_SETTINGS = { nameScreenshots: true, folderNotes: true, openOnStartup: true, tracking: true, recentLimit: 8, range: 90, metric: 'score', palette: 'sea', excludedFolders: ['Templates', 'templates'] };
const RANGES = [30, 90, 180, 365];
// Colour palettes; each id maps to a body class aw-palette-<id> defined in tokens.css.
const PALETTES = [{id:'sea', label:'海盐石墨'}, {id:'sand', label:'暖砂陶土'}, {id:'celadon', label:'青瓷'}];
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
function emptyData(now = new Date()) {
  return { version: 2, started: dayKey(now), activityStarted: dayKey(now), settings: {...DEFAULT_SETTINGS}, days: dict(), records: dict() };
}
function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function loadState(raw, now = new Date()) {
  if (raw == null) return emptyData(now);
  if (![1,2].includes(raw.version) || !raw.days || !raw.records || !DATE.test(raw.started)) throw Error('无法识别统计文件格式');
  // Version 1 only tracked characters; the other activity counters start at migration.
  if (raw.version === 2 && !DATE.test(raw.activityStarted)) throw Error('无法识别统计文件格式');
  const d = emptyData(now); d.started = raw.started;
  if (raw.version === 2) d.activityStarted = raw.activityStarted;
  const s = raw.settings || {};
  for (const name of ['openOnStartup', 'tracking', 'folderNotes', 'nameScreenshots']) if (typeof s[name] === 'boolean') d.settings[name] = s[name];
  if (RANGES.includes(s.range)) d.settings.range = s.range;
  if (METRICS.some(m => m.key === s.metric)) d.settings.metric = s.metric;
  if (PALETTES.some(x => x.id === s.palette)) d.settings.palette = s.palette;
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
    if (r.day === dayKey(now)) d.records[path] = {...r};
  }
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
function recordNote(data, date) { const day = ensureDay(data,date); day.notes = (day.notes||0)+1; }
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
}
function recentFiles(files, settings) {
  return files.filter(f=>!isExcluded(f.path,settings.excludedFolders)).sort((a,b)=>b.stat.mtime-a.stat.mtime || a.path.localeCompare(b.path)).slice(0,settings.recentLimit);
}
function calendarDays(now, weeks) {
  const monday = shiftDay(now,-((now.getDay()+6)%7));
  const start = shiftDay(monday,-7*(weeks-1));
  return Array.from({length:weeks*7},(_,i)=>dayKey(shiftDay(start,i)));
}
module.exports = {transactionCounts,pruneRecords,DEFAULT_SETTINGS,RANGES,METRICS,PALETTES,dayKey,shiftDay,countCharacters,emptyData,loadState,isExcluded,recordChange,
  recordActivity,taskDelta,recordTasks,recordNote,dayScore,metricValue,lastDays,summary,currentStreak,activeValues,intensity,percentile,renamePath,recentFiles,calendarDays};

},
"features/workbench.js":(module,exports,__awRequire)=>{
'use strict';
const {ItemView,Menu,Notice,TFile,setIcon}=require('obsidian');
const Core=__awRequire("core.js");
const VIEW='algorithm-workbench';
const WEEKS=53;
const number=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
const hours=minutes=>number(Math.round(minutes/6)/10);
const clockFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateFormat=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'});
const fullDateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'});
const TABS=[['board','看板视图'],['recent','最近笔记'],['monthly','月度汇总']];
const metricOf=key=>Core.METRICS.find(m=>m.key===key)||Core.METRICS[0];
// One companion hue per metric; cards, dots, tabs and the heatmap ramp all follow it.
const HUES={score:'tone-accent',characters:'tone-1',minutes:'tone-2',focus:'tone-3',notes:'tone-4',tasks:'tone-5'};
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
// Every module shares one header: icon tile, title, dotted subtitle and a pill badge.
function card(parent,{name,iconName,title,sub,badge,hue='tone-accent'}){
  const section=tint(el(parent,'section',`aw-card aw-card-${name}`),hue);
  const head=el(section,'header','aw-card-head');
  icon(head,iconName,'aw-card-icon');
  const copy=el(head,'div','aw-card-copy');el(copy,'h2','aw-card-title',title);
  const subtitle=el(copy,'p','aw-card-sub',sub);
  const pill=el(head,'span','aw-badge',badge);
  return {section,subtitle,pill,body:el(section,'div','aw-panel')};
}
function stat(parent,label,value,unit,cls='',hue){
  const item=el(parent,'div','aw-stat'+(cls?' '+cls:''));
  const caption=el(item,'span','aw-stat-label');
  if(hue)tint(el(caption,'i','aw-dot'),hue).setAttribute('aria-hidden','true');
  el(caption,'span','',label);
  const line=el(item,'div','aw-stat-value');const strong=el(line,'strong','',value);el(line,'span','aw-unit',unit);
  return strong;
}
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
function csv(data){
  const rows=[['日期','贡献分','新增字数','编辑分钟','专注分钟','新建笔记','完成任务']];
  for(const date of Object.keys(data.days).sort()){
    const day=data.days[date];rows.push([date,Core.dayScore(day),...Core.METRICS.slice(1).map(m=>Core.metricValue(day,m.key))]);
  }
  return '\ufeff'+rows.map(r=>r.join(',')).join('\n')+'\n';
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
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.selectedDate=Core.dayKey();this.tab='board';this.creatingNote=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return '知识脉冲';}
  getIcon(){return 'activity';}
  async onOpen(){this.render();}
  async onClose(){
    this.contentEl.replaceChildren();this.dayEl=null;this.recentEl=null;
    this.heatCells=null;this.statNumbers=null;this.renderStamp=null;this.recentStamp=null;this.dayStamp=null;
  }
  stamp(){return [Core.dayKey(),JSON.stringify(this.plugin.data.settings),this.plugin.saveError,this.plugin.folderNotes?.getFolder()?.path??'',this.tab].join('|');}
  daySignature(){
    const day=this.plugin.data.days[this.selectedDate],records=day?.files||{};
    return this.selectedDate+'|'+JSON.stringify(day||null)+'|'+(this.ranked||[]).join()+'|'+JSON.stringify(Object.keys(records).map(path=>this.app.vault.getAbstractFileByPath(path) instanceof TFile));
  }
  refresh(){
    if(this.contentEl.getClientRects().length===0)return;
    if(this.renderStamp!==this.stamp()||this.tab==='monthly'){this.render();return;}
    if(this.statNumbers){
      const values=overview(this.plugin.data);
      for(const [key,node] of this.statNumbers)if(node.textContent!==values[key])node.textContent=values[key];
      this.longestEl.textContent=`最长连续 ${values.longest} 天`;
    }
    if(this.heatCells)this.paintHeat();
    const files=Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings);
    if(this.recentEl&&this.recentStamp!==JSON.stringify(files.map(f=>[f.path,f.stat.mtime])))this.renderRecent(files);
    if(this.dayEl&&this.dayStamp!==this.daySignature())this.renderDay();
  }
  render(){
    const active=this.contentEl.ownerDocument.activeElement;
    const focusDate=active?.dataset?.awDate,focusKey=active?.dataset?.awFocus;
    const scrollTop=this.contentEl.scrollTop;
    const helpOpen=this.contentEl.querySelector('.aw-help')?.open||false;
    const heatScroll=this.contentEl.querySelector('.aw-heat-scroll')?.scrollLeft;
    this.contentEl.replaceChildren();this.contentEl.classList.add('aw-view');
    this.statNumbers=null;this.heatCells=null;this.dayEl=null;this.recentEl=null;
    const data=this.plugin.data,settings=data.settings;
    const root=el(this.contentEl,'div','aw-page');
    // The banner, blurred and enlarged, lights the glass cards from behind.
    el(root,'div','aw-ambient').setAttribute('aria-hidden','true');
    this.renderHero(root);
    if(!settings.tracking)el(root,'p','aw-notice','活动统计已暂停，可在插件设置中恢复。');
    if(this.plugin.saveError)el(root,'p','aw-notice','统计暂未保存成功，请检查磁盘空间或权限；插件会重试。').setAttribute('role','status');
    const stack=el(root,'div','aw-stack');
    let heatWrap=null;
    if(this.tab==='board'){
      this.renderOverview(stack);heatWrap=this.renderPulse(stack);
      this.dayEl=el(stack,'div','aw-day-slot');this.renderDay();
      this.renderRecentCard(stack,Math.min(settings.recentLimit,5));
    }else if(this.tab==='recent')this.renderRecentCard(stack,settings.recentLimit);
    else this.renderMonthly(stack);
    const footer=el(root,'footer','aw-footer');
    const local=el(footer,'span','aw-local');icon(local,'hard-drive');el(local,'span','',settings.tracking?'仅保存在本地':'本地记录 · 已暂停');
    const help=el(footer,'details','aw-help');help.open=helpOpen;el(help,'summary','','如何统计？');
    el(help,'p','','新增字数：本机编辑器内新增的非空白字符，含公式、代码和粘贴内容，删除后恢复不重复计数。编辑时长：有输入的分钟，以及其间不超过 5 分钟的停顿。深度专注：连续编辑达到 25 分钟的时段。新建笔记：Obsidian 中新建的 Markdown 文件。完成任务：编辑器里新勾选的任务，反复勾选只算一次。');
    el(help,'p','','贡献分 = 新增字数 ÷ 100 + 编辑分钟 ÷ 10 + 专注分钟 ÷ 10 + 新建笔记 × 2 + 完成任务。热力图强度按所选时间范围内活跃日的四分位数分级。');
    this.renderStamp=this.stamp();this.contentEl.scrollTop=scrollTop;
    if(heatWrap)heatWrap.scrollLeft=heatScroll??heatWrap.scrollWidth;
    if(focusDate)this.heatCells?.get(focusDate)?.focus({preventScroll:true});
    else if(focusKey)this.contentEl.querySelector(`[data-aw-focus="${focusKey}"]`)?.focus({preventScroll:true});
  }
  renderHero(root){
    const settings=this.plugin.data.settings;
    const hero=el(root,'header','aw-hero');el(hero,'div','aw-backdrop').setAttribute('aria-hidden','true');
    const bar=el(hero,'div','aw-hero-bar'),brand=el(bar,'div','aw-brand');
    icon(brand,'activity','aw-brand-mark');el(brand,'h1','aw-title','知识脉冲看板');
    const tabs=el(bar,'nav','aw-tabs');tabs.setAttribute('aria-label','视图');
    for(const [key,label] of TABS){
      const tab=button(tabs,label,'aw-tab',()=>{if(this.tab!==key){this.tab=key;this.render();}});
      tab.dataset.awFocus='tab-'+key;tab.setAttribute('aria-pressed',String(this.tab===key));
    }
    const tools=el(hero,'div','aw-toolbar');
    const range=button(tools,'','aw-chip',event=>this.chooseRange(event));range.dataset.awFocus='range';
    el(range,'span','aw-chip-key','时间:');el(range,'span','',`最近 ${settings.range} 天`);icon(range,'chevron-down','aw-chip-icon');
    el(tools,'span','aw-chip aw-chip-static',settings.tracking?'范围: 本机记录':'范围: 统计已暂停');
    const palette=button(tools,'','aw-chip aw-palette',event=>this.choosePalette(event));palette.dataset.awFocus='palette';
    el(palette,'span','aw-chip-key','配色:');el(palette,'span','',(Core.PALETTES.find(p=>p.id===settings.palette)||Core.PALETTES[0]).label);
    icon(palette,'chevron-down','aw-chip-icon');
    const create=button(tools,'','aw-chip aw-new-note',()=>this.newNote());icon(create,'plus','aw-chip-icon');el(create,'span','','新建笔记');
    const folder=this.plugin.folderNotes?.getFolder();
    create.title=folder?`在 ${folder.path==='/'?'笔记库根目录':folder.path} 中新建`:'按 Obsidian 当前的新建笔记设置创建';
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
  choosePalette(event){
    const current=this.plugin.data.settings.palette,choose=id=>{if(id!==current)this.plugin.setPalette(id);};
    if(typeof Menu!=='function'){choose(Core.PALETTES[(Core.PALETTES.findIndex(p=>p.id===current)+1)%Core.PALETTES.length].id);return;}
    const menu=new Menu();
    for(const p of Core.PALETTES)menu.addItem(item=>item.setTitle(p.label).setChecked(p.id===current).onClick(()=>choose(p.id)));
    menu.showAtMouseEvent(event);
  }
  renderOverview(stack){
    const data=this.plugin.data,values=overview(data);
    const c=card(stack,{name:'overview',iconName:'activity',title:'知识脉冲概览',sub:`最近 ${data.settings.range} 天 · 本机记录`,badge:`最长连续 ${values.longest} 天`,hue:'tone-accent'});
    this.longestEl=c.pill;
    const row=el(c.body,'div','aw-stats');this.statNumbers=new Map();
    for(const [key,label,unit,cls] of [['score','累计贡献分','分'],['characters','新增字数','字'],['active','活跃天数','天'],['streak','当前连续','天','aw-stat-accent'],['minutes','编辑时长','小时'],['focus','深度专注','小时']])
      this.statNumbers.set(key,stat(row,label,values[key],unit,cls,HUES[key]));
  }
  renderPulse(stack){
    const data=this.plugin.data,settings=data.settings,metric=metricOf(settings.metric);
    const c=card(stack,{name:'pulse',iconName:'calendar-days',title:'年度知识活跃脉冲',sub:`${metric.label} · 强度按个人近期分位数`,badge:'',hue:HUES[metric.key]});
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
    el(caption,'span','',`完整 ${WEEKS} 周 · 统计：最近 ${settings.range} 天 · 区间外淡化 · 自 ${metric.key==='characters'?data.started:data.activityStarted} 起记录`);
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
    const metric=metricOf(data.settings.metric),value=Core.metricValue(day,metric.key);
    const rank=this.ranked&&this.selectedDate>=Core.lastDays(new Date(),data.settings.range)[0]?Core.percentile(value,this.ranked):null;
    const date=new Date(this.selectedDate+'T12:00:00');
    const sub=rank===null?(this.selectedDate<data.started?'启用之前 · 没有记录':'本机记录'):`本机记录 · ${metric.label}强度第 ${rank}% 分位`;
    const c=card(this.dayEl,{name:'day',iconName:'file-text',title:`${fullDateFormat.format(date)} 明细`,sub,badge:`${number(score)} 分`,hue:'tone-1'});
    c.section.querySelector('.aw-card-title').title=this.selectedDate;
    const row=el(c.body,'div','aw-stats aw-stats-compact');
    stat(row,'贡献得分',number(score),'分','',HUES.score);
    stat(row,'新增字数',number(day?.characters||0),'字','',HUES.characters);
    stat(row,'编辑时长',number(day?.minutes||0),'分钟','',HUES.minutes);
    stat(row,'新建笔记',number(day?.notes||0),'篇','',HUES.notes);
    stat(row,'完成任务',number(day?.tasks||0),'项','',HUES.tasks);
    const entries=Object.entries(day?.files||{}).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){el(c.body,'p','aw-empty',this.selectedDate<data.started?'这一天在启用之前，没有记录。':'这一天没有新增文字。');return;}
    const list=el(c.body,'div','aw-day-list');
    for(const [path,count] of entries){
      const file=this.app.vault.getAbstractFileByPath(path),exists=file instanceof TFile;
      const row=button(list,'','aw-day-row',()=>this.openFile(path));row.disabled=!exists;row.title=exists?path:`${path}（文件已移除）`;
      icon(row,'file-text','aw-row-icon');el(row,'span','aw-day-name',exists?file.basename:path);el(row,'span','aw-day-count',`+${number(count)} 字`);
      row.setAttribute('aria-label',`${exists?file.basename:path}，新增 ${number(count)} 字${exists?'':'，文件已移除'}`);
    }
  }
  renderRecentCard(stack,limit){
    const c=card(stack,{name:'recent',iconName:'history',title:'继续编辑',sub:'按修改时间 · 已排除模板目录',badge:'',hue:'tone-2'});
    this.recentEl=c.body;this.recentPill=c.pill;this.recentLimit=limit;
    this.renderRecent(Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings));
  }
  renderRecent(files){
    if(!this.recentEl)return;
    const area=this.recentEl;area.replaceChildren();
    this.recentStamp=JSON.stringify(files.map(f=>[f.path,f.stat.mtime]));
    const shown=files.slice(0,this.recentLimit);this.recentPill.textContent=`${shown.length} 篇`;
    if(!shown.length){el(area,'p','aw-empty','还没有笔记，点击“新建笔记”开始记录。');return;}
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
    const c=card(stack,{name:'monthly',iconName:'table',title:'月度汇总',sub:'最近 12 个月 · 本机记录',badge:`${rows.filter(r=>r.active).length} 个月活跃`,hue:'tone-3'});
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
  async exportCSV(){
    const vault=this.app.vault,stamp=Core.dayKey().replace(/-/g,'');
    let path=`知识脉冲-${stamp}.csv`;
    for(let i=2;vault.getAbstractFileByPath(path);i++)path=`知识脉冲-${stamp}-${i}.csv`;
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
module.exports={WorkbenchView,VIEW,overview,modifiedLabel,csv,months};

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
      }else await this.app.workspace.getLeaf('tab').openFile(created);
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
    this.contentEl.createEl('p',{text:'选择图片，设置宽度与图注。插入后仍是可直接编辑的 Markdown。'});
    new Setting(this.contentEl).setName('布局').addDropdown(d=>{
      this.layoutDropdown=d;
      d.addOptions({single:'单张图片','grid-1':'多图 · 1 列','grid-2':'多图 · 2 列','grid-3':'多图 · 3 列','grid-4':'多图 · 4 列'}).setValue(this.layout).onChange(value=>{
        if(this.busy){d.setValue(this.layout);return;}
        if(value==='single'&&this.sources.length>1){new Notice('请先移除多余图片，或选择多图布局。');d.setValue(this.layout);return;}
        this.layout=value;this.updateLayout();
      });
    });
    new Setting(this.contentEl).setName('添加图片').setDesc('可连续添加库内图片，或一次选择电脑中的多张图片。').addButton(b=>b.setButtonText('从笔记库添加').onClick(()=>{
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
    this.widthSetting=new Setting(this.contentEl).setName('宽度（px）').setDesc('默认 640，留空使用原图宽度；窄页面自动缩小。').addText(t=>t.setValue(this.width).onChange(v=>this.width=v));
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
function imageReference(text) {
  const s=text.trim();
  if((s.match(/!\[/g)||[]).length!==1)return null;
  return /^!\[\[[^\r\n]+\]\]$/.test(s) || /^!\[[^\]\r\n]*\]\([^\r\n]+\)$/.test(s) ? s : null;
}
function figureMarkdown(reference, caption, width='640', align='center') {
  const references=Array.isArray(reference)?reference:[reference];
  const grid=/^grid-[1-4]$/.test(align);
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
module.exports={imageReference,figureMarkdown,spacedFigure};

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

}};
const __awCache=Object.create(null);
function __awRequire(id){if(__awCache[id])return __awCache[id].exports;const m={exports:{}};__awCache[id]=m;__awModules[id](m,m.exports,__awRequire);return m.exports;}
module.exports=__awRequire("main.js");
