'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
function setup() {
  class Component {
    constructor(){this.children=[];this.listeners=[];}
    registerEvent(){}
    registerDomEvent(target,event,fn,capture){this.listeners.push({target,event,fn,capture});}
    addChild(c){this.children.push(c);c.onload?.();return c;}
    removeChild(c){c.unload();this.children=this.children.filter(x=>x!==c);}
    unload(){this.onunload?.();this.children.forEach(c=>c.unload());this.children=[];this.listeners=[];}
  }
  class TFolder {constructor(path){this.path=path;}}
  class TFile {constructor(path,parent){this.path=path;this.parent=parent;}}
  const platform={isMacOS:true}, notices=[],events={},files=new Map(),opened=[],created=[],createdFolders=[],revealed=[];
  const api={Component,TFile,TFolder,Platform:platform,Notice:class{constructor(t){notices.push(t);}},Setting:class{}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/folder-notes.js'),'utf8'),{module,require:()=>api,console});
  const document={defaultView:{}};
  const explorer={view:{containerEl:{ownerDocument:document}},setViewState:async state=>revealed.push(state)};
  let nativeCalls=0;
  const plugin={data:{settings:{folderNotes:true}},scheduleRefresh(){},addCommand(c){this.command=c;},app:{
    commands:{commands:{'file-explorer:new-file':{callback(){nativeCalls++;}},'file-explorer:new-folder':{callback(){nativeCalls++;}}}},
    workspace:{getLeavesOfType:type=>type==='file-explorer'?[explorer]:[],revealLeaf:async()=>{},onLayoutReady:fn=>fn(),containerEl:{ownerDocument:document},on:(name,fn)=>{events[name]=fn;return {};},getLeaf:()=>({openFile:async(file,options)=>{opened.push(file.path);opened.options=options;}})},
    vault:{createFolder:async p=>{if(files.has(p))throw Error('exists');const f=new TFolder(p);files.set(p,f);createdFolders.push(p);return f;},on:(name,fn)=>{events[name]=fn;return {};},getAbstractFileByPath:p=>files.get(p),create:async(p)=>{
      if(files.has(p))throw Error('exists');const f=new TFile(p);files.set(p,f);created.push(p);return f;
    }}
  }};
  files.set('/',new TFolder('/'));files.set('研究',new TFolder('研究'));files.set('研究/子目录',new TFolder('研究/子目录'));
  files.set('研究/a.md',new TFile('研究/a.md',files.get('研究')));
  const feature=new module.exports.FolderNotes(plugin);feature.onload();
  const click=(path,button=0)=>feature.handleClick({button,target:{closest:s=>s.includes('workspace-leaf')?{}:{getAttribute:()=>path}}});
  const invoke=(event={})=>plugin.app.commands.commands['file-explorer:new-file'].callback(event);

  return {feature,plugin,click,invoke,files,events,opened,created,createdFolders,revealed,notices,platform,document,get nativeCalls(){return nativeCalls;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('left-click folder then Cmd+N creates exactly one note there',async()=>{
  const f=setup();f.click('研究');await f.invoke();assert.equal(f.nativeCalls,0);
  assert.deepEqual(f.created,['研究/未命名.md']);assert.deepEqual([...f.opened],f.created);
  // Opened as Obsidian's own new note: focused even with "always focus new tabs" off, in the
  // editor even when notes open in reading view, with the title ready to rename.
  assert.deepEqual(JSON.parse(JSON.stringify(f.opened.options)),{active:true,state:{mode:'source'},eState:{rename:'all'}});
});
test('file selection follows its parent and existing notes are never overwritten',async()=>{
  const f=setup();f.click('研究/a.md');f.files.set('研究/未命名.md',{text:'preserve'});
  await f.feature.createNote();assert.deepEqual(f.created,['研究/未命名 1.md']);assert.equal(f.files.get('研究/未命名.md').text,'preserve');
});
test('unselected, disabled and right-click cases preserve the native command',async()=>{
  const f=setup();await f.invoke();f.click('研究',2);await f.invoke();assert.equal(f.nativeCalls,2);
  f.click('研究');f.plugin.data.settings.folderNotes=false;await f.invoke();assert.equal(f.nativeCalls,3);assert.equal(f.created.length,0);
});
test('repeat and concurrent create requests do not produce duplicate notes',async()=>{
  const f=setup();f.click('研究');f.invoke();f.invoke();f.invoke({repeat:true});await settle();assert.equal(f.created.length,1);
});
test('folder rename follows the selection; deleting the parent clears it',()=>{
  const f=setup();f.click('研究/子目录');f.events.rename({path:'论文'},'研究');assert.equal(f.feature.selectedPath,'论文/子目录');
  f.events.delete({path:'论文'});assert.equal(f.feature.selectedPath,null);f.invoke();assert.equal(f.nativeCalls,1);
});
test('folder disappearance leaves native behavior intact and does not create in a stale path',async()=>{
  const f=setup();f.click('研究');await f.invoke();
  f.files.delete('研究');await f.invoke();assert.equal(f.nativeCalls,1);assert.deepEqual(f.created,['研究/未命名.md']);
});
test('root selection is supported explicitly',async()=>{
  const f=setup();f.click('/');await f.feature.createNote();assert.deepEqual(f.created,['未命名.md']);
});
test('popout listeners are not duplicated and are released on window close/unload',()=>{
  const f=setup(),popup={document:{defaultView:{}}};
  f.events['window-open']({},popup);f.events['window-open']({},popup);
  assert.equal(f.feature.documents.size,2);assert.equal(f.feature.children.length,2);
  const owner=f.feature.documents.get(popup.document);assert.equal(owner.listeners.length,1);
  f.events['window-close']({},popup);assert.equal(owner.listeners.length,0);assert.equal(f.feature.documents.size,1);
  f.feature.unload();assert.equal(f.feature.documents.size,0);assert.equal(f.feature.children.length,0);assert.equal(f.feature.getFolder(),null);
});

test('unload restores the original command and cannot clobber another plugin wrapper',async()=>{
  const f=setup();f.click('研究');const cmd=f.plugin.app.commands.commands['file-explorer:new-file'];
  const hooked=cmd.callback;f.feature.unload();assert.notEqual(cmd.callback,hooked);await f.invoke();assert.equal(f.nativeCalls,1);
  const g=setup();const c=g.plugin.app.commands.commands['file-explorer:new-file'];const other=()=>{};c.callback=other;
  g.feature.unload();assert.equal(c.callback,other);
});

function toolbar(f,icon,options={}){
  const e={button:0,defaultPrevented:false,...options,
    target:{closest:selector=>selector.includes('workspace-leaf')?(options.outside?null:{}):selector.includes('nav-header')?{querySelector:icons=>icons.split(', ').includes(icon)?{}:null}:null},
    preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;}};
  f.feature.handleClick(e);return e;
}
test('new-note toolbar icon is intercepted once, including clicks on its SVG',async()=>{
  const f=setup();f.click('研究');const event=toolbar(f,'.lucide-edit');await settle();
  assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);assert.deepEqual(f.created,['研究/未命名.md']);
});
test('new-folder toolbar creates a child folder and opens native rename state',async()=>{
  const f=setup();f.click('研究/子目录');const event=toolbar(f,'.lucide-folder-plus');await settle();
  assert.equal(event.defaultPrevented,true);assert.deepEqual(f.createdFolders,['研究/子目录/未命名文件夹']);assert.equal(f.opened.length,0);
  assert.equal(f.revealed[0].state.newFile,'研究/子目录/未命名文件夹');assert.equal(f.feature.selectedPath,'研究/子目录');
});
test('toolbar respects no selection, feature off, other views, right clicks and unrelated buttons',async()=>{
  const f=setup();assert.equal(toolbar(f,'.lucide-folder-plus').defaultPrevented,false);f.click('研究');
  assert.equal(toolbar(f,'.lucide-folder-plus',{outside:true}).defaultPrevented,false);
  assert.equal(toolbar(f,'.lucide-folder-plus',{button:2}).defaultPrevented,false);
  assert.equal(toolbar(f,'.lucide-sort-asc').defaultPrevented,false);
  f.plugin.data.settings.folderNotes=false;assert.equal(toolbar(f,'.lucide-edit').defaultPrevented,false);
  assert.equal(f.created.length+f.createdFolders.length,0);
});
test('native new-folder command uses selected parent and avoids name collisions',async()=>{
  const f=setup();f.click('研究');f.files.set('研究/未命名文件夹',{existing:true});
  await f.plugin.app.commands.commands['file-explorer:new-folder'].callback();
  assert.deepEqual(f.createdFolders,['研究/未命名文件夹 1']);assert.equal(f.files.get('研究/未命名文件夹').existing,true);
  f.feature.unload();await f.plugin.app.commands.commands['file-explorer:new-folder'].callback();assert.equal(f.nativeCalls,1);
});
test('folder creation at root has no leading slash and concurrent clicks create once',async()=>{
  const f=setup();f.click('/');toolbar(f,'.lucide-folder-plus');toolbar(f,'.lucide-folder-plus');await settle();
  assert.deepEqual(f.createdFolders,['未命名文件夹']);
});
