'use strict';
const {Component}=require('obsidian');
const Core=require('../core');

// Frosted paper window: the theme lays a sheet of paper (drawn in CSS from fractal noise, no
// picture) behind the whole window with frosted glass over it, and the sidebar, tabs and note
// sit on that one sheet. The plugin only switches it on and says how thick the fog is.
//
// This replaces Obsidian's own "Translucent window" on macOS, which shows no desktop since
// 1.8.9 and leaves ghosted text behind (an Electron compositing bug CSS can't fix). The window
// stays opaque here, so nothing ghosts.
class WindowGlass extends Component{
  constructor(plugin){super();this.plugin=plugin;}
  // Body classes for the glass, or none when it is switched off.
  classes(){
    const {glass,glassFog}=this.plugin.data.settings;
    return glass?['aw-glass','aw-glass-fog-'+(Core.GLASS_FOGS.some(f=>f.id===glassFog)?glassFog:'normal')]:[];
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings,apply=()=>{this.plugin.applyAppearanceEverywhere();this.plugin.changed();};
    new Setting(container).setName('窗口毛玻璃').setDesc('整个窗口铺一层类纸的磨砂玻璃：浅灰的纸面带极淡的粉杏与灰蓝云纹和细颗粒，侧栏和正文连成同一层玻璃，正文略亮，白色卡片浮在上面。不需要任何图片，也不需要打开 Obsidian 的「半透明窗口」（它在 macOS 上会产生重影）。关闭则保持纯白外观。')
      .addToggle(t=>t.setValue(!!s.glass).onChange(v=>{s.glass=v;apply();}));
    new Setting(container).setName('毛玻璃雾的浓度').setDesc('纸面上那层白雾（深色模式为暗雾）的厚度：越浓越亮越素净，越淡纸纹和颜色越明显。')
      .addDropdown(d=>{
        for(const f of Core.GLASS_FOGS)d.addOption(f.id,f.label);
        d.setValue(s.glassFog||'normal').onChange(v=>{s.glassFog=v;apply();});
      });
  }
}
module.exports={WindowGlass};
