'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 class TFile{constructor(name){this.basename=name;this.extension='md';}}
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/screenshot-names.js'),'utf8'),{module,require:()=>({Component:class{},TFile,Setting:class{},Notice:class{}})});
 const calls=[],note=new TFile('Attention 推导');
 const original=function(...args){calls.push({args,receiver:this});return Promise.resolve('附件/'+args[0]+'.'+args[1]);};
 const plugin={data:{settings:{nameScreenshots:true}},app:{vault:{getAvailablePathForAttachments:original},workspace:{getActiveFile:()=>note}}};
 const feature=new module.exports.ScreenshotNames(plugin);feature.onload();
 return {...module.exports,feature,plugin,calls,note,original};
}
test('screenshot filenames include a safe note title and local timestamp',()=>{
 const {screenshotStem}=fixture();
 assert.equal(screenshotStem('实验/损失:曲线',new Date(2026,9,12,15,20,31,45)),'实验-损失-曲线-截图-20261012-152031-045');
 assert.ok(Buffer.byteLength(screenshotStem('😀'.repeat(300)))<220);
 assert.doesNotMatch(screenshotStem('[[a]]#^?*'),/[\[\]#^?*]/);
});
test('only default screenshot names are recognized',()=>{
 const {isDefaultScreenshot}=fixture();
 for(const name of ['Pasted image','Pasted image 20261012152031'])assert.ok(isDefaultScreenshot(name,'png'));
 for(const [name,ext] of [['loss','png'],['Pasted image analysis','png'],['Pasted image','mp3']])assert.equal(isDefaultScreenshot(name,ext),false);
});
test('native resolver keeps its destination, source, receiver and return value',async()=>{
 const f=fixture(),vault=f.plugin.app.vault;
 const result=await vault.getAvailablePathForAttachments('Pasted image 20261012152031','png',f.note);
 assert.match(result,/^附件\/Attention 推导-截图-/);
 assert.equal(f.calls[0].receiver,vault);assert.equal(f.calls[0].args[2],f.note);
});
test('toggle off, non-images and custom filenames retain native behavior',async()=>{
 const f=fixture(),vault=f.plugin.app.vault;
 await vault.getAvailablePathForAttachments('训练结果','png',f.note);
 assert.equal(f.calls[0].args[0],'训练结果');
 f.plugin.data.settings.nameScreenshots=false;
 await vault.getAvailablePathForAttachments('Pasted image','png',f.note);assert.equal(f.calls[1].args[0],'Pasted image');
});
test('same-timestamp requests have distinct names and unloading restores resolver',async()=>{
 const f=fixture(),vault=f.plugin.app.vault;
 await Promise.all(Array.from({length:30},()=>vault.getAvailablePathForAttachments('Pasted image','png',f.note)));
 assert.equal(new Set(f.calls.map(c=>c.args[0])).size,30);
 f.feature.onunload();assert.equal(vault.getAvailablePathForAttachments,f.original);
});
