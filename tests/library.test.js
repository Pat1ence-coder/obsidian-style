'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const L=require('../src/features/library-data');
const C=require('../src/core');

const file=(p,{size=1000,mtime=1}={})=>{const name=p.split('/').pop(),dot=name.lastIndexOf('.');
  return {path:p,basename:name.slice(0,dot),extension:name.slice(dot+1),stat:{size,mtime},parent:{path:p.includes('/')?p.slice(0,p.lastIndexOf('/')):'/'}};};

test('which files are images, their kind, shape and size label',()=>{
  for(const e of ['png','JPG','jpeg','gif','webp','avif','svg','bmp'])assert.ok(L.isImage(e),e);
  for(const e of ['md','pdf','mp4','canvas',''])assert.ok(!L.isImage(e),e);
  assert.equal(L.kindOf('GIF'),'gif');assert.equal(L.kindOf('svg'),'svg');assert.equal(L.kindOf('png'),'still');
  assert.equal(L.shapeOf(1964,2740),'portrait');assert.equal(L.shapeOf(1800,1000),'landscape');assert.equal(L.shapeOf(1000,1050),'square');assert.equal(L.shapeOf(0,10),null);
  assert.equal(L.formatSize(800),'800 B');assert.equal(L.formatSize(768*1024),'768 KB');assert.equal(L.formatSize(1.9*1024*1024),'1.9 MB');assert.equal(L.formatSize(24.4*1024*1024),'24 MB');
});
test('tags are parsed from free text; ratings and tags are sanitised when loaded',()=>{
  assert.deepEqual(L.parseTags(' 封面, #配色，灵感、封面  ui;x'),['封面','配色','灵感','ui','x']);
  assert.equal(L.parseTags(Array.from({length:20},(_,i)=>'t'+i).join(' ')).length,12);
  assert.equal(L.parseTags('长'.repeat(40))[0].length,32);
  const lib=L.loadLibrary({ratings:{'a.png':5,'b.png':0,'c.png':6,'d.png':2.5,'e.png':'3','f.png':1},tags:{'a.png':['封面',' ','#配色',7],'b.png':[],'c.png':'x'}});
  assert.deepEqual({...lib.ratings},{'a.png':5,'f.png':1});
  assert.deepEqual({...lib.tags},{'a.png':['封面','配色']});
  assert.deepEqual({...L.loadLibrary(null).ratings},{});assert.deepEqual({...L.loadLibrary('junk').tags},{});
  L.setRating(lib,'g.png',3);L.setRating(lib,'a.png',0);assert.deepEqual({...lib.ratings},{'f.png':1,'g.png':3});
  L.setTags(lib,'g.png',['新',' 新 ','#旧']);assert.deepEqual(lib.tags['g.png'],['新','旧']);L.setTags(lib,'a.png',[]);assert.equal(lib.tags['a.png'],undefined);
});
test('ratings and tags follow renamed files and folders, and go with deleted ones',()=>{
  const lib=L.loadLibrary({ratings:{'assets/a.png':4,'assets/sub/b.png':2,'assets2/c.png':3},tags:{'assets/sub/b.png':['x']}});
  L.renameInLibrary(lib,'assets','素材');
  assert.deepEqual({...lib.ratings},{'素材/a.png':4,'素材/sub/b.png':2,'assets2/c.png':3},'a folder with a similar name stays');
  assert.deepEqual({...lib.tags},{'素材/sub/b.png':['x']});
  L.renameInLibrary(lib,'素材/a.png','封面.png');assert.equal(lib.ratings['封面.png'],4);
  L.forgetInLibrary(lib,'素材');assert.deepEqual({...lib.ratings},{'assets2/c.png':3,'封面.png':4});assert.deepEqual({...lib.tags},{});
  // In the plugin's data: loaded, saved as JSON, renamed with the rest of the statistics.
  const d=C.loadState({...JSON.parse(JSON.stringify(C.emptyData())),library:{ratings:{'a/x.png':5},tags:{'a/x.png':['封面']}}});
  C.renamePath(d,'a','b');assert.deepEqual(JSON.parse(JSON.stringify(d.library)),{ratings:{'b/x.png':5},tags:{'b/x.png':['封面']}});
  assert.deepEqual(JSON.parse(JSON.stringify(C.emptyData().library)),{ratings:{},tags:{}});
  assert.deepEqual({...C.loadState({...JSON.parse(JSON.stringify(C.emptyData())),library:undefined}).library.ratings},{},'older data has no library');
});
test('items carry what the cards show; links tell which images are used and by which notes',()=>{
  const {used,refs}=L.references({'a.md':{'img/x.png':2,'b.md':1},'c.md':{'img/x.png':1,'img/y.gif':1}});
  assert.deepEqual([...used].sort(),['img/x.png','img/y.gif'],'notes are not images');
  assert.deepEqual(refs.get('img/x.png'),['a.md','c.md']);
  const lib=L.loadLibrary({ratings:{'img/x.png':4},tags:{'img/y.gif':['动图']}});
  const items=L.makeItems([file('img/x.png',{size:2048,mtime:5}),file('img/y.gif'),file('top.svg'),file('note.md')],{lib,used,dims:new Map([['img/x.png',{w:1964,h:2740}]])});
  assert.deepEqual(items.map(i=>[i.path,i.name,i.ext,i.folder,i.rating,i.tags.join(),i.used,i.w,i.h]),[
    ['img/x.png','x','png','img',4,'',true,1964,2740],['img/y.gif','y','gif','img',0,'动图',true,0,0],['top.svg','top','svg','',0,'',false,0,0]]);
});
test('filters: scope, words, type, shape and stars; sorting',()=>{
  const it=(p,o={})=>({path:p,name:p.split('/').pop().replace(/\.\w+$/,''),ext:p.split('.').pop(),folder:p.includes('/')?p.slice(0,p.lastIndexOf('/')):'',size:1,mtime:1,rating:0,tags:[],used:true,w:0,h:0,...o});
  const items=[
    it('a/封面.png',{rating:5,w:1000,h:500,mtime:3,size:30,tags:['封面']}),it('a/b/图表.png',{used:false,w:400,h:800,mtime:9,size:10}),
    it('动图.gif',{rating:2,mtime:1,size:99}),it('ab/x.svg',{w:100,h:100,tags:['图标'],mtime:5,size:5})];
  const run=f=>L.filterItems(items,{scope:{kind:'all'},type:'all',shape:'all',rating:'all',sort:'name',...f}).map(i=>i.path);
  // Names sort by pinyin (动 dong, 封 feng, 图 tu), then Latin letters, as Chinese collation does.
  assert.deepEqual(run({scope:{kind:'folder',value:'a'}}),['a/封面.png','a/b/图表.png'],'a folder includes its subfolders, not "ab"');
  assert.deepEqual(run({scope:{kind:'unused'}}),['a/b/图表.png']);
  assert.deepEqual(run({scope:{kind:'rated'}}),['动图.gif','a/封面.png']);
  assert.deepEqual(run({scope:{kind:'tag',value:'图标'}}),['ab/x.svg']);
  assert.deepEqual(run({text:'封面'}),['a/封面.png']);assert.deepEqual(run({text:'#图标'}),['ab/x.svg'],'tags match with or without #');
  assert.deepEqual(run({text:'a png'}),['a/封面.png','a/b/图表.png'],'every word must match');assert.deepEqual(run({text:'GIF'}),['动图.gif'],'the extension counts');
  assert.deepEqual(run({type:'gif'}),['动图.gif']);assert.deepEqual(run({type:'still'}),['a/封面.png','a/b/图表.png']);
  assert.deepEqual(run({shape:'landscape'}),['a/封面.png']);assert.deepEqual(run({shape:'portrait'}),['a/b/图表.png']);assert.deepEqual(run({shape:'square'}),['ab/x.svg'],'unknown sizes wait');
  assert.deepEqual(run({rating:'3'}),['a/封面.png']);assert.deepEqual(run({rating:'1'}),['动图.gif','a/封面.png']);assert.deepEqual(run({rating:'none'}),['a/b/图表.png','ab/x.svg']);
  assert.deepEqual(run({sort:'new'}),['a/b/图表.png','ab/x.svg','a/封面.png','动图.gif']);
  assert.deepEqual(run({sort:'old'}),['动图.gif','a/封面.png','ab/x.svg','a/b/图表.png']);
  assert.deepEqual(run({sort:'large'}),['动图.gif','a/封面.png','a/b/图表.png','ab/x.svg']);
});
test('folder tree counts images in each folder and below; tags are counted',()=>{
  const items=[{folder:'01_Brand/Logo',tags:['a']},{folder:'01_Brand',tags:['a','b']},{folder:'00_Inbox',tags:[]},{folder:'',tags:['b']},{folder:'01_Brand/Logo',tags:[]}];
  const tree=L.folderTree(items);
  const flat=(n,d=0)=>[...n.children.flatMap(c=>[[d,c.name,c.path,c.count],...flat(c,d+1)])];
  assert.equal(tree.count,5);
  assert.deepEqual(flat(tree),[[0,'00_Inbox','00_Inbox',1],[0,'01_Brand','01_Brand',3],[1,'Logo','01_Brand/Logo',2]]);
  assert.deepEqual(L.tagCounts(items),[{tag:'a',count:2},{tag:'b',count:2}]);
});
test('masonry: each card goes to the shortest column, and later pages never move earlier cards',()=>{
  assert.equal(L.columnCount(300,210,12),1);assert.equal(L.columnCount(434,210,12),2);assert.equal(L.columnCount(900,210,12),4);assert.equal(L.columnCount(0,210,12),1);
  const card=(w,h,tags=[])=>({w,h,tags});
  assert.equal(L.cardHeight(card(0,0),200),150+52,'4:3 while the size is unknown');
  assert.equal(L.cardHeight(card(100,1000),200),400+52,'long screenshots are cropped at 1:2');
  assert.equal(L.cardHeight(card(1000,100),200),80+52,'and panoramas at 2.5:1');
  assert.equal(L.cardHeight(card(100,100,['x']),200),200+52+22);
  const heights=[0,0,0];
  assert.deepEqual(L.placeCards([card(100,200),card(100,50),card(100,100),card(100,100)],heights,100,10),[0,1,2,1]);
  const before=[...heights];
  assert.deepEqual(L.placeCards([card(100,100)],heights,100,10),[2],'the next page continues from the column heights');
  assert.ok(heights[2]>before[2]&&heights[0]===before[0]);
});

// The index behind the views, with a small vault.
function loadLibrary(){
  const mod={exports:{}},timers=[];
  class Component{registerEvent(){}addChild(c){return c;}}
  class TFile{constructor(p,o){Object.assign(this,file(p,o));}}
  const obsidian={Component,ItemView:class{},Menu:class{},Modal:class{},Notice:class{},Setting:class{},TFile,MarkdownView:class{},setIcon(){}};
  const src=fs.readFileSync(path.join(__dirname,'../src/features/library.js'),'utf8');
  vm.runInNewContext(src,{module:mod,require:n=>n==='obsidian'?obsidian:n==='./library-data'?L:null,window:{setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}},console});
  const handlers={},on=(name,fn)=>{(handlers[name]??=[]).push(fn);return {};};
  const files=[new TFile('assets/a.png',{mtime:2}),new TFile('assets/b.jpg',{mtime:3}),new TFile('wall.jpg'),new TFile('note.md')];
  const plugin={data:{settings:{glass:true,decorImage:'wall.jpg'},library:L.loadLibrary({ratings:{'assets/a.png':3}})},
    saved:0,changed(){this.saved++;},registerView(){},addRibbonIcon(){},addCommand(){},
    app:{vault:{on,getFiles:()=>files,getAbstractFileByPath:p=>files.find(f=>f.path===p)||null,getResourcePath:f=>'app://'+f.path},
      metadataCache:{on,resolvedLinks:{'note.md':{'assets/a.png':1}}},workspace:{getLeavesOfType:()=>[]}}};
  const lib=new mod.exports.Library(plugin);lib.onload();
  return {lib,plugin,handlers,files,TFile,exports:mod.exports};
}
test('the index: images with ratings, which are used (the corner picture counts), and their notes',()=>{
  const {lib,plugin,handlers,TFile}=loadLibrary();
  assert.deepEqual(lib.items().map(i=>[i.path,i.used,i.rating]),[['assets/a.png',true,3],['assets/b.jpg',false,0],['wall.jpg',true,0]]);
  assert.deepEqual(lib.refsOf('assets/a.png'),['note.md']);assert.deepEqual(Array.from(lib.refsOf('assets/b.jpg')),[]);
  lib.setRating('assets/b.jpg',5);assert.equal(plugin.saved,1);assert.equal(lib.items().find(i=>i.path==='assets/b.jpg').rating,5);
  lib.setTags('assets/b.jpg',['封面','封面','#配色']);assert.deepEqual(lib.items().find(i=>i.path==='assets/b.jpg').tags,['封面','配色']);
  // Only pictures and folders invalidate the index; notes come and go all the time.
  lib.items();handlers.create.forEach(fn=>fn(new TFile('新笔记.md')));assert.ok(lib.cache,'a new note leaves the index alone');
  handlers.create.forEach(fn=>fn(new TFile('assets/c.webp')));assert.equal(lib.cache,null);
  // A size learnt from a thumbnail sticks to the item.
  lib.setDims('assets/a.png',1964,2740);assert.equal(lib.items().find(i=>i.path==='assets/a.png').h,2740);
  // Deleting a folder forgets its ratings and tags; new links rebuild who is used.
  handlers.delete.forEach(fn=>fn({path:'assets'}));
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.data.library)),{ratings:{},tags:{}});
  plugin.app.metadataCache.resolvedLinks={'note.md':{'assets/b.jpg':1}};handlers.resolved.forEach(fn=>fn());
  assert.deepEqual(lib.items().filter(i=>i.used).map(i=>i.path),['assets/b.jpg','wall.jpg']);
});
test('a saved filter is cleaned before use',()=>{
  const {cleanFilter}=loadLibrary().exports;
  const plain=x=>JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(cleanFilter(null)),{scope:{kind:'all',value:''},text:'',type:'all',shape:'all',rating:'all',sort:'new',size:'m'});
  assert.deepEqual(plain(cleanFilter({scope:{kind:'folder',value:'assets'},type:'gif',shape:'tall',rating:'4',sort:'large',size:'xl'})),
    {scope:{kind:'folder',value:'assets'},text:'',type:'gif',shape:'all',rating:'4',sort:'large',size:'m'});
  assert.equal(cleanFilter({scope:{kind:'evil',value:1}}).scope.kind,'all');
});
test('library styles ship with the plugin: tokens reach the pane, the side list folds in narrow panes',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/Source: src\/styles\/library\.css/);
  assert.match(css,/\.aw-lib \{\s*container-type: inline-size;/);
  assert.match(css,/@container \(max-width: 559px\) \{\s*\.aw-lib-side \{display: none;\}/);
  assert.match(css,/\.aw-lib-card:is\(:hover,:focus-within,\.is-rated\) \.aw-lib-stars \{opacity: 1;\}/,'stars show once rated or on hover');
});
