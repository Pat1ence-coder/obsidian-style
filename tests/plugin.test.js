'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const Core=require('../src/core');
function fixture() {
  const notices=[], timers=new Map(), handlers={}; let timerId=0;
  class Component {
    registerEvent(){} registerDomEvent(){}
    addChild(child){child.onload?.();return child;}
    removeChild(child){child.onunload?.();}
  }
  class Plugin extends Component {
    async loadData(){return this.initialData??null;}
    async saveData(data){this.saved.push(data);}
    registerView(type,create){this.makeView=create;}
    addRibbonIcon(){} addCommand(command){(this.commands??={})[command.id]=command;} addSettingTab(){}
    registerEditorExtension(ext){this.extension=ext;} registerEvent(){} registerInterval(){}
    registerMarkdownPostProcessor(fn){(this.postProcessors??=[]).push(fn);}
  }
  class TFile {constructor(path){this.path=path;this.extension='md';}}
  const fakeDoc=()=>{const set=new Set(['theme-light']);return {classes:set,body:{classList:{add:n=>set.add(n),remove:n=>set.delete(n),[Symbol.iterator]:()=>set.values()}}};};
  const main=fakeDoc(),classes=main.classes,leaves=[];
  const workspace={containerEl:{ownerDocument:main},on(){return {};},iterateAllLeaves(fn){leaves.forEach(fn);},
    onLayoutReady(fn){(this.readyFns??=[]).push(fn);this.ready=()=>this.readyFns.forEach(f=>f());},getLeavesOfType(){return [];},detachLeavesOfType(){this.detached=true;}};
  const mod={exports:{}};
  const context={module:mod,require:name=>{
    if(name==='obsidian')return {Plugin,Component,TFile,TFolder:class{},Platform:{isMacOS:true},Modal:class{},FuzzySuggestModal:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Notice:class{constructor(text){notices.push(text);}},setIcon(){},editorInfoField:'info'};
    if(name==='@codemirror/view')return {EditorView:{updateListener:{of:fn=>fn}}};
    throw Error(name);
  },window:{setInterval:()=>1},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),console,Intl,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/algorithm-workbench/main.js'),'utf8'),context);
  const plugin=new mod.exports();plugin.saved=[];plugin.app={workspace,vault:{on:(name,fn)=>{(handlers[name]??=[]).push(fn);return {};}}};
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

  return {plugin,workspace,notices,update,docs,timers,handlers,TFile,classes,fakeDoc,leaves};
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
test('pause does not backfill; unload stops updates and closes views',async()=>{
  const {plugin,workspace,update}=fixture();await plugin.onload();
  plugin.data.settings.tracking=false;plugin.extension(update('','不会计入'));
  assert.equal(Object.keys(plugin.data.days).length,0);
  plugin.data.settings.tracking=true;plugin.extension(update('不会计入','不会计入新'));
  assert.equal(plugin.data.days[Core.dayKey()].characters,1);
  plugin.onunload();plugin.extension(update('不会计入新','不会计入新又一个'));
  assert.equal(plugin.data.days[Core.dayKey()].characters,1);
  assert.ok(workspace.detached);await plugin.saveQueue;
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
test('invalid existing data aborts loading without replacing it',async()=>{
  const {plugin,notices}=fixture();plugin.initialData={version:3};
  await assert.rejects(()=>plugin.onload());assert.equal(plugin.saved.length,0);assert.equal(notices.length,1);
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
test('new notes count only after the vault finishes loading, outside excluded folders',async()=>{
  const {plugin,workspace,handlers,TFile}=fixture();await plugin.onload();plugin.data.settings.openOnStartup=false;
  for(const fn of handlers.create)fn(new TFile('启动扫描.md'));
  assert.equal(plugin.data.days[Core.dayKey()],undefined);
  workspace.ready();
  for(const fn of handlers.create){fn(new TFile('新笔记.md'));fn(new TFile('Templates/模板.md'));}
  assert.equal(plugin.data.days[Core.dayKey()].notes,1);
  plugin.onunload();await plugin.saveQueue;
});

test('palette is a body class: applied on load, switched in place, cycled by command, removed on unload',async()=>{
  const {plugin,classes,notices}=fixture();plugin.initialData={...Core.emptyData(),settings:{...Core.DEFAULT_SETTINGS,palette:'celadon'}};
  await plugin.onload();
  assert.deepEqual([...classes].sort(),['aw-caption-normal','aw-palette-celadon','theme-light']);
  plugin.setPalette('sand');assert.ok(classes.has('aw-palette-sand'));assert.ok(!classes.has('aw-palette-celadon'));
  plugin.setPalette('neon');assert.equal(plugin.data.settings.palette,'sand');
  plugin.commands['cycle-palette'].callback();assert.equal(plugin.data.settings.palette,'celadon');assert.match(notices.at(-1),/青瓷/);
  plugin.commands['cycle-palette'].callback();assert.equal(plugin.data.settings.palette,'sea');assert.ok(classes.has('aw-palette-sea'));
  await plugin.flush();assert.equal(plugin.saved.at(-1).settings.palette,'sea');
  plugin.onunload();assert.deepEqual([...classes],['theme-light']);await plugin.saveQueue;
});

test('popout windows already open, or restored with the layout, follow the palette',async()=>{
  const {plugin,workspace,fakeDoc,leaves}=fixture();
  const existing=fakeDoc(),restored=fakeDoc();leaves.push({view:{containerEl:{ownerDocument:existing}}});
  await plugin.onload();plugin.data.settings.openOnStartup=false;
  assert.ok(existing.classes.has('aw-palette-sea'),'re-enabling the plugin reaches an open popout');
  leaves.push({view:{containerEl:{ownerDocument:restored}}});workspace.ready();
  assert.ok(restored.classes.has('aw-palette-sea'),'popouts restored with the layout are covered');
  plugin.setPalette('sand');
  for(const doc of [existing,restored])assert.deepEqual([...doc.classes].sort(),['aw-caption-normal','aw-palette-sand','theme-light']);
  plugin.onunload();for(const doc of [existing,restored])assert.deepEqual([...doc.classes],['theme-light']);
  await plugin.saveQueue;
});

test('caption size and figure tools are body classes that follow settings and leave on unload',async()=>{
  const {plugin,classes}=fixture();await plugin.onload();
  assert.equal(plugin.postProcessors.length,1,'caption labels are marked by a post processor');
  plugin.setCaptionSize('large');assert.ok(classes.has('aw-caption-large'));assert.ok(!classes.has('aw-caption-normal'));
  plugin.setCaptionSize('huge');assert.equal(plugin.data.settings.captionSize,'large');
  plugin.data.settings.figureTools=false;plugin.applyAppearanceEverywhere();assert.ok(classes.has('aw-figure-tools-off'));
  plugin.data.settings.figureTools=true;plugin.applyAppearanceEverywhere();assert.ok(!classes.has('aw-figure-tools-off'));
  await plugin.flush();assert.equal(plugin.saved.at(-1).settings.captionSize,'large');
  plugin.onunload();assert.deepEqual([...classes],['theme-light']);await plugin.saveQueue;
});
