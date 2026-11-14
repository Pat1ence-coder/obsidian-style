'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const format=require('../src/features/figure-format');
test('wiki image syntax stays two lines and replaces an existing size',()=>{
  assert.equal(format.figureMarkdown('![[附件/损失.png|320]]','图 1 · 损失曲线','640','center'),'> [!figure|center] 图 1 · 损失曲线\n> ![[附件/损失.png|640]]');
});
test('Markdown images preserve escaped URLs and alt text; original size is supported',()=>{
  assert.equal(format.figureMarkdown('![曲线|320](assets/loss%20plot.png)','结果','','left'),'> [!figure|left] 结果\n> ![曲线](assets/loss%20plot.png)');
  assert.match(format.figureMarkdown('![[a.png|200]]','结果','', 'right'),/!\[\[a.png\]\]/);
});
test('invalid sizes/references are rejected and caption newlines cannot break the callout',()=>{
  for(const width of ['-1','0','5000','abc','10%'])assert.throws(()=>format.figureMarkdown('![[a.png]]','caption',width));
  assert.throws(()=>format.figureMarkdown('[[note]]','caption'));
  assert.throws(()=>format.figureMarkdown('![[a.png]] ![[b.png]]','caption'));
  assert.throws(()=>format.figureMarkdown('![a](a.png) ![b](b.png)','caption'));
  assert.throws(()=>format.figureMarkdown('![[a.png]]',''));
  assert.equal(format.figureMarkdown('![[a.png]]','第一行\n第二行').split('\n').length,2);
});
test('insertion separates a figure from adjacent text without excessive blank lines',()=>{
  assert.equal(format.spacedFigure('正文','后文','FIG'),'\n\nFIG\n\n');
  assert.equal(format.spacedFigure('正文\n\n','\n\n后文','FIG'),'FIG');
  assert.equal(format.spacedFigure('','','FIG'),'FIG\n');
});
function fixture() {
  const notices=[],created=[],files=new Map();let content='正文',selection='',changedFile=false;
  class Modal {constructor(app){this.app=app;this.contentEl={empty(){}};}close(){this.onClose();}}
  class TFile {constructor(path){this.path=path;this.extension='md';}}
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/figures.js'),'utf8'),{
    module:mod,require:name=>name==='obsidian'?{Component:class{},Modal,FuzzySuggestModal:class{},Setting:class{},Notice:class{constructor(t){notices.push(t);}},TFile}:format
  });
  const source=new TFile('笔记/a.md');const existing=new TFile('附件/old.png');files.set(existing.path,existing);
  const feature={stopped:false,modals:new Set(),app:{vault:{getAbstractFileByPath:p=>files.get(p),createBinary:async(p,bytes)=>{
    created.push([p,bytes]);const file=new TFile(p);files.set(p,file);return file;
  }},fileManager:{getAvailablePathForAttachment:async name=> '附件/'+name,generateMarkdownLink:file=>`[[${file.path}]]`}}};
  const ctx={get file(){return changedFile?null:source;}};
  const editor={getValue:()=>content,getSelection:()=>selection,getCursor:()=>({line:0,ch:2}),getRange:()=>'',lastLine:()=>0,getLine:()=>content,replaceRange:value=>content+=value,focus(){}};
  const modal=new mod.exports.FigureModal(feature,editor,ctx);modal.caption='图 1 · 测试';modal.insertButton={setDisabled(){}};
  return {modal,feature,existing,created,notices,get content(){return content;},change(){content+='外部编辑';},switchFile(){changedFile=true;}};
}
test('existing image insertion adds a native figure without copying an attachment',async()=>{
  const f=fixture();f.modal.sources[0].existing=f.existing;await f.modal.insert();
  assert.match(f.content,/> \[!figure\|center\]/);assert.match(f.content,/old.png\|640/);assert.equal(f.created.length,0);assert.equal(f.feature.modals.size,0);
});
test('local image import uses attachment destination and creates one image',async()=>{
  const f=fixture();f.modal.sources[0].local={name:'new.png',arrayBuffer:async()=>new ArrayBuffer(4)};
  await Promise.all([f.modal.insert(),f.modal.insert()]);
  assert.equal(f.created.length,1);assert.equal(f.created[0][0],'附件/new.png');assert.match(f.content,/new.png/);
});
test('changed note and cancelled modal never insert stale text or copy attachments',async()=>{
  const f=fixture();f.modal.sources[0].local={name:'new.png',arrayBuffer:async()=>new ArrayBuffer(4)};f.change();await f.modal.insert();
  assert.equal(f.created.length,0);assert.doesNotMatch(f.content,/figure/);assert.ok(f.notices.length);
  const g=fixture();g.modal.sources[0].existing=g.existing;g.modal.close();await g.modal.insert();assert.doesNotMatch(g.content,/figure/);
});

test('grid-2 emits two ordered image lines and removes per-image widths',()=>{
  assert.equal(format.figureMarkdown(['![[A.png|640]]','![B|320](B.png)'],'图 2 · 对比','640','grid-2'),
    '> [!figure|grid-2] 图 2 · 对比\n> ![[A.png]]\n> ![B](B.png)');
  assert.throws(()=>format.figureMarkdown(['![[A.png]]'],'对比','','grid-2'));
  assert.throws(()=>format.figureMarkdown(['![[A.png]]','![[B.png]]'],'对比','','center'));
});
test('paired insert imports both files and inserts one complete figure',async()=>{
  const f=fixture();f.modal.layout='grid-2';
  f.modal.sources=[{local:{name:'left.png',arrayBuffer:async()=>new ArrayBuffer(2)}},{local:{name:'right.png',arrayBuffer:async()=>new ArrayBuffer(2)}}];
  await f.modal.insert();
  assert.deepEqual(f.created.map(x=>x[0]),['附件/left.png','附件/right.png']);
  assert.match(f.content,/> \[!figure\|grid-2\]/);assert.ok(f.content.indexOf('left.png')<f.content.indexOf('right.png'));
  assert.equal((f.content.match(/!\[\[/g)||[]).length,2);
});
test('incomplete pair is rejected before importing anything',async()=>{
  const f=fixture();f.modal.layout='grid-2';f.modal.sources[0].local={name:'left.png',arrayBuffer:async()=>new ArrayBuffer(2)};
  await f.modal.insert();assert.equal(f.created.length,0);assert.doesNotMatch(f.content,/figure/);
});
test('failure of second import leaves note intact and retry reuses first image',async()=>{
  const f=fixture();f.modal.layout='grid-2';
  f.modal.sources=[{local:{name:'left.png',arrayBuffer:async()=>new ArrayBuffer(2)}},{local:{name:'right.png',arrayBuffer:async()=>new ArrayBuffer(2)}}];
  const original=f.feature.app.vault.createBinary;let failed=false;
  f.feature.app.vault.createBinary=async(path,data)=>{
    if(path.endsWith('right.png')&&!failed){failed=true;throw Error('disk error');}
    return original(path,data);
  };
  await f.modal.insert();assert.doesNotMatch(f.content,/figure/);assert.equal(f.created.length,1);
  await f.modal.insert();assert.equal(f.created.length,2);assert.match(f.content,/grid-2/);
});

test('grid column count does not limit image count or truncate incomplete final rows',()=>{
  const refs=Array.from({length:11},(_,i)=>`![[image-${i}.png]]`);
  for(const columns of [1,2,3,4]){
    const result=format.figureMarkdown(refs,'结果比较','','grid-'+columns);
    assert.equal(result.split('\n').length,12);
    refs.forEach(ref=>assert.ok(result.includes(ref)));
  }
});
test('batch additions, moving and removal preserve the full ordered list',()=>{
  const f=fixture();
  f.modal.addSources(Array.from({length:6},(_,i)=>({reference:`![[${i}.png]]`})));
  assert.equal(f.modal.sources.length,6);assert.equal(f.modal.layout,'grid-2');
  f.modal.moveSource(5,-1);assert.equal(f.modal.sources[4].reference,'![[5.png]]');
  f.modal.removeSource(0);assert.equal(f.modal.sources.length,5);assert.equal(f.modal.sources[0].reference,'![[1.png]]');
  f.modal.moveSource(0,-1);assert.equal(f.modal.sources[0].reference,'![[1.png]]');
  f.modal.busy=true;f.modal.removeSource(0);assert.equal(f.modal.sources.length,5);
});
test('multi-image import inserts every file once in selected order',async()=>{
  const f=fixture();f.modal.layout='grid-3';
  f.modal.sources=Array.from({length:8},(_,i)=>({local:{name:`multi-${i}.png`,arrayBuffer:async()=>new ArrayBuffer(2)}}));
  await f.modal.insert();
  assert.equal(f.created.length,8);assert.match(f.content,/figure\|grid-3/);
  assert.equal((f.content.match(/!\[\[/g)||[]).length,8);
  for(let i=1;i<8;i++)assert.ok(f.content.indexOf(`multi-${i-1}.png`)<f.content.indexOf(`multi-${i}.png`));
});
test('mosaic layouts emit every image in order and need at least two',()=>{
  assert.equal(format.figureMarkdown(['![[big.png|900]]','![[a.png]]','![[b.png]]'],'图 4 · 一大两小','640','mosaic-left'),
    '> [!figure|mosaic-left] 图 4 · 一大两小\n> ![[big.png]]\n> ![[a.png]]\n> ![[b.png]]');
  assert.match(format.figureMarkdown(['![[a.png]]','![[b.png]]'],'图','','mosaic-right'),/^> \[!figure\|mosaic-right\]/);
  assert.throws(()=>format.figureMarkdown(['![[a.png]]'],'图','','mosaic-left'));
  assert.throws(()=>format.figureMarkdown(['![[a.png]]','![[b.png]]'],'图','','mosaic-up'));
});
