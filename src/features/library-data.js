'use strict';
// The image library (素材库), data side: which vault files are images, how they are filtered,
// sorted, shuffled, grouped by folder, analysed for dominant colours and laid out in columns,
// and the ratings and tags the plugin keeps for them. Nothing here touches Obsidian or the DOM.
const STILL=['png','jpg','jpeg','webp','avif','bmp'];
const IMAGE=new Set([...STILL,'gif','svg']);
const TYPES=[{id:'all',label:'全部类型'},{id:'still',label:'图片'},{id:'gif',label:'GIF'},{id:'svg',label:'SVG'}];
const SHAPES=[
  {id:'all',label:'全部比例'},
  {id:'landscape',label:'横图'},
  {id:'portrait',label:'竖图'},
  {id:'square',label:'方图'},
  {id:'wide',label:'宽幅 16:9+'},
  {id:'long',label:'长截图'},
];
const COLORS=[
  {id:'all',label:'全部颜色',hex:''},
  {id:'red',label:'红色系',hex:'#ef5350'},
  {id:'orange',label:'橙色系',hex:'#f59e0b'},
  {id:'yellow',label:'黄色系',hex:'#eab308'},
  {id:'green',label:'绿色系',hex:'#22c55e'},
  {id:'cyan',label:'青色系',hex:'#06b6d4'},
  {id:'blue',label:'蓝色系',hex:'#3b82f6'},
  {id:'purple',label:'紫色系',hex:'#8b5cf6'},
  {id:'light',label:'浅色 / 白',hex:'#f1f5f9'},
  {id:'dark',label:'深色 / 黑',hex:'#334155'},
];
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
function matchesShape(w,h,shape){
  if(!shape||shape==='all')return true;
  if(!(w>0&&h>0))return false;
  if(shape==='wide')return w/h>=1.65;
  if(shape==='long')return h/w>=1.85;
  return shapeOf(w,h)===shape;
}
function formatSize(bytes){
  const n=Math.max(0,Number(bytes)||0);
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${Math.round(n/1024)} KB`;
  const mb=n/1024/1024;
  return `${mb<10?mb.toFixed(1):Math.round(mb)} MB`;
}

// Pure RGBA pixel analysis (from a small downsampled canvas): extracts up to 2–3 dominant colour
// families (so charts/UI with white backgrounds still match their accent hue) and up to 5 HEX swatches.
function rgbToHex(r,g,b){
  const h=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbToHsl(r,g,b){
  const rn=r/255,gn=g/255,bn=b/255,max=Math.max(rn,gn,bn),min=Math.min(rn,gn,bn),d=max-min,l=(max+min)/2;
  if(d===0)return [0,0,l];
  const s=d/(1-Math.abs(2*l-1));
  let h=max===rn?((gn-bn)/d)%6:max===gn?(bn-rn)/d+2:(rn-gn)/d+4;
  h=h*60;if(h<0)h+=360;
  return [h,s,l];
}
function hueBucket(h){
  if(h>=340||h<16)return 'red';
  if(h<42)return 'orange';
  if(h<70)return 'yellow';
  if(h<162)return 'green';
  if(h<200)return 'cyan';
  if(h<255)return 'blue';
  return 'purple';
}
function analyzePixels(rgba){
  if(!rgba||rgba.length<4)return {colors:[],palette:[]};
  const hueWeights=dict(),clusters=new Map();
  let opaque=0,chromatic=0,lightCount=0,darkCount=0;
  for(let i=0;i+3<rgba.length;i+=4){
    if(rgba[i+3]<96)continue;
    const r=rgba[i],g=rgba[i+1],b=rgba[i+2];
    opaque++;
    const [h,s,l]=rgbToHsl(r,g,b);
    if(s>=0.18&&l>=0.12&&l<=0.93){
      chromatic++;
      const bucket=hueBucket(h);
      hueWeights[bucket]=(hueWeights[bucket]||0)+(0.6+s);
    }else if(l<0.28)darkCount++;
    else if(l>0.78)lightCount++;
    const key=((r>>4)<<8)|((g>>4)<<4)|(b>>4);
    let c=clusters.get(key);
    if(!c){c={n:0,r:0,g:0,b:0,s:0};clusters.set(key,c);}
    c.n++;c.r+=r;c.g+=g;c.b+=b;c.s+=s;
  }
  if(!opaque)return {colors:[],palette:[]};
  const colors=Object.entries(hueWeights)
    .filter(([,w])=>w>=opaque*0.045)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,2)
    .map(([k])=>k);
  if(darkCount>=opaque*0.42)colors.push('dark');
  else if(lightCount>=opaque*0.62&&chromatic<=opaque*0.38)colors.push('light');
  if(!colors.length)colors.push(darkCount>=lightCount?'dark':'light');

  const ranked=[...clusters.values()]
    .map(c=>({r:c.r/c.n,g:c.g/c.n,b:c.b/c.n,score:c.n*(1+(c.s/c.n)*0.85)}))
    .sort((a,b)=>b.score-a.score);
  const picked=[];
  for(const cand of ranked){
    if(picked.every(p=>Math.hypot(p.r-cand.r,p.g-cand.g,p.b-cand.b)>=38))picked.push(cand);
    if(picked.length>=5)break;
  }
  for(const cand of ranked){
    if(picked.length>=5)break;
    if(!picked.includes(cand))picked.push(cand);
  }
  const palette=[];
  for(const p of picked){
    const hex=rgbToHex(p.r,p.g,p.b);
    if(!palette.includes(hex))palette.push(hex);
  }
  return {colors,palette};
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

// Safe names and collision-free vault paths for pasted or dropped images.
function sanitizeImageName(rawName,fallbackExt='png',now=new Date()){
  const p=n=>String(n).padStart(2,'0');
  const stamp=`${now.getFullYear()}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const raw=String(rawName||'').trim();
  const dot=raw.lastIndexOf('.');
  let stem=dot>0?raw.slice(0,dot):raw,ext=(dot>0?raw.slice(dot+1):fallbackExt).toLowerCase();
  if(ext==='jpeg')ext='jpg';
  if(!isImage(ext))ext=isImage(fallbackExt)?String(fallbackExt).toLowerCase():'png';
  stem=stem.replace(/[/\\:*?"<>|\u0000-\u001f]+/g,'-').replace(/^\.+|\.+$/g,'').trim().slice(0,64);
  if(!stem||/^(?:image|blob|clipboard|pasted image)$/i.test(stem))stem=`素材-${stamp}`;
  return {stem,ext,name:`${stem}.${ext}`};
}
function uniqueVaultPath(folder,fileName,exists){
  const dir=String(folder||'').replace(/^\/+|\/+$/g,'');
  const dot=fileName.lastIndexOf('.'),stem=dot>0?fileName.slice(0,dot):fileName,ext=dot>0?fileName.slice(dot):'';
  for(let n=0;n<10000;n++){
    const leaf=n===0?`${stem}${ext}`:`${stem}-${n}${ext}`;
    const candidate=dir?`${dir}/${leaf}`:leaf;
    if(!exists(candidate))return candidate;
  }
  throw Error('同名图片过多，请重命名后重试。');
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
function makeItems(files,{lib=emptyLibrary(),used=new Set(),dims=new Map(),palettes=new Map()}={}){
  const items=[];
  for(const f of files){
    if(!isImage(f.extension))continue;
    const size=dims.get(f.path),pal=palettes.get(f.path);
    items.push({path:f.path,name:f.basename,ext:String(f.extension).toLowerCase(),folder:f.parent?.path&&f.parent.path!=='/'?f.parent.path:'',
      size:f.stat?.size||0,mtime:f.stat?.mtime||0,rating:own(lib.ratings,f.path)?lib.ratings[f.path]:0,
      tags:own(lib.tags,f.path)?lib.tags[f.path]:[],used:used.has(f.path),w:size?.w||0,h:size?.h||0,
      colors:pal?.colors||[],palette:pal?.palette||[]});
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
  if(f.shape&&f.shape!=='all'&&!matchesShape(item.w,item.h,f.shape))return false;
  if(f.color&&f.color!=='all'&&!(item.colors||[]).includes(f.color))return false;
  if(f.rating==='none')return !item.rating;
  if(f.rating&&f.rating!=='all')return item.rating>=Number(f.rating);
  return true;
}
const byName=(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})||a.path.localeCompare(b.path);
// Deterministic seeded Fisher-Yates shuffle so rating/tagging in roam mode never scrambles positions.
function shuffleItems(items,seed=1){
  const list=[...items];
  let s=(Number(seed)||1)>>>0;
  const rand=()=>{s=(s+0x6d2b79f5)>>>0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
  for(let i=list.length-1;i>0;i--){
    const j=Math.floor(rand()*(i+1));
    [list[i],list[j]]=[list[j],list[i]];
  }
  return list;
}
function sortItems(items,sort,seed=0){
  if(sort==='shuffle'||seed>0)return shuffleItems(items,seed||1);
  const list=[...items];
  if(sort==='name')return list.sort(byName);
  if(sort==='old')return list.sort((a,b)=>a.mtime-b.mtime||byName(a,b));
  if(sort==='large')return list.sort((a,b)=>b.size-a.size||byName(a,b));
  return list.sort((a,b)=>b.mtime-a.mtime||byName(a,b));
}
const filterItems=(items,f,seed=0)=>sortItems(items.filter(item=>matches(item,f)),f.sort,seed);

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

module.exports={IMAGE,TYPES,SHAPES,COLORS,RATINGS,SORTS,SIZES,isImage,kindOf,shapeOf,matchesShape,formatSize,
  rgbToHex,analyzePixels,emptyLibrary,parseTags,loadLibrary,setRating,setTags,renameInLibrary,forgetInLibrary,
  sanitizeImageName,uniqueVaultPath,references,makeItems,inScope,matches,shuffleItems,sortItems,filterItems,
  folderTree,tagCounts,cardHeight,placeCards,columnCount};
