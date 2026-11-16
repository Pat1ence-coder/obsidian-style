'use strict';
// The image library (素材库), data side: which vault files are images, how they are filtered,
// sorted, grouped by folder and laid out in columns, and the ratings and tags the plugin keeps
// for them (images cannot carry tags of their own). Nothing here touches Obsidian or the DOM.
const STILL=['png','jpg','jpeg','webp','avif','bmp'];
const IMAGE=new Set([...STILL,'gif','svg']);
const TYPES=[{id:'all',label:'全部类型'},{id:'still',label:'图片'},{id:'gif',label:'GIF'},{id:'svg',label:'SVG'}];
const SHAPES=[{id:'all',label:'全部比例'},{id:'landscape',label:'横图'},{id:'portrait',label:'竖图'},{id:'square',label:'方图'}];
const RATINGS=[{id:'all',label:'全部星级'},{id:'5',label:'★★★★★'},{id:'4',label:'★★★★ 以上'},{id:'3',label:'★★★ 以上'},{id:'2',label:'★★ 以上'},{id:'1',label:'★ 以上'},{id:'none',label:'未评星'}];
const SORTS=[{id:'new',label:'最近修改'},{id:'old',label:'最早修改'},{id:'name',label:'名称'},{id:'large',label:'文件最大'}];
const SIZES=[{id:'s',label:'小卡片',width:150},{id:'m',label:'中卡片',width:210},{id:'l',label:'大卡片',width:300}];
const MAX_TAGS=12,MAX_TAG=32;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const dict=()=>Object.create(null);

const isImage=ext=>IMAGE.has(String(ext||'').toLowerCase());
const kindOf=ext=>{const e=String(ext||'').toLowerCase();return e==='gif'||e==='svg'?e:'still';};
// Landscape, portrait or square (within 10%), or null while the size is unknown.
function shapeOf(w,h){
  if(!(w>0&&h>0))return null;
  const r=w/h;
  return r>1.1?'landscape':r<1/1.1?'portrait':'square';
}
function formatSize(bytes){
  const n=Math.max(0,Number(bytes)||0);
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${Math.round(n/1024)} KB`;
  const mb=n/1024/1024;
  return `${mb<10?mb.toFixed(1):Math.round(mb)} MB`;
}

// Ratings (1–5) and tags per image path, kept in the plugin's data.
function emptyLibrary(){return {ratings:dict(),tags:dict()};}
// "a, b，c d" → ['a','b','c','d']: trimmed, no leading #, no repeats, at most 12 of 32 characters.
function parseTags(text){
  const out=[];
  for(const raw of String(text||'').split(/[\s,，、;；]+/)){
    const tag=raw.replace(/^#+/,'').slice(0,MAX_TAG);
    if(tag&&!out.includes(tag))out.push(tag);
    if(out.length>=MAX_TAGS)break;
  }
  return out;
}
function loadLibrary(raw){
  const lib=emptyLibrary();
  if(!raw||typeof raw!=='object')return lib;
  for(const [path,n] of Object.entries(raw.ratings||{}))if(path&&Number.isInteger(n)&&n>=1&&n<=5)lib.ratings[path]=n;
  for(const [path,list] of Object.entries(raw.tags||{})){
    const tags=Array.isArray(list)?parseTags(list.filter(t=>typeof t==='string').join(' ')):[];
    if(path&&tags.length)lib.tags[path]=tags;
  }
  return lib;
}
function setRating(lib,path,n){
  if(Number.isInteger(n)&&n>=1&&n<=5)lib.ratings[path]=n;else delete lib.ratings[path];
}
function setTags(lib,path,tags){
  const list=parseTags((tags||[]).join(' '));
  if(list.length)lib.tags[path]=list;else delete lib.tags[path];
}
// A file or a whole folder moved: its ratings and tags go with it.
function renameInLibrary(lib,oldPath,newPath){
  const moved=path=>path===oldPath?newPath:path.startsWith(oldPath+'/')?newPath+path.slice(oldPath.length):null;
  for(const table of [lib.ratings,lib.tags])for(const path of Object.keys(table)){
    const next=moved(path);
    if(next!==null&&next!==path){table[next]=table[path];delete table[path];}
  }
}
function forgetInLibrary(lib,path){
  for(const table of [lib.ratings,lib.tags])for(const key of Object.keys(table))
    if(key===path||key.startsWith(path+'/'))delete table[key];
}

// Images referenced from notes: resolvedLinks is {note: {target: count}}. Returns
// {used: Set of image paths, refs: Map image → notes linking to it}.
function references(resolvedLinks){
  const used=new Set(),refs=new Map();
  for(const [note,targets] of Object.entries(resolvedLinks||{}))for(const target of Object.keys(targets||{})){
    if(!isImage(target.split('.').pop()))continue;
    used.add(target);
    if(!refs.has(target))refs.set(target,[]);
    refs.get(target).push(note);
  }
  return {used,refs};
}
// Files (TFile-like: path, basename, extension, stat, parent) → library items.
function makeItems(files,{lib=emptyLibrary(),used=new Set(),dims=new Map()}={}){
  const items=[];
  for(const f of files){
    if(!isImage(f.extension))continue;
    const size=dims.get(f.path);
    items.push({path:f.path,name:f.basename,ext:String(f.extension).toLowerCase(),folder:f.parent?.path&&f.parent.path!=='/'?f.parent.path:'',
      size:f.stat?.size||0,mtime:f.stat?.mtime||0,rating:own(lib.ratings,f.path)?lib.ratings[f.path]:0,
      tags:own(lib.tags,f.path)?lib.tags[f.path]:[],used:used.has(f.path),w:size?.w||0,h:size?.h||0});
  }
  return items;
}

// What the left panel points at: everything, unused images, rated ones, a folder (and the
// folders under it) or a tag.
function inScope(item,scope){
  switch(scope?.kind){
    case 'unused':return !item.used;
    case 'rated':return item.rating>0;
    case 'folder':return !scope.value||item.folder===scope.value||item.folder.startsWith(scope.value+'/');
    case 'tag':return item.tags.includes(scope.value);
    default:return true;
  }
}
// Every word must appear in the name, the folder or a tag.
function matchesText(item,text){
  const words=String(text||'').toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length)return true;
  const hay=[item.name+'.'+item.ext,item.folder,...item.tags].join('\n').toLowerCase();
  return words.every(w=>hay.includes(w.replace(/^#/,'')));
}
function matches(item,f){
  if(!inScope(item,f.scope)||!matchesText(item,f.text))return false;
  if(f.type&&f.type!=='all'&&kindOf(item.ext)!==f.type)return false;
  if(f.shape&&f.shape!=='all'&&shapeOf(item.w,item.h)!==f.shape)return false;
  if(f.rating==='none')return !item.rating;
  if(f.rating&&f.rating!=='all')return item.rating>=Number(f.rating);
  return true;
}
const byName=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})||a.path.localeCompare(b.path);
function sortItems(items,sort){
  const list=[...items];
  if(sort==='name')return list.sort(byName);
  if(sort==='old')return list.sort((a,b)=>a.mtime-b.mtime||byName(a,b));
  if(sort==='large')return list.sort((a,b)=>b.size-a.size||byName(a,b));
  return list.sort((a,b)=>b.mtime-a.mtime||byName(a,b));
}
const filterItems=(items,f)=>sortItems(items.filter(item=>matches(item,f)),f.sort);

// Folders that hold images, nested, each with the number of images in it and below it.
function folderTree(items){
  const root={name:'',path:'',count:0,children:[]},index=new Map([['',root]]);
  const node=path=>{
    if(index.has(path))return index.get(path);
    const cut=path.lastIndexOf('/'),parent=node(cut<0?'':path.slice(0,cut));
    const made={name:path.slice(cut+1),path,count:0,children:[]};
    parent.children.push(made);index.set(path,made);return made;
  };
  for(const item of items){
    root.count++;
    if(!item.folder)continue;
    const parts=item.folder.split('/');
    for(let i=1;i<=parts.length;i++)node(parts.slice(0,i).join('/')).count++;
  }
  const order=n=>{n.children.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));n.children.forEach(order);return n;};
  return order(root);
}
function tagCounts(items){
  const counts=new Map();
  for(const item of items)for(const tag of item.tags)counts.set(tag,(counts.get(tag)||0)+1);
  return [...counts].map(([tag,count])=>({tag,count})).sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag,'zh-CN'));
}

// Card height for a column width: the picture at its own proportions (4:3 while unknown;
// very tall or very wide pictures are cropped to between 2.5:1 and 1:2), plus the caption.
const CAPTION=52;
function cardHeight(item,width){
  const ratio=item.w>0&&item.h>0?Math.min(2,Math.max(.4,item.h/item.w)):.75;
  return width*ratio+CAPTION+(item.tags.length?22:0);
}
// Masonry: each card goes to the currently shortest column (the leftmost on a tie). heights
// carries on from earlier batches, so loading more never moves cards already placed.
function placeCards(items,heights,width,gap){
  return items.map(item=>{
    let col=0;
    for(let i=1;i<heights.length;i++)if(heights[i]<heights[col]-.5)col=i;
    heights[col]+=cardHeight(item,width)+gap;
    return col;
  });
}
function columnCount(width,card,gap){return Math.max(1,Math.floor((width+gap)/(card+gap)));}

module.exports={IMAGE,TYPES,SHAPES,RATINGS,SORTS,SIZES,isImage,kindOf,shapeOf,formatSize,emptyLibrary,parseTags,loadLibrary,setRating,setTags,
  renameInLibrary,forgetInLibrary,references,makeItems,inScope,matches,sortItems,filterItems,folderTree,tagCounts,cardHeight,placeCards,columnCount};
