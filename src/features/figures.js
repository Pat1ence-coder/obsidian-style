'use strict';
const {Component,Modal,FuzzySuggestModal,Setting,Notice,TFile}=require('obsidian');
const {imageReference,figureMarkdown,spacedFigure}=require('./figure-format');
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
