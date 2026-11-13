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
