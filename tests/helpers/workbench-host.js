'use strict';
// Project-owned DOM/Obsidian stand-in. It never opens an app, network socket or real vault.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Core=require('../../src/core');
class Element{
  constructor(tag,document){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.attributes={};this.dataset={};this.events={};this.className='';this._text='';this.scrollTop=0;this.scrollLeft=0;this.scrollWidth=900;this.visible=true;this.style={values:{},setProperty:(k,v)=>{this.style.values[k]=v;}};this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');},remove:(name)=>{this.className=this.className.split(' ').filter(x=>x!==name).join(' ');},toggle:(name,on)=>{const value=on??!this.className.split(' ').includes(name);value?this.classList.add(name):this.classList.remove(name);return value;}};}
  set textContent(value){this._text=String(value);this.children.forEach(c=>c.parentElement=null);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  appendChild(node){this.children.push(node);node.parentElement=this;return node;}
  replaceChildren(...nodes){this.children.forEach(c=>c.parentElement=null);this.children=[];this._text='';nodes.forEach(n=>this.appendChild(n));}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
  dispatch(name,event={}){const e={target:this,preventDefault(){},...event};return (this.events[name]||[]).map(fn=>fn(e));}
  click(){if(!this.disabled)return Promise.all(this.dispatch('click'));return Promise.resolve();}
  focus(){this.ownerDocument.activeElement=this;}
  getClientRects(){return this.visible?[{}]:[];}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  querySelectorAll(selector){
    const matches=node=>selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1))
      :selector.startsWith('[data-')?(()=>{const m=/^\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);return m&&node.dataset[m[1].replace(/-([a-z])/g,(_x,c)=>c.toUpperCase())]===m[2];})()
      :node.tagName===selector.toUpperCase();
    const result=[];const visit=node=>{for(const child of node.children){if(matches(child))result.push(child);visit(child);}};visit(this);return result;
  }
}
function escape(text){return String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function serialize(node){
  const attributes={...node.attributes};if(node.className)attributes.class=node.className;
  for(const [k,v] of Object.entries(node.dataset))attributes['data-'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())]=v;
  for(const key of ['type','title','tabIndex','dateTime'])if(node[key]!==undefined)attributes[key.toLowerCase()]=node[key];
  if(node.disabled)attributes.disabled='';if(node.open)attributes.open='';
  if(Object.keys(node.style.values).length)attributes.style=Object.entries(node.style.values).map(([k,v])=>`${k}:${v}`).join(';');
  const attrs=Object.entries(attributes).map(([k,v])=>` ${k}="${escape(v)}"`).join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${escape(node._text)}${node.children.map(serialize).join('')}</${node.tagName.toLowerCase()}>`;
}
const iconPaths={
  'file-text':'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
  folder:'M3 6h7l2 2h9v12H3z',plus:'M12 5v14 M5 12h14',
  'arrow-up-right':'M6 18L18 6 M7 6h11v11',
  'refresh-cw':'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 2 M4 16l2 2a7 7 0 0 0 12-1',
  'hard-drive':'M5 7h14l3 9v4H2v-4z M2 16h20',
  activity:'M22 12h-4l-3 9L9 3l-3 9H2',
  'calendar-days':'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h.01 M12 14h.01 M16 14h.01 M8 18h.01 M12 18h.01',
  history:'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l4 2',
  table:'M3 4h18v16H3z M3 10h18 M3 15h18 M9 4v16',
  'chevron-down':'M6 9l6 6 6-6'
};
function fixture(){
  const document={activeElement:null};document.createElement=tag=>new Element(tag,document);
  const content=document.createElement('main');
  class TFile{constructor(filePath,mtime){this.path=filePath;this.basename=filePath.split('/').pop().replace(/\.md$/,'');this.extension='md';this.parent={path:filePath.includes('/')?filePath.slice(0,filePath.lastIndexOf('/')):'/'};this.stat={mtime};}}
  const now=new Date();
  const files=['研究/Attention 机制与梯度推导.md','实验/检索模型消融实验.md','工程/推理服务延迟排查.md','研究/对比学习阅读笔记.md','工程/数据集版本说明.md','记录/本周实验安排.md'].map((filePath,i)=>new TFile(filePath,now.getTime()-i*43200000));
  const opened=[],nativeCommands=[],notices=[],created=[];
  const app={vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:p=>files.find(f=>f.path===p)||created.find(([c])=>c===p),create:async(p,text)=>{created.push([p,text]);}},workspace:{getLeaf:()=>({openFile:async file=>opened.push(file.path)})},commands:{executeCommandById:id=>{nativeCommands.push(id);return true;}}};
  const obsidian={TFile,Notice:class{constructor(text){notices.push(text);}},ItemView:class{constructor(){this.app=app;this.contentEl=content;}},setIcon(node,name){
    const svg=document.createElement('svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
    const drawing=document.createElement('path');drawing.setAttribute('d',iconPaths[name]||iconPaths['file-text']);svg.appendChild(drawing);node.appendChild(svg);
  }};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/features/workbench.js'),'utf8'),{module,require:name=>{if(name==='obsidian')return obsidian;if(name==='../core')return Core;throw Error('Disallowed import: '+name);},Intl,Date});
  const data=Core.emptyData(now);data.started=Core.dayKey(Core.shiftDay(now,-180));
  data.days[Core.dayKey(now)]={characters:1286,files:{[files[0].path]:846,[files[1].path]:440}};
  const plugin={data,saveError:false,changes:0,changed(){this.changes++;},setPalette(id){this.data.settings.palette=id;this.changed();},setStyle(id){this.data.settings.style=id;this.changed();},folderNotes:{getFolder:()=>null,createNote:async()=>{}}};
  const view=new module.exports.WorkbenchView({},plugin);
  return {view,plugin,app,document,content,files,opened,nativeCommands,notices,created,TFile,Core,...module.exports};
}
module.exports={fixture,serialize,escape};
