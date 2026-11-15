'use strict';
const {Component,TFile}=require('obsidian');
const Core=require('../core');
const IMAGE=/^(png|jpe?g|gif|webp|avif)$/i;

// Frosted window: a picture from the vault (typically the desktop wallpaper) becomes the
// window's glass. The plugin only says which picture; the theme blurs it, lays a neutral fog
// on top and lets the sidebar, tabs and note sit on that one sheet of glass.
//
// This replaces Obsidian's own "Translucent window" on macOS, which shows no desktop since
// 1.8.9 and leaves ghosted text behind (an Electron compositing bug CSS can't fix). The window
// stays opaque here, so nothing ghosts.
class WindowGlass extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;}
  onload(){
    this.app.workspace.onLayoutReady(()=>this.plugin.applyAppearanceEverywhere());
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{
      if(oldPath!==this.plugin.data.settings.glassImage)return;
      this.plugin.data.settings.glassImage=file.path;this.plugin.changed();this.plugin.applyAppearanceEverywhere();
    }));
    this.registerEvent(this.app.vault.on('delete',file=>{if(file.path===this.plugin.data.settings.glassImage)this.plugin.applyAppearanceEverywhere();}));
    this.registerEvent(this.app.vault.on('modify',file=>{if(file.path===this.plugin.data.settings.glassImage)this.plugin.applyAppearanceEverywhere();}));
  }
  file(){
    const file=this.app.vault.getAbstractFileByPath(this.plugin.data.settings.glassImage||'');
    return file instanceof TFile&&IMAGE.test(file.extension)?file:null;
  }
  // Body classes for the glass, or none when no usable picture is set.
  classes(){
    const fog=this.plugin.data.settings.glassFog;
    return this.file()?['aw-glass','aw-glass-fog-'+(Core.GLASS_FOGS.some(f=>f.id===fog)?fog:'normal')]:[];
  }
  // The picture as a CSS image value, quoted so any path is safe inside url().
  image(){
    const file=this.file();
    return file?`url(${JSON.stringify(this.app.vault.getResourcePath(file))})`:'';
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings;
    new Setting(container).setName('窗口毛玻璃').setDesc('选一张笔记库内的图片（建议用你的桌面壁纸，例如 assets/wallpaper.jpg），主题会把它模糊后铺满窗口，侧栏和正文成为同一层玻璃，白色卡片浮在上面。玻璃本身无色，颜色来自这张图。留空则保持白色外观。不需要打开 Obsidian 的「半透明窗口」，打开它反而会在 macOS 上产生重影。')
      .addText(t=>t.setPlaceholder('assets/wallpaper.jpg').setValue(s.glassImage||'').onChange(v=>{
        s.glassImage=v.trim().replace(/^\/+/,'');this.plugin.applyAppearanceEverywhere();this.plugin.changed();
      }));
    new Setting(container).setName('毛玻璃雾的浓度').setDesc('图片上那层白雾（深色模式为暗雾）的厚度：越浓越素净，越淡图片颜色越明显。')
      .addDropdown(d=>{
        for(const f of Core.GLASS_FOGS)d.addOption(f.id,f.label);
        d.setValue(s.glassFog||'normal').onChange(v=>{s.glassFog=v;this.plugin.applyAppearanceEverywhere();this.plugin.changed();});
      });
  }
}
module.exports={WindowGlass};
