'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const Core=require('../src/core');
// options.layoutReady: the layout is already up (plugin enabled in a running app), so
// onLayoutReady runs its callback at once, as Obsidian does.
function fixture(options={}) {
  const notices=[], timers=new Map(), delays=new Map(), handlers={}; let timerId=0;
  class Component {
    registerEvent(){} registerDomEvent(){}
    addChild(child){child.onload?.();return child;}
    removeChild(child){child.onunload?.();}
  }
  class Plugin extends Component {
    async loadData(){return this.initialData??null;}
    async saveData(data){this.saved.push(data);}
    registerView(type,create){(this.views??={})[type]=create;if(type==='algorithm-workbench')this.makeView=create;}
    addRibbonIcon(icon,title){(this.ribbons??=[]).push([icon,title]);} addCommand(command){(this.commands??={})[command.id]=command;} addSettingTab(){}
    registerEditorExtension(ext){(this.extensions??=[]).push(ext);if(typeof ext==='function')this.extension??=ext;} registerEvent(){} registerInterval(){}
    registerMarkdownPostProcessor(fn){(this.postProcessors??=[]).push(fn);}
  }
  class TFile {constructor(path){this.path=path;this.extension='md';}}
  const fakeDoc=()=>{const set=new Set(['theme-light']),props=new Map();return {classes:set,props,body:{classList:{add:n=>set.add(n),remove:n=>set.delete(n),[Symbol.iterator]:()=>set.values()},style:{setProperty:(k,v)=>props.set(k,v),removeProperty:k=>props.delete(k)}}};};
  const main=fakeDoc(),classes=main.classes,leaves=[];
  const workspace={containerEl:{ownerDocument:main},on(name,fn){(handlers['workspace:'+name]??=[]).push(fn);return {};},iterateAllLeaves(fn){leaves.forEach(fn);},
    onLayoutReady(fn){if(options.layoutReady){fn();return;}(this.readyFns??=[]).push(fn);this.ready=()=>this.readyFns.forEach(f=>f());},getLeavesOfType(){return [];},detachLeavesOfType(){this.detached=true;}};
  const mod={exports:{}};
  const context={module:mod,require:name=>{
    if(name==='obsidian')return {Plugin,Component,TFile,TFolder:class{},Platform:{isMacOS:true},Modal:class{},FuzzySuggestModal:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Notice:class{constructor(text){notices.push(text);}},setIcon(){},MarkdownView:class{},editorInfoField:'info'};
    if(name==='@codemirror/language')return {syntaxTree:()=>({resolveInner:()=>({type:{name:'Document'}})})};
    if(name==='@codemirror/view')return {EditorView:{updateListener:{of:fn=>fn}},ViewPlugin:{fromClass:(cls,spec)=>({cls,spec})},Decoration:{none:[],set:list=>list,mark:spec=>({spec,range:(from,to)=>({from,to,spec})}),replace:spec=>({spec,range:(from,to)=>({from,to,spec})})},WidgetType:class{}};
    throw Error(name);
  },window:{setInterval:()=>1},setTimeout:(fn,ms)=>{timers.set(++timerId,fn);delays.set(timerId,ms);return timerId;},clearTimeout:id=>timers.delete(id),console,Intl,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/algorithm-workbench/main.js'),'utf8'),context);
  const plugin=new mod.exports();plugin.saved=[];plugin.app={workspace,metadataCache:{on:(name,fn)=>{(handlers['metadata:'+name]??=[]).push(fn);return {};},getFileCache:()=>null},vault:{getAbstractFileByPath:()=>null,on:(name,fn)=>{(handlers[name]??=[]).push(fn);return {};}}};
  const docs=new Map();
  const doc=text=>{
    if(!docs.has(text))docs.set(text,{length:text.length,scans:0,toString(){this.scans++;return text;},sliceString:(a,b)=>text.slice(a,b),
      lineAt:pos=>({from:text.lastIndexOf('\n',pos-1)+1,to:text.indexOf('\n',pos)<0?text.length:text.indexOf('\n',pos)})});
    return docs.get(text);
  };
  const update=(before,after,user=true,filePath='note.md',event='input.type')=>{
    let a=0;while(a<before.length&&a<after.length&&before[a]===after[a])a++;
    let endA=before.length,endB=after.length;
    while(endA>a&&endB>a&&before[endA-1]===after[endB-1]){endA--;endB--;}
    return {docChanged:true,state:{field:()=>({file:new TFile(filePath)})},transactions:[{
      docChanged:true,isUserEvent:type=>user&&(event===type||event.startsWith(type+'.')),startState:{doc:doc(before)},newDoc:doc(after),
      changes:{iterChanges:fn=>fn(a,endA,a,endB,{toString:()=>after.slice(a,endB)})}
    }]};
  };

  return {plugin,workspace,notices,update,docs,timers,delays,handlers,TFile,classes,fakeDoc,leaves};
}
test('bundled plugin loads, counts actual transactions, filters folders and saves',async()=>{
  const {plugin,update}=fixture();await plugin.onload();
  plugin.extension(update('已有文字','已有文字新增😀'));
  plugin.extension(update('已有文字新增😀','已有文字新增😀同步内容',false));
  plugin.extension(update('','模板不计数',true,'Templates/t.md'));
  await plugin.flush();
  const today=Core.dayKey();assert.equal(plugin.data.days[today].characters,3);
  assert.equal(plugin.saved.at(-1).days[today].characters,3);
  assert.equal(JSON.stringify(plugin.saved).includes('已有文字'),false);
  plugin.onunload();await plugin.saveQueue;
});
test('pause does not backfill; unload stops updates and leaves the workbench tabs in place',async()=>{
  const {plugin,workspace,update}=fixture();await plugin.onload();
  plugin.data.settings.tracking=false;plugin.extension(update('','不会计入'));
  assert.equal(Object.keys(plugin.data.days).length,0);
  plugin.data.settings.tracking=true;plugin.extension(update('不会计入','不会计入新'));
  assert.equal(plugin.data.days[Core.dayKey()].characters,1);
  plugin.onunload();plugin.extension(update('不会计入新','不会计入新又一个'));
  assert.equal(plugin.data.days[Core.dayKey()].characters,1);
  assert.ok(!workspace.detached,'an update brings the tab back where it was');await plugin.saveQueue;
});
test('writes are serialized and a failed write can recover',async()=>{
  const {plugin}=fixture();await plugin.onload();
  let active=0,max=0,attempts=0;
  plugin.saveData=async data=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;attempts++;if(attempts===1)throw Error('disk full');plugin.saved.push(data);};
  await plugin.flush();assert.equal(plugin.saveError,true);
  await plugin.flush();
  assert.equal(max,1);assert.equal(plugin.saveError,false);assert.equal(plugin.saved.length,1);
  plugin.onunload();await plugin.saveQueue;
});
test('invalid existing data aborts loading without replacing it, and backs up unreadable files on disk',async()=>{
  const {plugin,notices}=fixture();plugin.initialData={version:3};
  await assert.rejects(()=>plugin.onload());assert.equal(plugin.saved.length,0);assert.equal(notices.length,1);
  await plugin.flush();assert.equal(plugin.saved.length,0,'read-only lock prevents later writes');
  // Unparseable JSON on disk: Obsidian's loadData() returns undefined; adapter backs it up aside.
  const u=fixture(),disk=new Map([['.obsidian/plugins/algorithm-workbench/data.json','<<<<<<< HEAD\n{"days":']] );
  u.plugin.loadData=async()=>undefined;
  u.plugin.app.vault.adapter={exists:async p=>disk.has(p),read:async p=>disk.get(p),write:async(p,v)=>{disk.set(p,v);}};
  await assert.rejects(()=>u.plugin.onload());
  assert.equal(u.plugin.saved.length,0,'broken data.json is never overwritten');
  const backups=[...disk.keys()].filter(k=>k.includes('.unreadable-'));
  assert.equal(backups.length,1);assert.equal(disk.get(backups[0]),'<<<<<<< HEAD\n{"days":');
  assert.match(u.notices[0],/unreadable-/);
  // A 0-byte truncated file where loadData() returned null is also caught when the file exists on disk.
  const z=fixture(),zdisk=new Map([['.obsidian/plugins/algorithm-workbench/data.json','']]);
  z.plugin.app.vault.adapter={exists:async p=>zdisk.has(p),read:async p=>zdisk.get(p),write:async(p,v)=>{zdisk.set(p,v);}};
  await assert.rejects(()=>z.plugin.onload());assert.equal(z.plugin.saved.length,0);
  assert.equal([...zdisk.keys()].filter(k=>k.includes('.unreadable-')).length,1);
});

test('10,000 save requests during a stalled write coalesce into one latest snapshot',async()=>{
  const {plugin}=fixture();await plugin.onload();
  const writes=[], releases=[];
  plugin.saveData=data=>{writes.push(data);return new Promise(resolve=>releases.push(resolve));};
  const pending=plugin.flush();
  for(let i=0;i<10000;i++){
    plugin.data.settings.recentLimit=i;
    assert.equal(plugin.flush(),pending);
  }
  assert.equal(writes.length,1);
  releases.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,2);assert.equal(writes[1].settings.recentLimit,9999);
  releases.shift()();await pending;
  assert.equal(plugin.saving,false);assert.equal(plugin.saveRequested,false);
  assert.equal(writes.length,2);
});
test('unload retains the final update while an earlier save is pending',async()=>{
  const {plugin,timers}=fixture();await plugin.onload();
  const writes=[], releases=[];
  plugin.saveData=data=>{writes.push(data);return new Promise(resolve=>releases.push(resolve));};
  const pending=plugin.flush();plugin.data.settings.recentLimit=20;plugin.onunload();
  assert.equal(timers.size,0);
  releases.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,2);assert.equal(writes[1].settings.recentLimit,20);
  releases.shift()();await pending;
});
test('successive edits count only the change ranges after the initial document scan',async()=>{
  const {plugin,update,docs}=fixture();await plugin.onload();
  const text='算法文档'.repeat(25000);
  plugin.extension(update(text,text+'甲'));
  plugin.extension(update(text+'甲',text+'甲乙'));
  assert.equal([...docs.values()].reduce((sum,d)=>sum+d.scans,0),1);
  assert.equal(plugin.data.days[Core.dayKey()].characters,2);
  plugin.onunload();await plugin.saveQueue;
});
test('no refresh timer is created without a workbench, and hidden views skip updates',async()=>{
  const {plugin,workspace,timers}=fixture();await plugin.onload();await plugin.flush();
  plugin.scheduleRefresh();assert.equal(timers.size,0);
  let refreshes=0;workspace.getLeavesOfType=()=>[{view:{refresh(){refreshes++;}}}];
  plugin.scheduleRefresh();plugin.scheduleRefresh();assert.equal(timers.size,1);
  const callback=[...timers.values()][0];timers.clear();callback();assert.equal(refreshes,1);
  const view=plugin.makeView({});view.contentEl={getClientRects:()=>[]};
  view.refresh(); // No render or DOM reads on a hidden view.
  plugin.onunload();await plugin.saveQueue;
});

test('closing the view releases retained DOM references',async()=>{
  const {plugin}=fixture();await plugin.onload();
  const view=plugin.makeView({});let cleared=false;
  view.contentEl={replaceChildren(){cleared=true;}};
  view.dayEl={};view.recentEl={};view.statNumbers=[{}];view.heatCells=new Map([['date',{}]]);
  await view.onClose();
  assert.equal(cleared,true);assert.equal(view.dayEl,null);assert.equal(view.recentEl,null);
  assert.equal(view.statNumbers,null);assert.equal(view.heatCells,null);
  plugin.onunload();await plugin.saveQueue;
});

test('checked tasks count once per file and day; pasted lists do not count',async()=>{
  const {plugin,update}=fixture();await plugin.onload();const today=Core.dayKey();
  plugin.extension(update('- [ ] 推导\n- [ ] 实验','- [x] 推导\n- [ ] 实验'));
  plugin.extension(update('- [x] 推导\n- [ ] 实验','- [ ] 推导\n- [ ] 实验'));
  plugin.extension(update('- [ ] 推导\n- [ ] 实验','- [x] 推导\n- [ ] 实验'));
  assert.equal(plugin.data.days[today].tasks,1);
  plugin.extension(update('- [x] 推导\n- [ ] 实验','- [x] 推导\n- [ ] 实验\n- [x] 粘贴\n- [x] 粘贴',true,'note.md','input.paste'));
  assert.equal(plugin.data.days[today].tasks,1);
  // A checkbox click may carry no user-event annotation; a one-character toggle still counts.
  plugin.extension(update('- [x] 推导\n- [ ] 实验\n- [x] 粘贴\n- [x] 粘贴','- [x] 推导\n- [x] 实验\n- [x] 粘贴\n- [x] 粘贴',false));
  assert.equal(plugin.data.days[today].tasks,2);
  assert.ok(plugin.data.days[today].minutes>=1);
  plugin.onunload();await plugin.saveQueue;
});
test('new notes count only after the vault finishes loading, when opened right away, outside excluded folders',async()=>{
  const {plugin,workspace,handlers,TFile}=fixture();await plugin.onload();plugin.data.settings.openOnStartup=false;
  for(const fn of handlers.create||[])fn(new TFile('启动扫描.md'));
  assert.equal(plugin.data.days[Core.dayKey()],undefined);
  workspace.ready();
  const create=path=>{const file=new TFile(path);for(const fn of handlers.create)fn(file);return file;};
  const open=file=>{for(const fn of handlers['workspace:file-open'])fn(file);};
  const notes=()=>plugin.data.days[Core.dayKey()]?.notes??0;
  // Created and opened by Obsidian (new note, link, daily note): one new note, counted once.
  const made=create('新笔记.md');open(made);open(made);open(null);
  assert.equal(notes(),1);
  // Arrived by Sync, git or the file manager: created, never opened.
  for(let i=0;i<150;i++)create(`同步/${i}.md`);
  assert.equal(notes(),1);
  open(create('Templates/模板.md'));assert.equal(notes(),1,'excluded folder');
  // Opened long after it arrived: not a new note. Files never opened are dropped as time passes.
  const synced=create('同步/稍后打开.md'),now=Date.now;
  try{
    Date.now=()=>now()+60000;open(synced);assert.equal(notes(),1);
    create('同步/又一个.md');assert.deepEqual([...plugin.freshNotes.keys()],['同步/又一个.md']);
  }finally{Date.now=now;}
  plugin.onunload();await plugin.saveQueue;
});

test('appearance is a body class: applied on load, stale palette and style classes from older versions removed, all removed on unload',async()=>{
  const {plugin,classes}=fixture();classes.add('aw-palette-sand');classes.add('aw-style-card');
  plugin.initialData={...Core.emptyData(),settings:{...Core.DEFAULT_SETTINGS,palette:'celadon'}};
  await plugin.onload();
  assert.deepEqual([...classes].sort(),['aw-caption-normal','aw-glass','aw-glass-fog-normal','theme-light']);
  assert.equal(plugin.data.settings.palette,undefined,'the palette setting is gone');assert.equal(plugin.commands['cycle-palette'],undefined);
  assert.equal(plugin.commands['cycle-style'],undefined,'one interface style, no switch');assert.equal(plugin.setStyle,undefined);
  plugin.onunload();assert.deepEqual([...classes],['theme-light']);await plugin.saveQueue;
});

test('popout windows already open, or restored with the layout, follow the appearance',async()=>{
  const {plugin,workspace,fakeDoc,leaves}=fixture();
  const existing=fakeDoc(),restored=fakeDoc();leaves.push({view:{containerEl:{ownerDocument:existing}}});
  await plugin.onload();plugin.data.settings.openOnStartup=false;
  assert.ok(existing.classes.has('aw-caption-normal'),'re-enabling the plugin reaches an open popout');
  leaves.push({view:{containerEl:{ownerDocument:restored}}});workspace.ready();
  assert.ok(restored.classes.has('aw-caption-normal'),'popouts restored with the layout are covered');
  plugin.setCaptionSize('large');
  for(const doc of [existing,restored])assert.deepEqual([...doc.classes].sort(),['aw-caption-large','aw-glass','aw-glass-fog-normal','theme-light']);
  plugin.onunload();for(const doc of [existing,restored])assert.deepEqual([...doc.classes],['theme-light']);
  await plugin.saveQueue;
});

test('caption size and figure tools are body classes that follow settings and leave on unload',async()=>{
  const {plugin,classes}=fixture();await plugin.onload();
  assert.equal(plugin.postProcessors.length,2,'caption labels and annotations each use a post processor');
  plugin.setCaptionSize('large');assert.ok(classes.has('aw-caption-large'));assert.ok(!classes.has('aw-caption-normal'));
  plugin.setCaptionSize('huge');assert.equal(plugin.data.settings.captionSize,'large');
  plugin.data.settings.figureTools=false;plugin.applyAppearanceEverywhere();assert.ok(classes.has('aw-figure-tools-off'));
  plugin.data.settings.figureTools=true;plugin.applyAppearanceEverywhere();assert.ok(!classes.has('aw-figure-tools-off'));
  await plugin.flush();assert.equal(plugin.saved.at(-1).settings.captionSize,'large');
  plugin.onunload();assert.deepEqual([...classes],['theme-light']);await plugin.saveQueue;
});


test('ribbon and command use the 写作工作台 name and icon',async()=>{
  const {plugin}=fixture();await plugin.onload();
  assert.deepEqual(plugin.ribbons,[['notebook-pen','打开写作工作台'],['images','打开素材库']],'the workbench first, then the image library');
  assert.equal(plugin.commands['open-workbench'].name,'打开写作工作台');
  assert.equal(plugin.commands['open-library'].name,'打开素材库');
  assert.equal(typeof plugin.views['aw-library'],'function');
  plugin.onunload();await plugin.saveQueue;
});

test('window glass: on by default without any picture, in every window, switchable, and leaves cleanly',async()=>{
  const {plugin,classes,fakeDoc,leaves,workspace}=fixture();
  const main=workspace.containerEl.ownerDocument,popout=fakeDoc();leaves.push({view:{containerEl:{ownerDocument:popout}}});
  await plugin.onload();plugin.data.settings.openOnStartup=false;
  assert.equal(plugin.data.settings.glass,true);assert.equal('glassImage' in plugin.data.settings,false,'no picture setting any more');
  plugin.applyAppearanceEverywhere();
  for(const doc of [main,popout])assert.ok(doc.classes.has('aw-glass')&&doc.classes.has('aw-glass-fog-normal'));
  assert.equal(main.props.size,0,'the paper is drawn by the theme: no picture is passed in');
  plugin.data.settings.glassFog='strong';plugin.applyAppearanceEverywhere();
  assert.ok(classes.has('aw-glass-fog-strong')&&!classes.has('aw-glass-fog-normal'));
  plugin.data.settings.glassFog='bogus';plugin.applyAppearanceEverywhere();assert.ok(classes.has('aw-glass-fog-normal'));
  // Switched off: the white look, in every window.
  plugin.data.settings.glass=false;plugin.applyAppearanceEverywhere();
  for(const doc of [main,popout])assert.ok(![...doc.classes].some(c=>c.startsWith('aw-glass')));
  plugin.data.settings.glass=true;plugin.applyAppearanceEverywhere();assert.ok(popout.classes.has('aw-glass'));
  plugin.onunload();
  for(const doc of [main,popout]){assert.deepEqual([...doc.classes],['theme-light']);assert.equal(doc.props.size,0);}
  await plugin.saveQueue;
});

test('enabling the plugin in a running app (layout already ready) loads cleanly, glass included',async()=>{
  const {plugin,classes,notices}=fixture({layoutReady:true});
  plugin.initialData={...Core.emptyData(),settings:{...Core.DEFAULT_SETTINGS,openOnStartup:false}};
  await plugin.onload();
  assert.deepEqual(notices,[]);
  assert.ok(classes.has('aw-caption-normal')&&classes.has('aw-glass'));
  plugin.onunload();assert.deepEqual([...classes],['theme-light']);await plugin.saveQueue;
});

test('annotation font: a named face reaches every window as a CSS variable, unsafe characters stripped',async()=>{
  const {plugin,workspace}=fixture();const main=workspace.containerEl.ownerDocument;
  plugin.initialData={...Core.emptyData(),settings:{...Core.DEFAULT_SETTINGS,openOnStartup:false,annotFont:'"LXGW WenKai"; } body{x:1'}};
  await plugin.onload();
  assert.equal(plugin.data.settings.annotFont,'"LXGW WenKai"  bodyx:1','; { } are removed when settings load');
  assert.equal(main.props.get('--aw-annot-font'),'"LXGW WenKai"  bodyx:1');
  plugin.data.settings.annotFont='';plugin.applyAppearanceEverywhere();assert.equal(main.props.has('--aw-annot-font'),false);
  plugin.data.settings.annotFont='KaiTi';plugin.applyAppearanceEverywhere();
  plugin.onunload();assert.equal(main.props.size,0);await plugin.saveQueue;
});
test('typing statistics are saved every 10 s, settings soon after a change, and what waits is saved on quit',async()=>{
  const {plugin,update,timers,delays,handlers}=fixture();await plugin.onload();await plugin.flush();
  const saved=plugin.saved.length;
  plugin.extension(update('已有','已有文字'));
  assert.equal(delays.get(plugin.saveTimer),10000,'not several writes a second while typing');
  plugin.extension(update('已有文字','已有文字又'));
  assert.equal([...timers.keys()].filter(id=>delays.get(id)===10000).length,1,'one timer for a run of typing');
  plugin.changed();
  assert.equal(delays.get(plugin.saveTimer),750,'a setting change brings the save forward');
  plugin.extension(update('已有文字又','已有文字又一'));
  assert.equal(delays.get(plugin.saveTimer),750,'and typing does not push it back');
  // Obsidian quits by closing the window, without unloading plugins.
  const tasks=[];for(const fn of handlers['workspace:quit'])fn({add:fn=>tasks.push(fn())});
  assert.equal(tasks.length,1);await tasks[0];
  assert.equal(plugin.saved.length,saved+1);assert.equal(plugin.saved.at(-1).days[Core.dayKey()].characters,4,'文字 + 又 + 一');
  const idle=[];for(const fn of handlers['workspace:quit'])fn({add:fn=>idle.push(fn)});
  assert.equal(idle.length,0,'nothing waiting: quitting is not held up');
  plugin.onunload();await plugin.saveQueue;
});
