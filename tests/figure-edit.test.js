'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const E=require('../src/features/figure-edit'),Edit=E;
const note=`正文

> [!figure|center] 图 1 · 训练损失
> ![[附件/loss.png|640]]

> [!figure|grid-2] 图 2 · 对比
> ![[a.png]]
> ![B|300](b%20c.png)
>
> ![[c.svg]]
后续段落`.split('\n');
test('finds a figure block from any line inside it and lists one image per line',()=>{
  const single=E.findBlock(note,3);
  assert.deepEqual([single.start,single.end,single.meta,single.caption],[2,3,'center',' 图 1 · 训练损失']);
  assert.deepEqual(single.images,[{line:3,at:0,width:640}]);
  const grid=E.findBlock(note,9);
  assert.deepEqual([grid.start,grid.end,grid.meta],[5,9,'grid-2']);
  assert.deepEqual(grid.images.map(i=>i.line),[6,7,9]);
  assert.equal(E.findBlock(note,0),null);assert.equal(E.findBlock(note,10),null);
  assert.equal(E.findBlock(['> [!note] 普通提示','> ![[x.png]]'],1),null);
});
test('width edits rewrite only the embed size, for wiki and Markdown images',()=>{
  const single=E.findBlock(note,2);
  assert.equal(E.setWidth(note,single,0,480)[3],'> ![[附件/loss.png|480]]');
  assert.equal(E.setWidth(note,single,0,null)[3],'> ![[附件/loss.png]]');
  const grid=E.findBlock(note,6);
  assert.equal(E.setWidth(note,grid,1,420)[7],'> ![B|420](b%20c.png)');
  assert.equal(E.setWidth(note,grid,0,200)[6],'> ![[a.png|200]]');
  assert.throws(()=>E.setWidth(note,single,0,0));assert.throws(()=>E.setWidth(note,single,3,100));
  assert.equal(note[3],'> ![[附件/loss.png|640]]','input lines are never mutated');
});
test('layout edits keep caption and fold marker; single and grid stay in their families',()=>{
  const single=E.findBlock(note,2);
  assert.equal(E.setMeta(note,single,'left')[2],'> [!figure|left] 图 1 · 训练损失');
  assert.equal(E.setMeta(['> [!figure|right]- 图 9','> ![[x.png]]'],E.findBlock(['> [!figure|right]- 图 9','> ![[x.png]]'],0),'center')[0],'> [!figure|center]- 图 9');
  const grid=E.findBlock(note,5);
  assert.equal(E.setMeta(note,grid,'grid-3')[5],'> [!figure|grid-3] 图 2 · 对比');
  assert.throws(()=>E.setMeta(note,single,'grid-2'));assert.throws(()=>E.setMeta(note,grid,'left'));assert.throws(()=>E.setMeta(note,grid,'grid-9'));
});
test('reordering moves image lines and leaves blank quoted lines in place',()=>{
  const grid=E.findBlock(note,5);
  const moved=E.moveImage(note,grid,2,0);
  assert.deepEqual(moved.slice(6,10),['> ![[c.svg]]','> ![[a.png]]','>','> ![B|300](b%20c.png)']);
  const back=E.moveImage(note,grid,0,2);
  assert.deepEqual(back.slice(6,10),['> ![B|300](b%20c.png)','> ![[c.svg]]','>','> ![[a.png]]']);
  assert.throws(()=>E.moveImage(note,grid,0,5));
});
test('caption labels follow Chinese and English academic numbering',()=>{
  assert.deepEqual(E.captionLabel('图 1 · 训练损失'),{label:'图 1',rest:' · 训练损失'});
  assert.deepEqual(E.captionLabel('表 2-3 消融结果'),{label:'表 2-3',rest:' 消融结果'});
  assert.equal(E.captionLabel('Fig. 4: curves').label,'Fig. 4');assert.equal(E.captionLabel('Table 5.1 x').label,'Table 5.1');
  assert.equal(E.captionLabel('训练损失曲线'),null);
});

function loadTools() {
  const notices=[];class TFile {constructor(path){this.path=path;}}
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/figure-tools.js'),'utf8'),{module:mod,require:name=>{
    if(name==='obsidian')return {Component:class{addChild(c){return c;}registerEvent(){}},Notice:class{constructor(t){notices.push(t);}},Setting:class{},TFile,setIcon(){}};
    if(name==='./figure-edit')return Edit;
    throw Error(name);
  }});
  return {...mod.exports,TFile,notices};
}
const textNode=text=>({nodeType:3,textContent:text});
function titleEl(text) {
  const children=[textNode(text)];
  return {children,get firstChild(){return children[0];},querySelector:sel=>children.find(c=>sel==='.aw-caption-label'&&c.className==='aw-caption-label')||null,
    ownerDocument:{createElement:()=>({nodeType:1})},insertBefore(node,ref){children.splice(children.indexOf(ref),0,node);}};
}
test('caption labels are split into a bold span once, and plain captions are left alone',()=>{
  const {markLabel}=loadTools();
  const t=titleEl('图 3-2 训练曲线');markLabel(t);markLabel(t);
  assert.equal(t.children.length,2);assert.equal(t.children[0].className,'aw-caption-label');
  assert.equal(t.children[0].textContent,'图 3-2');assert.equal(t.children[1].textContent,' 训练曲线');
  const plain=titleEl('训练曲线');markLabel(plain);assert.equal(plain.children.length,1);
});
test('reading-view edits find the figure where its section is now, in the file the view shows now',async()=>{
  const {FigureTools,TFile,notices}=loadTools();
  let data='前文\r\n> [!figure|center] 图 1 结果\r\n> ![[a.png]]\r\n后文',writes=0;
  const file=new TFile('改过名字.md');
  const vault={process:async(f,fn)=>{assert.equal(f,file,'the file of the view, not a path kept from rendering');const next=fn(data);if(next!==data)writes++;data=next;}};
  const figure={closest:()=>null},view={file,containerEl:{contains:el=>el===figure}};
  const tools=new FigureTools({app:{workspace:{getLeavesOfType:()=>[{view}]},vault},data:{settings:{}}});
  // Obsidian's renderer: where the section starts now, and the text the view shows.
  let start=1,shown=null;
  const ctx={getSectionInfo:()=>({text:shown??data,lineStart:start,lineEnd:start+1})};
  tools.process({querySelectorAll:sel=>sel.endsWith('-inner')?[]:[figure],matches:()=>false},ctx);
  assert.equal(await tools.edit(figure,(lines,block)=>Edit.setWidth(lines,block,0,480)),true);
  assert.equal(data,'前文\r\n> [!figure|center] 图 1 结果\r\n> ![[a.png|480]]\r\n后文','CRLF line endings survive');
  // A paragraph added above: Obsidian moves the section without running post-processors again.
  data='新段落\r\n\r\n'+data;start=3;
  assert.equal(await tools.edit(figure,(lines,block)=>Edit.setMeta(lines,block,'left')),true,notices.join());
  assert.match(data.split('\r\n')[3],/^> \[!figure\|left\] 图 1 结果$/);
  // Nothing to change: nothing written, and the caller learns so (a resize preview is undone).
  assert.equal(await tools.edit(figure,lines=>lines),false);assert.equal(writes,2);
  // The file changed and the view has not caught up yet: refused rather than guessed.
  shown=data;data=data.replace('![[a.png|480]]','![[b.png|480]]');
  assert.equal(await tools.edit(figure,(lines,block)=>Edit.setWidth(lines,block,0,300)),false);
  assert.match(notices.at(-1),/笔记内容已变化/);assert.match(data,/b\.png\|480/);
  // A figure the plugin never saw rendered.
  assert.equal(await tools.edit({closest:()=>null},lines=>lines),false);assert.match(notices.at(-1),/无法定位/);
});
test('figures in embedded notes and hover previews get no toolbar: their lines are not the host note\'s',async()=>{
  const {FigureTools,notices}=loadTools();
  const embedded={closest:sel=>sel==='.markdown-embed,.hover-popover'||sel==='.markdown-source-view'||sel.includes('markdown-preview-view')?{}:null};
  const tools=new FigureTools({app:{workspace:{getLeavesOfType:()=>[{view:{editor:{},containerEl:{contains:()=>true}}}]}},data:{settings:{figureTools:true}}});
  tools.hover({target:{closest:()=>embedded}});
  assert.equal(tools.decorated.has(embedded),false);
  assert.equal(await tools.edit(embedded,lines=>lines),false);assert.match(notices.at(-1),/无法定位/);
});
test('several images on one line: each is found by its place, and edits by number check the count',()=>{
  const lines=['> [!figure|grid-3] 图 5','> ![[a.png]] ![[b.png|200]]','> ![[c.png|300]]'];
  const block=E.findBlock(lines,0);
  assert.deepEqual(block.images,[{line:1,at:0,width:null},{line:1,at:1,width:200},{line:2,at:0,width:300}]);
  assert.equal(E.setWidth(lines,block,0,150)[1],'> ![[a.png|150]] ![[b.png|200]]','the first image, not c.png');
  assert.equal(E.setWidth(lines,block,1,null)[1],'> ![[a.png]] ![[b.png]]');
  assert.deepEqual(E.moveImage(lines,block,2,0).slice(1),['> ![[c.png|300]] ![[a.png]]','> ![[b.png|200]]'],'embeds trade places');
  assert.deepEqual(E.moveImage(lines,block,0,1).slice(1),['> ![[b.png|200]] ![[a.png]]','> ![[c.png|300]]']);
  const {numbered}=loadTools();
  const figure=n=>({querySelectorAll:()=>Array(n).fill({})});
  assert.equal(numbered(figure(3),(l,b)=>E.setWidth(l,b,2,100))(lines,block)[2],'> ![[c.png|100]]');
  assert.throws(()=>numbered(figure(2),(l,b)=>E.setWidth(l,b,0,100))(lines,block),/对不上/,'a web image the toolbar does not number');
});
test('mosaic layouts belong to the multi-image family',()=>{
  const grid=E.findBlock(note,5),single=E.findBlock(note,2);
  assert.equal(E.setMeta(note,grid,'mosaic-left')[5],'> [!figure|mosaic-left] 图 2 · 对比');
  assert.equal(E.setMeta(note,grid,'mosaic-right')[5],'> [!figure|mosaic-right] 图 2 · 对比');
  assert.throws(()=>E.setMeta(note,single,'mosaic-left'));assert.throws(()=>E.setMeta(note,grid,'mosaic-top'));
  const mosaic=E.setMeta(note,grid,'mosaic-left');
  assert.equal(E.setMeta(mosaic,E.findBlock(mosaic,6),'grid-3')[5],'> [!figure|grid-3] 图 2 · 对比');
  assert.ok(E.isGroup('mosaic-right')&&E.isGroup('grid-1')&&!E.isGroup('center'));
});
test('drag targets: the nearest slot within reach, and widths that snap to column fractions',()=>{
  const {nearestSlot,snapWidth}=loadTools();
  const slots=[{left:0,top:0,width:100,height:80},{left:120,top:0,width:100,height:80},{left:0,top:100,width:100,height:80}];
  assert.equal(nearestSlot(slots,50,40),0,'inside a slot wins');
  assert.equal(nearestSlot(slots,230,40),1,'just outside, nearest edge');
  assert.equal(nearestSlot(slots,60,95),2,'between rows, closer to the lower one');
  assert.equal(nearestSlot(slots,600,40),-1,'out of reach cancels');
  assert.deepEqual({...snapWidth(356,720)},{width:360,fraction:.5});
  assert.deepEqual({...snapWidth(715,720)},{width:720,fraction:1});
  assert.deepEqual({...snapWidth(300,720)},{width:300,fraction:null});
});
test('layouts come from one list: strict for writing, prefix-based for the rendered family',()=>{
  const F=require('../src/features/figure-format');
  for(const meta of ['left','center','right','grid-1','grid-4','mosaic-left','mosaic-right'])assert.ok(F.LAYOUT.test(meta),meta);
  assert.ok(!F.LAYOUT.test('grid-5')&&!F.GROUP.test('grid-5'));
  assert.equal(E.isGroup,F.isGroup,'figure-edit reuses the shared family test');
  assert.ok(F.isGroup('grid-5'),'an unknown grid still renders (and edits) as a group');
  const odd=['> [!figure|grid-5] 图 4','> ![[a.png]]','> ![[b.png]]'];
  assert.equal(E.setMeta(odd,E.findBlock(odd,0),'grid-2')[0],'> [!figure|grid-2] 图 4','a stray grid can be repaired');
  assert.throws(()=>E.setMeta(odd,E.findBlock(odd,0),'left'));assert.throws(()=>E.setMeta(odd,E.findBlock(odd,0),'grid-5'));
});
test('width snapping picks the closest fraction when neighbouring ones overlap',()=>{
  const {snapWidth}=loadTools();
  assert.deepEqual({...snapWidth(142,200)},{width:150,fraction:.75},'3/4 (8px away) beats 2/3 (8.7px away)');
  assert.deepEqual({...snapWidth(136,200)},{width:133,fraction:2/3});
});

// A tiny DOM for gesture tests: rects move up by doc.scrollY to mimic scrolling.
function gestureDom() {
  const listeners={};
  const doc={scrollY:0,
    addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    removeEventListener(type,fn){listeners[type]=(listeners[type]||[]).filter(f=>f!==fn);},
    fire(type,event={}){for(const fn of [...(listeners[type]||[])])fn(event);},
    count:()=>Object.values(listeners).reduce((n,l)=>n+l.length,0),
    createElement:()=>node()};
  function node(rect={left:0,top:0,width:0,height:0},classes=''){
    const set=new Set(classes.split(' ').filter(Boolean));
    const n={ownerDocument:doc,style:{},dataset:{},children:[],parent:null,hidden:false,className:classes,rect,
      classList:{add:(...c)=>c.forEach(x=>set.add(x)),remove:(...c)=>c.forEach(x=>set.delete(x)),contains:c=>set.has(c),toggle:(c,on)=>on?set.add(c):set.delete(c)},
      getBoundingClientRect:()=>({left:n.rect.left,top:n.rect.top-doc.scrollY,width:n.rect.width,height:n.rect.height}),
      appendChild(child){child.parent=n;n.children.push(child);return child;},
      remove(){if(n.parent){n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=null;}},
      querySelector:sel=>n.q?.[sel]??null,querySelectorAll:sel=>n.qa?.[sel]??[],closest:()=>null};
    return n;
  }
  doc.body=node();
  return {doc,node};
}
function resizeSetup() {
  const {FigureTools,notices}=loadTools(),{doc,node}=gestureDom();
  const tools=new FigureTools({app:{workspace:{getLeavesOfType:()=>[]},vault:{}},data:{settings:{}}});
  const figure=node({left:0,top:0,width:900,height:500}),content=node({left:0,top:0,width:900,height:460});
  const embed=node(),img=node({left:90,top:0,width:720,height:400});
  // The rendered width follows the inline width, capped at 720px unless the cap is lifted.
  img.getBoundingClientRect=()=>{const w=img.style.width?parseFloat(img.style.width):720,cap=img.style.maxWidth?Infinity:720;return {left:90,top:0,width:Math.min(w,cap),height:400};};
  figure.dataset.calloutMetadata='center';figure.q={':scope > .callout-content':content};figure.qa={'.image-embed':[embed]};embed.q={img};
  return {tools,doc,figure,embed,img,notices};
}
test('a resize whose write-back fails puts the image back and clears the size label',async()=>{
  const {tools,doc,figure,embed,img,notices}=resizeSetup();
  tools.startResize({clientX:810},figure,embed,0);
  assert.ok(figure.classList.contains('aw-figure-resizing'));assert.equal(embed.style.width,'fit-content');
  doc.fire('pointermove',{clientX:542});
  assert.equal(img.style.width,'450px');assert.match(embed.dataset.awWidth,/450px · 50%/);
  doc.fire('pointerup');await new Promise(r=>setImmediate(r));
  assert.match(notices.at(-1),/无法定位/,'the write fails: the figure is in no Markdown view');
  assert.equal(img.style.width,'');assert.equal(embed.style.width,'');assert.equal(img.style.maxWidth,'');
  assert.equal(embed.dataset.awWidth,undefined);assert.ok(!figure.classList.contains('aw-figure-resizing'));
  assert.equal(doc.count(),0,'all gesture listeners are gone');
});
test('a resize can snap to the full column even when unsized images are capped at 720px',async()=>{
  const {tools,doc,figure,embed,img}=resizeSetup();
  let written=null;tools.edit=async(_f,change)=>{written=change;return true;};
  tools.startResize({clientX:810},figure,embed,0);
  doc.fire('pointermove',{clientX:985});
  assert.equal(img.style.width,'900px');assert.match(embed.dataset.awWidth,/^900px · 整列$/);
  doc.fire('pointerup');await new Promise(r=>setImmediate(r));
  const lines=['> [!figure|center] 图 1','> ![[a.png]]'];
  assert.equal(written(lines,Edit.findBlock(lines,0))[1],'> ![[a.png|900]]');
  assert.equal(img.style.width,'900px','after a successful write the preview stays until the note re-renders');
  assert.equal(embed.dataset.awWidth,undefined,'but the size label goes away');
});
test('a cancelled pointer or Escape abandons a drag and removes every overlay',()=>{
  const {tools,doc,figure,embed}=resizeSetup();
  tools.startResize({clientX:810},figure,embed,0);
  doc.fire('pointermove',{clientX:180});
  doc.fire('pointercancel');
  assert.equal(embed.style.width,'');assert.equal(figure.children.length,0,'snap guide removed');assert.equal(doc.count(),0);
  embed.qa={};figure.qa={'.image-embed':[embed]};embed.q.img.src='a.png';
  tools.startAlign({clientX:400,clientY:100},figure,embed);
  assert.ok(doc.body.children.length===1&&figure.children.length>0,'ghost and outlines are up');
  let stopped=false,prevented=false;
  doc.fire('keydown',{key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(stopped&&prevented,'Escape is consumed, not passed on to the editor');
  assert.equal(doc.body.children.length,0);assert.equal(figure.children.length,0);
  assert.ok(!figure.classList.contains('aw-figure-moving')&&!embed.classList.contains('aw-figure-dragging'));
});
test('reordering targets stay right when the page scrolls during the drag',async()=>{
  const {FigureTools}=loadTools(),{doc,node}=gestureDom();
  const tools=new FigureTools({app:{workspace:{},vault:{}},data:{settings:{}}});
  const figure=node({left:0,top:100,width:440,height:700});
  const embeds=[[0,100],[220,100],[0,400],[220,400]].map(([left,top])=>{const e=node({left,top,width:200,height:280});e.q={img:{src:'x.png'}};return e;});
  figure.qa={'.image-embed':embeds};figure.dataset.calloutMetadata='grid-2';
  let written=null;tools.edit=async(_f,change)=>{written=change;return true;};
  tools.startReorder({clientX:100,clientY:200},figure,embeds[0],0);
  doc.scrollY=300;
  // The third image (index 2) now sits at viewport y 100–380; point at it.
  doc.fire('pointermove',{clientX:100,clientY:200});
  const slot=figure.children.find(c=>c.className.includes('aw-figure-slot'));
  assert.equal(slot.hidden,false);assert.equal(slot.style.top,'300px','outline drawn over the third image, in figure coordinates');
  doc.fire('pointerup');await new Promise(r=>setImmediate(r));
  const lines=['> [!figure|grid-2] 图','> ![[a.png]]','> ![[b.png]]','> ![[c.png]]','> ![[d.png]]'];
  assert.deepEqual(written(lines,Edit.findBlock(lines,0)).slice(1),['> ![[b.png]]','> ![[c.png]]','> ![[a.png]]','> ![[d.png]]']);
});

test('Live Preview figure edits go straight to CodeMirror without scrolling to the cursor',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const Edit=require('../src/features/figure-edit');
  const mod={exports:{}},notices=[];
  const obsidian={Component:class{},Notice:class{constructor(m){notices.push(m);}},Setting:class{},TFile:class{},setIcon(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/figure-tools.js'),'utf8'),{module:mod,require:n=>n==='obsidian'?obsidian:n==='./figure-edit'?Edit:null});
  // A note with the figure on lines 3-4 (0-based 2-3); the cursor sits at the top.
  let text=['# 标题','正文','> [!figure|center] 图 1','> ![[a.png|400]]','后文'].join('\n');
  const lineStarts=()=>{const s=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')s.push(i+1);return s;};
  const doc={line:n=>{const s=lineStarts(),from=s[n-1],to=(n<s.length?s[n]-1:text.length);return {number:n,from,to};},
    lineAt:pos=>{const s=lineStarts();let n=s.length;while(s[n-1]>pos)n--;return {number:n};}};
  const dispatched=[];
  const cm={state:{doc},posAtDOM:()=>lineStarts()[2],dispatch:tr=>{dispatched.push(tr);const c=tr.changes;text=text.slice(0,c.from)+c.insert+text.slice(c.to);}};
  const editor={cm,getValue:()=>text,replaceRange(){throw Error('replaceRange scrolls the cursor into view');}};
  const app={workspace:{getLeavesOfType:()=>[{view:{editor,containerEl:{contains:()=>true}}}]},vault:{getAbstractFileByPath:()=>null}};
  const tools=new mod.exports.FigureTools({app,data:{settings:{figureTools:true}}});
  const figure={closest:sel=>sel==='.markdown-source-view'?{}:null,dataset:{}};
  assert.equal(await tools.edit(figure,(lines,block)=>Edit.setMeta(lines,block,'right')),true,notices.join());
  assert.equal(dispatched.length,1);
  assert.equal(dispatched[0].scrollIntoView,undefined,'no scrolling to the cursor (it was at the top)');
  assert.equal(dispatched[0].userEvent,'set.figure','not counted as writing, and its own undo step');
  assert.equal(text,['# 标题','正文','> [!figure|right] 图 1','> ![[a.png|400]]','后文'].join('\n'),'only the figure block changed');
  assert.equal(await tools.edit(figure,(lines,block)=>Edit.setMeta(lines,block,'right')),false,'no change: nothing dispatched');
  assert.equal(dispatched.length,1);
});
