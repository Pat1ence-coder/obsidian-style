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
