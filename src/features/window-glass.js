'use strict';
const {Component,Platform}=require('obsidian');
const Core=require('../core');

// Whole-window surface manager:
// - When Obsidian's macOS native translucency (body.is-translucent) is active, syncs Electron's
//   nativeTheme.themeSource with Obsidian's light/dark setting so vibrancy never mismatches.
// - When native translucency is off, switches on the warm-paper whole-window sheet (body.aw-glass).
class WindowGlass extends Component{
  constructor(plugin){super();this.plugin=plugin;this.nativeTheme=null;this.previousSource=undefined;this.lastSource=undefined;}
  onload(){
    if(!Platform?.isDesktopApp||!Platform?.isMacOS)return;
    try{
      const remote=require('@electron/remote');
      if(!remote?.nativeTheme)return;
      this.nativeTheme=remote.nativeTheme;
      this.previousSource=this.nativeTheme.themeSource;
      if(typeof this.plugin.app?.vault?.on==='function'){
        this.registerEvent(this.plugin.app.vault.on('config-changed',key=>{if(key==='theme')this.syncNativeTheme();}));
      }
      this.syncNativeTheme();
    }catch{this.nativeTheme=null;}
  }
  onunload(){
    if(this.nativeTheme&&this.lastSource!==undefined&&this.nativeTheme.themeSource===this.lastSource){
      try{this.nativeTheme.themeSource=this.previousSource;}catch{}
    }
    this.nativeTheme=null;
  }
  syncNativeTheme(){
    if(!this.nativeTheme)return;
    const enabled=!!this.plugin.data?.settings?.glass;
    const theme=typeof this.plugin.app?.vault?.getConfig==='function'?this.plugin.app.vault.getConfig('theme'):null;
    const next=!enabled?'system':theme==='obsidian'?'dark':theme==='moonstone'?'light':'system';
    try{
      if(this.nativeTheme.themeSource!==next)this.nativeTheme.themeSource=next;
      this.lastSource=next;
    }catch{}
  }
  classes(){
    const {glass,glassFog,sidebarHover,autoHideRibbon}=this.plugin.data.settings;
    const list=glass?['aw-glass','aw-glass-fog-'+(Core.GLASS_FOGS.some(f=>f.id===glassFog)?glassFog:'normal')]:[];
    if(sidebarHover===false)list.push('aw-sidebar-hover-off');
    if(autoHideRibbon===false)list.push('aw-ribbon-hide-off');
    return list;
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings,apply=()=>{this.syncNativeTheme();this.plugin.applyAppearanceEverywhere();this.plugin.changed();};
    new Setting(container).setName('类纸底色与半透明玻璃')
      .addToggle(t=>t.setValue(!!s.glass).onChange(v=>{s.glass=v;apply();}));
    new Setting(container).setName('纹理与玻璃雾度')
      .addDropdown(d=>{
        for(const f of Core.GLASS_FOGS)d.addOption(f.id,f.label);
        d.setValue(s.glassFog||'normal').onChange(v=>{s.glassFog=v;apply();});
      });
    new Setting(container).setName('侧栏边缘悬停滑出')
      .addToggle(t=>t.setValue(s.sidebarHover!==false).onChange(v=>{s.sidebarHover=v;apply();}));
    new Setting(container).setName('左侧功能区自动隐藏')
      .addToggle(t=>t.setValue(s.autoHideRibbon!==false).onChange(v=>{s.autoHideRibbon=v;apply();}));
  }
}
module.exports={WindowGlass};
