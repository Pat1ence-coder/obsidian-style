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
