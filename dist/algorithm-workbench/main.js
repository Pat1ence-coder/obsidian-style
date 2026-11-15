'use strict';
const __awModules={"main.js":(module,exports,__awRequire)=>{
'use strict';
const {Plugin, PluginSettingTab, Setting, Notice, TFile, editorInfoField} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const Core = __awRequire("core.js");
const {WorkbenchView,VIEW,NAME,viewIcon}=__awRequire("features/workbench.js");
const {FolderNotes}=__awRequire("features/folder-notes.js");
const {Figures}=__awRequire("features/figures.js");
const {ScreenshotNames}=__awRequire("features/screenshot-names.js");
const {FigureTools}=__awRequire("features/figure-tools.js");
const {Annotations}=__awRequire("features/annotations.js");
const {ScrollRuler}=__awRequire("features/scroll-ruler.js");
const {Decor}=__awRequire("features/decor.js");
// aw-palette-* and aw-style-* are listed so classes left by earlier versions are cleaned up.
const APPEARANCE=/^aw-(?:palette|style|caption)-|^aw-figure-tools-off$/;

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
    this.stopped=false; this.saveError=false;
    try {this.data=Core.loadState(await this.loadData());}
    catch(error){new Notice('工作台统计数据无法读取，已停止加载，原文件未改动。请先备份 data.json。',10000);throw error;}
    this.folderNotes=this.addChild(new FolderNotes(this));
    this.figures=this.addChild(new Figures(this));
    this.figureTools=this.addChild(new FigureTools(this));
    this.screenshotNames=this.addChild(new ScreenshotNames(this));
    this.annotations=this.addChild(new Annotations(this));
    this.scrollRuler=this.addChild(new ScrollRuler(this));
    this.decor=this.addChild(new Decor(this));
    this.registerView(VIEW,leaf=>new WorkbenchView(leaf,this));
    this.addRibbonIcon(viewIcon(),`打开${NAME}`,()=>this.openWorkbench());
    this.addCommand({id:'open-workbench',name:`打开${NAME}`,callback:()=>this.openWorkbench()});
    // Palette and caption size are body classes read by both stylesheets; popout windows get
    // them too. Windows already open (plugin re-enabled, restored layout) are found via leaves.
    this.appearanceDocs=new Set();this.applyAppearanceEverywhere();
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
    return ['aw-caption-'+s.captionSize].concat(s.figureTools?[]:['aw-figure-tools-off']);
  }
  applyAppearance(doc){
    if(!doc?.body)return;
    this.appearanceDocs.add(doc);
    const body=doc.body,wanted=this.appearanceClasses();
    for(const name of [...body.classList])if(APPEARANCE.test(name)&&!wanted.includes(name))body.classList.remove(name);
    for(const name of wanted)body.classList.add(name);
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
    for(const doc of this.appearanceDocs??[])for(const name of [...doc.body.classList])if(APPEARANCE.test(name))doc.body.classList.remove(name);
    this.stopped=true;clearTimeout(this.saveTimer);clearTimeout(this.refreshTimer);this.documentCounts=new WeakMap();if(this.data)void this.flush();this.app.workspace.detachLeavesOfType(VIEW);}
}
module.exports=WorkbenchPlugin;

},
"core.js":(module,exports,__awRequire)=>{
'use strict';
const DEFAULT_SETTINGS = { nameScreenshots: true, folderNotes: true, openOnStartup: true, tracking: true, recentLimit: 8, range: 90, metric: 'score', captionSize: 'normal', figureTools: true, scrollRuler: true, decorImage: '', excludedFolders: ['Templates', 'templates'] };
const RANGES = [30, 90, 180, 365];
// Figure and table caption sizes; body class aw-caption-<id>, defined in figures.css.
const CAPTION_SIZES = [{id:'small', label:'小'}, {id:'normal', label:'标准'}, {id:'large', label:'大'}];
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
  for (const name of ['openOnStartup', 'tracking', 'folderNotes', 'nameScreenshots', 'figureTools', 'scrollRuler']) if (typeof s[name] === 'boolean') d.settings[name] = s[name];
  if (RANGES.includes(s.range)) d.settings.range = s.range;
  if (METRICS.some(m => m.key === s.metric)) d.settings.metric = s.metric;
  if (CAPTION_SIZES.some(x => x.id === s.captionSize)) d.settings.captionSize = s.captionSize;
  if (typeof s.decorImage === 'string') d.settings.decorImage = s.decorImage.trim().replace(/^\/+/, '').slice(0, 500);
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
module.exports = {transactionCounts,pruneRecords,DEFAULT_SETTINGS,RANGES,METRICS,CAPTION_SIZES,dayKey,shiftDay,countCharacters,emptyData,loadState,isExcluded,recordChange,
  recordActivity,taskDelta,recordTasks,recordNote,dayScore,metricValue,lastDays,summary,currentStreak,activeValues,intensity,percentile,renamePath,recentFiles,calendarDays};

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
const TABS=[['board','看板视图'],['recent','最近笔记'],['monthly','月度汇总']];
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
  getDisplayText(){return NAME;}
  getIcon(){return viewIcon();}
  async onOpen(){this.render();}
  async onClose(){
    this.contentEl.replaceChildren();this.dayEl=null;this.recentEl=null;
    this.heatCells=null;this.statNumbers=null;this.longestEl=null;this.liveParts=[];this.renderStamp=null;this.recentStamp=null;this.dayStamp=null;
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
    const helpOpen=this.contentEl.querySelector('.aw-help')?.open||false;
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
    el(tools,'span','aw-chip aw-chip-static',settings.tracking?'范围: 本机记录':'范围: 统计已暂停');
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
  // A part that redraws itself on refresh() whenever the value read() returns changes.
  // read() runs once per check and its value goes straight to draw().
  live(read,draw){const value=read(),part={read,stamp:JSON.stringify(value),draw};this.liveParts.push(part);draw(value);return part;}
  renderKpis(stack){
    const data=this.plugin.data,values=overview(data);this.statNumbers=new Map();
    const kpis=[
      {key:'score',label:'累计贡献分',unit:'分',iconName:'sparkles',badge:`近 ${data.settings.range} 天`,foot:['active','活跃天数','天']},
      {key:'characters',label:'新增字数',unit:'字',iconName:'pen-line',badge:`最长连续 ${values.longest} 天`,foot:['streak','当前连续','天'],longest:true},
      {key:'minutes',label:'编辑时长',unit:'小时',iconName:'clock',badge:'本机记录',foot:['focus','深度专注','小时']},
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
    const c=card(stack,{name:'today',iconName:'sun',title:'今日进度',sub:`${dateFormat.format(new Date())} · 对比近期日均`,badge:'',hue:'tone-accent'});
    const box=el(c.body,'div','aw-today'),range=this.plugin.data.settings.range;
    const read=()=>Dash.todayProgress(this.plugin.data,new Date(),range);
    this.live(read,t=>{
      c.pill.textContent=`${number(t.score)} 分`;box.replaceChildren();
      for(const [key,label,value,avg,unit] of [['characters','新增字数',t.characters,t.avgCharacters,'字'],['minutes','编辑时长',t.minutes,t.avgMinutes,'分钟']]){
        const row=tint(el(box,'div','aw-progress-row'),HUES[key]),top=el(row,'div','aw-progress-top');
        el(top,'span','aw-progress-label',label);
        const v=el(top,'span','aw-progress-value');el(v,'strong','',number(value));el(v,'span','aw-unit',unit);
        const ratio=avg?value/avg:0,bar=el(row,'div','aw-progress');bar.setAttribute('role','presentation');
        el(bar,'i').style.setProperty('--aw-progress',String(Math.min(1,ratio)));
        el(row,'div','aw-progress-note',avg?`日均 ${number(avg)} ${unit} · ${Math.round(ratio*100)}%`:'近期还没有可对比的活跃日');
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
    const c=card(stack,{name:'trend',iconName:'trending-up',title:'活跃趋势',sub:`最近 ${n} 天 · 每日贡献分与 7 日均线`,badge:'',hue:HUES.score});
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
    const c=card(stack,{name:'months',iconName:'calendar-range',title:'月度贡献',sub:'最近 6 个月 · 贡献分',badge:'',hue:HUES.score});
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
      const total=bars.reduce((s,b)=>s+b.score,0),active=bars.reduce((s,b)=>s+b.active,0);
      el(c.body,'p','aw-bars-note',`6 个月合计 ${number(Math.round(total*10)/10)} 分 · ${active} 天活跃`);
    });
  }
  renderPulse(stack){
    const data=this.plugin.data,settings=data.settings,metric=metricOf(settings.metric);
    const c=card(stack,{name:'pulse',iconName:'calendar-days',title:'年度活跃热力图',sub:`${metric.label} · 强度按个人近期分位数`,badge:'',hue:HUES[metric.key]});
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
module.exports={WorkbenchView,VIEW,NAME,viewIcon,overview,modifiedLabel,csv,months};

},
"features/dashboard-data.js":(module,exports,__awRequire)=>{
'use strict';
// Numbers behind the dashboard's charts. Pure: data in, plain values out.
const Core=__awRequire("core.js");
const round1=n=>Math.round(n*10)/10;

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
// Today against the mean of the active days before it within the range.
function todayProgress(data,now,range){
  const today=data.days[Core.dayKey(now)];
  const before=Core.lastDays(Core.shiftDay(now,-1),range).map(d=>data.days[d]).filter(d=>Core.dayScore(d)>0);
  const mean=key=>before.length?round1(before.reduce((sum,d)=>sum+Core.metricValue(d,key),0)/before.length):null;
  return {score:Core.dayScore(today),characters:today?.characters||0,minutes:today?.minutes||0,focus:today?.focus||0,
    notes:today?.notes||0,tasks:today?.tasks||0,avgCharacters:mean('characters'),avgMinutes:mean('minutes')};
}
// The last six months, oldest first, from the monthly rows (newest first).
function monthBars(rows){
  const list=rows.slice(0,6).reverse(),best=Math.max(0,...list.map(r=>r.score));
  return list.map((r,i)=>({month:r.month,score:round1(r.score),active:r.active,ratio:best>0?r.score/best:0,current:i===list.length-1}));
}
module.exports={trendSeries,niceMax,smoothPath,todayProgress,monthBars};

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
      d.addOptions({single:'单张图片','grid-1':'多图 · 1 列','grid-2':'多图 · 2 列','grid-3':'多图 · 3 列','grid-4':'多图 · 4 列','mosaic-left':'多图 · 大图在左（一大多小）','mosaic-right':'多图 · 大图在右（一大多小）'}).setValue(this.layout).onChange(value=>{
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
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.documents=new Map();this.decorated=new WeakSet();this.gesture=null;}
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
  // Reading view (and rendered callouts in Live Preview): label captions and remember
  // which source line each figure starts on.
  process(el,ctx){
    const titles=[...el.querySelectorAll(CAPTIONED)];
    if(el.matches?.(CAPTIONED))titles.push(el);
    titles.forEach(markLabel);
    const info=ctx?.getSectionInfo?.(el);
    if(!info)return;
    const figures=[...el.querySelectorAll(FIGURE)];
    if(el.matches?.(FIGURE))figures.push(el);
    for(const figure of figures){figure.dataset.awLine=String(info.lineStart);figure.dataset.awSource=ctx.sourcePath;}
  }
  hover(event){
    if(!this.enabled()||this.gesture)return;
    const figure=event.target?.closest?.(FIGURE);
    if(!figure||this.decorated.has(figure)||!figure.closest('.markdown-preview-view,.markdown-source-view'))return;
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
      if(!await this.edit(figure,(lines,block)=>Edit.setWidth(lines,block,index,final)))preview();
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
    this.gesture.onEnd=()=>{if(to>=0&&to!==from)void this.edit(figure,(lines,block)=>Edit.moveImage(lines,block,from,to));};
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
  // Live Preview edits go through the editor (undoable); reading view edits rewrite
  // the file after checking the recorded block is still where it was rendered.
  locate(figure){
    if(figure.closest('.markdown-source-view')){
      const view=this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).find(v=>v?.containerEl?.contains(figure));
      const editor=view?.editor,cm=editor?.cm;
      if(!editor||typeof cm?.posAtDOM!=='function')return null;
      const line=cm.state.doc.lineAt(cm.posAtDOM(figure)).number-1;
      return {apply:change=>{
        const lines=editor.getValue().split('\n'),block=Edit.findBlock(lines,line);
        if(!block)throw Error('这里不是插图块。');
        const next=change(lines,block);
        editor.replaceRange(next.slice(block.start,block.end+1).join('\n'),{line:block.start,ch:0},{line:block.end,ch:lines[block.end].length});
      }};
    }
    const line=Number(figure.dataset.awLine),file=this.app.vault.getAbstractFileByPath(figure.dataset.awSource||'');
    if(!Number.isInteger(line)||!(file instanceof TFile))return null;
    return {apply:change=>this.app.vault.process(file,data=>{
      const eol=data.includes('\r\n')?'\r\n':'\n',lines=data.split(eol),block=Edit.findBlock(lines,line);
      if(!block||block.start!==line)throw Error('笔记内容已变化，请刷新后重试。');
      return change(lines,block).join(eol);
    })};
  }
  // Resolves true once the change is written, false after showing why it wasn't.
  async edit(figure,change){
    try{
      const located=this.locate(figure);
      if(!located){new Notice('无法定位这张插图的源码，请在编辑或阅读视图中重试。');return false;}
      await located.apply(change);
      return true;
    }catch(error){new Notice(error?.message||'修改插图失败。');return false;}
  }
  displaySettings(container){
    new Setting(container).setName('插图编辑工具').setDesc('悬停插图时显示布局工具条；拖动右下角圆点调整宽度（单图靠近 1/4、1/3、1/2、2/3、3/4、整列时吸附）；拖动左上角手柄：多图组移动图片位置，单图移到左、中、右对齐。拖动时会显示目标位置的轮廓，按 Esc 取消。修改直接写回 Markdown。')
      .addToggle(t=>t.setValue(this.enabled()).onChange(v=>{this.plugin.data.settings.figureTools=v;this.plugin.applyAppearanceEverywhere();this.plugin.changed();}));
  }
}
module.exports={FigureTools,markLabel,nearestSlot,snapWidth};

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
  const images=[];
  for(let i=start+1;i<=end;i++){
    const found=imagesIn(lines[i]);
    if(found.length===1)images.push({line:i,width:found[0].width});
  }
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
  const text=lines[image.line],[found]=imagesIn(text),next=lines.slice();
  next[image.line]=text.slice(0,found.index)+replaceWidth(found.text,width)+text.slice(found.index+found.text.length);
  return next;
}
function setMeta(lines, block, meta) {
  if(!LAYOUT.test(meta))throw Error('不支持的布局。');
  const grid=isGroup(meta),wasGrid=isGroup(block.meta);
  if(grid!==wasGrid)throw Error(grid?'单图不能切换为多图布局。':'多图组只能切换多图布局。');
  const next=lines.slice();
  next[block.start]=`${block.prefix}[!figure|${meta}]${block.fold}${block.caption}`;
  return next;
}
// Reorder image lines only; captions, blank quoted lines and other content stay put.
function moveImage(lines, block, from, to) {
  const slots=block.images.map(image=>image.line);
  const valid=i=>Number.isInteger(i)&&i>=0&&i<slots.length;
  if(!valid(from)||!valid(to))throw Error('找不到要移动的图片。');
  const order=slots.map(line=>lines[line]),[moved]=order.splice(from,1);order.splice(to,0,moved);
  const next=lines.slice();
  slots.forEach((line,i)=>{next[line]=order[i];});
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
const {Component,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
const {parseAnnotation,findAnnotations}=__awRequire("features/annotation-format.js");

// "<--- note" in a handwriting face, placed after the highlighted text.
function noteNode(doc,note){
  const span=doc.createElement('span');span.className='aw-annot';span.title='批注：'+note;
  const arrow=doc.createElement('span');arrow.className='aw-annot-arrow';arrow.textContent='<---';arrow.setAttribute('aria-hidden','true');
  span.appendChild(arrow);span.appendChild(doc.createTextNode(note));
  return span;
}
const livePreview=state=>!editorLivePreviewField||state.field(editorLivePreviewField,false)===true;

// Live Preview: {note} becomes the handwritten widget unless the cursor is on the annotation,
// in which case the source stays editable (as Obsidian does for its own formatting).
function editorExtension(){
  class NoteWidget extends WidgetType{
    constructor(note){super();this.note=note;}
    eq(other){return other.note===this.note;}
    toDOM(view){return noteNode(view.dom.ownerDocument,this.note);}
  }
  const build=view=>{
    if(!livePreview(view.state))return Decoration.none;
    const doc=view.state.doc,ranges=view.state.selection.ranges,seen=new Map();
    for(const {from,to} of view.visibleRanges){
      // Whole lines, so a match is never cut at the viewport edge.
      const start=doc.lineAt(from).from,end=doc.lineAt(to).to;
      for(const a of findAnnotations(view.state.sliceDoc(start,end),start))seen.set(a.from,a);
    }
    const decorations=[...seen.values()].sort((a,b)=>a.from-b.from).map(a=>{
      const editing=ranges.some(r=>r.from<=a.to&&r.to>=a.markFrom);
      return (editing?Decoration.mark({class:'aw-annot-source'}):Decoration.replace({widget:new NoteWidget(a.note)})).range(a.from,a.to);
    });
    return Decoration.set(decorations);
  };
  return ViewPlugin.fromClass(class{
    constructor(view){this.decorations=build(view);}
    update(update){
      if(update.docChanged||update.viewportChanged||update.selectionSet||livePreview(update.startState)!==livePreview(update.state))
        this.decorations=build(update.view);
    }
  },{decorations:plugin=>plugin.decorations});
}

class Annotations extends Component{
  constructor(plugin){super();this.plugin=plugin;}
  onload(){
    this.plugin.registerMarkdownPostProcessor(el=>this.process(el));
    this.plugin.registerEditorExtension(editorExtension());
  }
  // Reading view: Obsidian renders ==text== as <mark>; the {note} is the text right after it.
  process(el){
    for(const mark of el.querySelectorAll('mark')){
      const next=mark.nextSibling;
      if(!next||next.nodeType!==3)continue;
      const found=parseAnnotation(next.textContent);
      if(!found)continue;
      next.textContent=found.rest;
      mark.parentNode.insertBefore(noteNode(el.ownerDocument,found.note),next);
    }
  }
}
module.exports={Annotations,noteNode};

},
"features/annotation-format.js":(module,exports,__awRequire)=>{
'use strict';
// Margin-style annotations: ==highlighted text=={note}. The note sits right after the closing
// == with no space, on one line, up to 80 characters. Nothing here touches the DOM.
const NOTE=/^\{([^{}\n]{1,80})\}/;
const SOURCE=/==([^=\n]+)==\{([^{}\n]{1,80})\}/g;

// Reading view: the text that follows a rendered <mark>.
function parseAnnotation(text) {
  const m=NOTE.exec(text||'');
  if(!m||!m[1].trim())return null;
  return {note:m[1].trim(),rest:text.slice(m[0].length)};
}
// Live Preview: offsets of every {note} in a stretch of source text.
function findAnnotations(text, offset=0) {
  const found=[];
  for(const m of text.matchAll(SOURCE)){
    if(!m[2].trim())continue;
    const to=m.index+m[0].length,from=to-m[2].length-2;
    found.push({markFrom:offset+m.index,from:offset+from,to:offset+to,note:m[2].trim()});
  }
  return found;
}
module.exports={parseAnnotation,findAnnotations};

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

// A thin tick ruler on the right of each note: a dot marks the reading position
// with its fraction beside it; click or drag the ruler to jump.
class ScrollRuler extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;this.entries=new Map();}
  onload(){
    for(const event of ['layout-change','active-leaf-change','file-open','resize'])this.registerEvent(this.app.workspace.on(event,()=>this.sync()));
    this.app.workspace.onLayoutReady(()=>this.sync());
  }
  onunload(){for(const view of [...this.entries.keys()])this.detach(view);}
  enabled(){return this.plugin.data.settings.scrollRuler!==false;}
  sync(){
    const views=this.enabled()?this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).filter(v=>v instanceof MarkdownView):[];
    for(const view of [...this.entries.keys()])if(!views.includes(view)||!view.contentEl?.isConnected)this.detach(view);
    for(const view of views){if(!this.entries.has(view))this.attach(view);this.update(view);}
  }
  attach(view){
    const host=view.contentEl,doc=host.ownerDocument,owner=this.addChild(new Component());
    const el=doc.createElement('div');el.className='aw-ruler';el.setAttribute('aria-hidden','true');
    const knob=doc.createElement('div');knob.className='aw-ruler-knob';
    const label=doc.createElement('span');label.className='aw-ruler-label';
    knob.appendChild(label);el.appendChild(knob);host.appendChild(el);host.classList.add('aw-has-ruler');
    const entry={owner,el,knob,label,frame:0};this.entries.set(view,entry);
    // scroll does not bubble; capture it from whichever scroller the current mode uses.
    owner.registerDomEvent(host,'scroll',()=>this.schedule(view),{capture:true});
    owner.registerDomEvent(el,'pointerdown',event=>this.drag(view,event));
  }
  detach(view){
    const entry=this.entries.get(view);if(!entry)return;
    cancelAnimationFrame(entry.frame);entry.el.remove();view.contentEl?.classList.remove('aw-has-ruler');
    this.removeChild(entry.owner);this.entries.delete(view);
  }
  scroller(view){
    const preview=view.getMode?.()==='preview';
    return view.contentEl.querySelector(preview?'.markdown-reading-view .markdown-preview-view':'.markdown-source-view .cm-scroller');
  }
  schedule(view){
    const entry=this.entries.get(view);
    if(entry&&!entry.frame)entry.frame=requestAnimationFrame(()=>{entry.frame=0;this.update(view);});
  }
  update(view){
    const entry=this.entries.get(view),s=entry&&this.scroller(view);
    if(!entry)return;
    const progress=s?progressOf(s.scrollTop,s.scrollHeight,s.clientHeight):null;
    entry.el.classList.toggle('is-idle',progress===null);
    if(progress===null)return;
    entry.knob.style.top=`${(progress*100).toFixed(2)}%`;entry.label.textContent=progress.toFixed(2);
  }
  drag(view,event){
    const entry=this.entries.get(view),s=this.scroller(view);
    if(!entry||!s||event.button!==0)return;
    event.preventDefault();
    const doc=entry.el.ownerDocument,jump=e=>{
      const rect=entry.el.getBoundingClientRect();
      s.scrollTop=topFor((e.clientY-rect.top)/rect.height,s.scrollHeight,s.clientHeight);
    };
    jump(event);entry.el.classList.add('is-dragging');
    const up=()=>{doc.removeEventListener('pointermove',jump);doc.removeEventListener('pointerup',up);entry.el.classList.remove('is-dragging');};
    doc.addEventListener('pointermove',jump);doc.addEventListener('pointerup',up);
  }
  displaySettings(container,Setting){
    new Setting(container).setName('滚动刻度尺').setDesc('在笔记右侧显示阅读位置刻度；可点击或拖动跳转。')
      .addToggle(t=>t.setValue(this.plugin.data.settings.scrollRuler!==false).onChange(v=>{this.plugin.data.settings.scrollRuler=v;this.sync();this.plugin.changed();}));
  }
}
module.exports={ScrollRuler,progressOf,topFor};

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

}};
const __awCache=Object.create(null);
function __awRequire(id){if(__awCache[id])return __awCache[id].exports;const m={exports:{}};__awCache[id]=m;__awModules[id](m,m.exports,__awRequire);return m.exports;}
module.exports=__awRequire("main.js");
