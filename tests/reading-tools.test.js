'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const A=require('../src/features/annotation-format');
const root=path.resolve(__dirname,'..');

test('annotation syntax: {note} or {note|options} right after the highlight; defaults are right-below, blue, double line',()=>{
  const p=t=>{const r=A.parseAnnotation(t);return r&&{note:r.note,dir:r.dir,color:r.color,custom:r.custom,line:r.line,highlight:r.highlight,rest:r.rest};};
  assert.deepEqual(p('{标注下}，然后继续'),{note:'标注下',dir:'se',color:'blue',custom:null,line:'double',highlight:true,rest:'，然后继续'});
  assert.deepEqual(p('{ 空格会去掉 }'),{note:'空格会去掉',dir:'se',color:'blue',custom:null,line:'double',highlight:true,rest:''});
  assert.deepEqual(p('{这是标注|左下}'),{note:'这是标注',dir:'sw',color:'blue',custom:null,line:'double',highlight:true,rest:''});
  assert.deepEqual(p('{冗长代码|右下 橙 虚线}x'),{note:'冗长代码',dir:'se',color:'orange',custom:null,line:'dashed',highlight:true,rest:'x'});
  assert.deepEqual(p('{饱和区|↗ #D0428A 无高亮}'),{note:'饱和区',dir:'ne',color:'custom',custom:'#d0428a',line:'double',highlight:false,rest:''});
  assert.equal(p('{看这里|虚线 红色}').line,'dashed');assert.equal(p('{看这里|虚线 红色}').color,'red');
  assert.equal(p('{旧写法|内联}').note,'旧写法|内联','the inline line style is gone: 内联 is just text now');
  // A "|" followed by words that aren't all options belongs to the note.
  assert.equal(p('{a|b}').note,'a|b');assert.equal(p('{输入|输出 右}').note,'输入|输出 右');
  for(const text of [' {有空格}','{}','{  }','{|右下}','{跨\n行}','{'+'长'.repeat(81)+'}','{'+'长'.repeat(81)+'|右}','(括号)'])assert.equal(A.parseAnnotation(text),null,text);
  assert.equal(A.parseAnnotation('{'+'长'.repeat(80)+'|左上 紫}').note.length,80,'options do not count toward the 80 characters');
  const src='前文 ==vertex shader=={标注下} 中间 ==只是高亮== 和 ==b=={二|上 绿}';
  const found=A.findAnnotations(src,100);
  assert.deepEqual(found.map(a=>[a.note,a.dir,a.color]),[['标注下','se','blue'],['二','n','green']]);
  for(const a of found){
    assert.equal(src.slice(a.from-100,a.to-100),src.slice(a.from-100).match(/^\{[^}]*\}/)[0]);
    assert.equal(src.slice(a.markFrom-100,a.markFrom-98),'==');assert.equal(src.slice(a.targetTo-100,a.from-100),'==');
  }
  assert.equal(src.slice(found[0].targetFrom-100,found[0].targetTo-100),'vertex shader');
});
test('annotation braces are written with defaults left out, and read back the same',()=>{
  const f=A.formatAnnotation;
  assert.equal(f({note:'标注'}),'{标注}');
  assert.equal(f({note:' 这是标注 ',dir:'sw'}),'{这是标注|左下}');
  assert.equal(f({note:'冗长代码',color:'orange',line:'dashed'}),'{冗长代码|橙 虚线}');
  assert.equal(f({note:'饱和区',dir:'ne',color:'custom',custom:'#D0428A',highlight:false}),'{饱和区|右上 #d0428a 无高亮}');
  assert.equal(f({note:'换{行}\n了'}),'{换 行 了}','braces and line breaks never leak into the note');
  assert.equal(f({note:'输入|红'}),'{输入|红|右下}','a note that looks like options gets the default position spelled out');
  for(const spec of [{note:'输入|红'},{note:'a|b',dir:'n'},{note:'看',color:'rainbow',line:'dashed'},{note:'x',color:'custom',custom:'#abc'}]){
    const back=A.parseAnnotation(f(spec));
    for(const k of Object.keys(spec))assert.equal(back[k],spec[k],`${k} of ${JSON.stringify(spec)}`);
  }
  assert.throws(()=>f({note:'  '}),/请填写/);
});

// A small DOM: enough for the annotation renderer (elements, SVG, classes, style, text).
function fakeDocument(){
  const make=tag=>{
    const n={tag,children:[],parentNode:null,className:'',attrs:{},dataset:{},textContent:'',props:{},
      style:{setProperty(k,v){n.props[k]=v;}},
      classList:{add(c){if(!n.className.split(' ').includes(c))n.className=(n.className+' '+c).trim();},contains:c=>n.className.split(' ').includes(c)},
      appendChild(c){c.parentNode=n;n.children.push(c);return c;},
      insertBefore(c,ref){c.parentNode=n;n.children.splice(ref?n.children.indexOf(ref):n.children.length,0,c);return c;},
      setAttribute(k,v){n.attrs[k]=v;if(k==='class')n.className=v;},
      get nextSibling(){const s=n.parentNode?.children;return s?s[s.indexOf(n)+1]??null:null;},
      querySelectorAll(sel){const out=[];const walk=x=>{for(const c of x.children||[]){if(c.tag===sel)out.push(c);walk(c);}};walk(n);return out;}};
    return n;
  };
  return {createElement:make,createElementNS:(_ns,tag)=>make(tag),createTextNode:text=>({nodeType:3,textContent:text,parentNode:null})};
}
const text=(node)=>node.nodeType===3?node.textContent:(node.children||[]).map(text).join('')||node.textContent||'';
function loadModule(file,extra={}){
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/features',file),'utf8'),{module:mod,require:name=>{
    if(name in extra)return extra[name];
    if(name==='./annotation-format')return A;
    throw Error(name);
  },requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout});
  return mod.exports;
}
const obsidianStub={Component:class{registerEvent(){}},Modal:class{},Notice:class{},Setting:class{}};
function readingView(source){
  const {Annotations}=loadModule('annotations.js',{obsidian:obsidianStub,'@codemirror/view':{},'@codemirror/language':{}});
  const doc=fakeDocument(),p=doc.createElement('p');
  // "<mark>target</mark>{...}rest" for each "==target=={...}"; other text stays text.
  for(const part of source.split(/(==[^=]+==)/).filter(Boolean)){
    if(/^==.+==$/.test(part)){const m=doc.createElement('mark');m.appendChild(doc.createTextNode(part.slice(2,-2)));m.textContent=part.slice(2,-2);p.appendChild(m);}
    else p.appendChild(doc.createTextNode(part));
  }
  const el={ownerDocument:doc,querySelectorAll:sel=>p.querySelectorAll(sel)};
  new Annotations({app:{workspace:{on(){}}}}).process(el);
  return p;
}
test('reading view: an annotation tints its target and pins the note to it; 右 and 左 sit in the text flow',()=>{
  const p=readingView('前文 ==decryption method=={标注}。中间 ==只是高亮== 后文');
  const [mark,plain]=p.querySelectorAll('mark');
  assert.match(mark.className,/aw-annot-target aw-annot-c-blue aw-annot-holds aw-annot-keep/,'a short target is kept on one line');
  const note=mark.children.at(-1);
  assert.equal(note.textContent,'\u2060','a word joiner glues the note to the target\'s last character');
  assert.match(note.className,/aw-annot aw-annot-se aw-annot-double aw-annot-c-blue aw-annot-pinned/);
  assert.deepEqual(note.children.map(c=>c.className),['aw-annot-room','aw-annot-pin']);
  const pin=note.children[1];
  assert.equal(pin.children[0].attrs.class,'aw-annot-arrow');assert.equal(pin.children[0].children.filter(c=>c.tag==='line').length,2,'double leader');
  assert.equal(pin.children[1].textContent,'标注');assert.equal(note.attrs.title,'标注：标注');
  assert.equal(text(p),'前文 decryption method标注。中间 只是高亮 后文','the braces are gone, the rest of the text stays');
  assert.equal(plain.className,'','a plain highlight is left alone');
  const right=readingView('==a=={右边|右 虚线}后'),left=readingView('前==b=={左边|左 无高亮}');
  const [ra]=right.querySelectorAll('mark'),[lb]=left.querySelectorAll('mark');
  assert.equal(ra.nextSibling.className.split(' ').includes('aw-annot-flow'),true,'右: the note follows the target');
  assert.equal(ra.nextSibling.children[0].children.filter(c=>c.tag==='line').length,1,'dashed leader');
  assert.equal(left.children[1].className.includes('aw-annot-w'),true,'左: the note comes before the target');
  assert.match(lb.className,/aw-annot-plain/);assert.doesNotMatch(lb.className,/aw-annot-holds|aw-annot-keep/,'flow notes need no anchor box');
  assert.equal(ra.nextSibling.textContent,'','no word joiner in a flow note');
  const long=readingView('==这是一个超过二十四个字的很长的标注目标用来检查换行时的退化=={长}');
  assert.doesNotMatch(long.querySelectorAll('mark')[0].className,/aw-annot-keep/,'a long target may wrap, so it never overflows the line');
  const custom=readingView('==d=={粉|#d0428a}');const [cm]=custom.querySelectorAll('mark');
  assert.equal(cm.props['--aw-annot-color'],'#d0428a');assert.equal(cm.children.at(-1).props['--aw-annot-color'],'#d0428a');
});
test('Live Preview: a pinned annotation is one widget, target with the note inside; flow notes keep a mark; the source shows while the cursor is on it',()=>{
  const made=[];
  const Decoration={none:'none',set:(list,sort)=>({list,sort}),
    mark:spec=>({range:(from,to)=>({kind:'mark',spec,from,to})}),
    replace:spec=>({range:(from,to)=>({kind:'replace',spec,from,to})}),
    widget:spec=>({range:at=>({kind:'widget',spec,from:at,to:at})})};
  // Obsidian's syntax tree: tokens named by their classes joined with _; here one inline code span.
  let code=null;
  const tree={resolveInner:pos=>({type:{name:code&&code[0]<=pos&&pos<code[1]?'formatting_formatting-code_inline-code':'Document'}})};
  const {Annotations}=loadModule('annotations.js',{obsidian:{...obsidianStub,editorLivePreviewField:null},
    '@codemirror/view':{Decoration,WidgetType:class{},ViewPlugin:{fromClass:(cls,spec)=>{made.push({cls,spec});return 'plugin';}}},
    '@codemirror/language':{syntaxTree:()=>tree}});
  const plugin={registerMarkdownPostProcessor(){},registerEditorExtension(){},app:{workspace:{on(){}}}};
  const a=new Annotations(plugin);a.registerEvent=()=>{};a.onload();
  const source='x ==ab=={标注} y ==cd=={左边|左} ==ef=={粉|#d0428a 右}';
  const view=sel=>({state:{doc:{lineAt:()=>({from:0,to:source.length})},sliceDoc:(f,t)=>source.slice(f,t),selection:{ranges:[{from:sel,to:sel}]},field:()=>true},visibleRanges:[{from:0,to:source.length}]});
  const {list,sort}=new made[0].cls(view(0)).decorations;
  assert.equal(sort,true);
  const at=s=>source.indexOf(s);
  // ==ab=={标注}: one replacement from the opening == to the closing brace, drawing the target and its note.
  assert.deepEqual(Array.from(list.slice(0,1),d=>[d.kind,d.from,d.to]),[['replace',at('==ab'),at('{标注}')+4]]);
  const pinned=list[0].spec.widget;assert.equal(pinned.target,'ab');assert.equal(pinned.spec.dir,'se');
  // The widget is the target span (the classes that place the note) with the note inside it.
  const doc=fakeDocument(),drawn=pinned.toDOM({dom:{ownerDocument:doc}});
  assert.match(drawn.className,/aw-annot-target .*aw-annot-holds aw-annot-keep/);assert.equal(drawn.children[0].textContent,'ab','the target words come first');
  assert.equal(drawn.children.at(-1).className.split(' ')[0],'aw-annot','the note is inside the target');
  assert.ok(pinned.eq({target:'ab',spec:{...pinned.spec}}));assert.ok(!pinned.eq({target:'abc',spec:{...pinned.spec}}),'a changed target redraws');
  assert.deepEqual(Array.from(list.slice(1,4),d=>[d.kind,d.from]),[['mark',at('cd')],['widget',at('==cd')],['replace',at('{左边')]]);
  assert.equal(list[1].to,at('cd')+2,'a flow note does not widen the target mark');
  assert.equal(list[4].spec.attributes.style,'--aw-annot-color:#d0428a');
  const editing=new made[0].cls(view(at('ab')+1)).decorations.list;
  assert.equal(editing[0].kind,'mark');assert.equal(editing[0].spec.class,'aw-annot-source');assert.equal(editing[0].from,at('{标注}'));
  // Written inside inline code (or a code block, math, a comment): left as source, as in reading view.
  code=[at('==ab')-1,at('{标注}')+5];
  const kept=new made[0].cls(view(0)).decorations.list;
  assert.ok(kept.every(d=>d.from>=code[1]),'nothing drawn inside the code span');
  assert.equal(kept.length,list.length-1,'the annotations outside it are still drawn');
});
test('right-click: add an annotation to selected text, edit or remove the one under the cursor',()=>{
  const {Annotations}=loadModule('annotations.js',{obsidian:obsidianStub,'@codemirror/view':{},'@codemirror/language':{}});
  const a=new Annotations({app:{workspace:{on(){}}},data:{settings:{}}});
  let line='Keys can never be reused here.',sel={from:9,to:24},cursor={line:0,ch:0};
  const editor={getSelection:()=>line.slice(sel.from,sel.to),getLine:()=>line,
    getCursor:which=>sel.from===sel.to?cursor:{line:0,ch:which==='to'?sel.to:sel.from},
    replaceSelection(t){line=line.slice(0,sel.from)+t+line.slice(sel.to);},replaceRange(t,f,to){line=line.slice(0,f.ch)+t+line.slice(to.ch);}};
  const items=()=>{const out=[];a.menu({addItem(fn){const item={setTitle(t){this.title=t;return this;},setIcon(){return this;},onClick(f){this.run=f;return this;}};fn(item);out.push(item);}},editor);return out;};
  let opened=null;a.openModal=(spec,labels,submit)=>{opened={spec,labels};submit({...spec,note:'这是标注',dir:'sw'});};
  sel={from:9,to:25};// "never be reused " — the trailing space stays outside the highlight
  const add=items();assert.deepEqual(add.map(i=>i.title),['添加标注']);
  add[0].run();
  assert.equal(line,'Keys can ==never be reused=={这是标注|左下} here.');
  assert.equal(opened.labels.title,'添加标注');
  // A selection inside the annotation (macOS selects the word under a right-click) edits it
  // instead of nesting a second one: ====reused=={…}=={…}.
  sel={from:line.indexOf('reused'),to:line.indexOf('reused')+6};
  assert.deepEqual(items().map(i=>i.title),['编辑标注','删除标注']);
  sel={from:0,to:line.indexOf('==')};
  assert.deepEqual(items().map(i=>i.title),['添加标注'],'a selection that only touches it adds');
  sel={from:0,to:0};cursor={line:0,ch:line.indexOf('reused')};
  const menu=items();assert.deepEqual(menu.map(i=>i.title),['编辑标注','删除标注']);
  a.openModal=(spec,labels,submit)=>{opened={spec,labels};submit({...spec,note:'别再用',color:'red'});};
  menu[0].run();
  assert.equal(opened.spec.note,'这是标注');assert.equal(opened.spec.dir,'sw');
  assert.equal(line,'Keys can ==never be reused=={别再用|左下 红} here.');
  items()[1].run();
  assert.equal(line,'Keys can ==never be reused== here.','removing keeps the highlight, drops the note');
  cursor={line:0,ch:2};assert.deepEqual(items(),[],'nothing to offer away from an annotation');
});
test('scroll ruler maps scroll position to a fraction and back, and idles on short notes',()=>{
  const {progressOf,topFor}=loadModule('scroll-ruler.js',{obsidian:{Component:class{},MarkdownView:class{}}});
  assert.equal(progressOf(0,2000,800),0);assert.equal(progressOf(600,2000,800),.5);assert.equal(progressOf(1200,2000,800),1);
  assert.equal(progressOf(5000,2000,800),1);assert.equal(progressOf(0,802,800),null);
  assert.equal(topFor(.5,2000,800),600);assert.equal(topFor(-1,2000,800),0);assert.equal(topFor(2,2000,800),1200);assert.equal(topFor(.5,500,800),0);
});
test('ruler headings: the one being read is the last tick at or above the dot; clashing labels give way by level',()=>{
  const {currentHeading,layoutHeadings}=loadModule('scroll-ruler.js',{obsidian:{Component:class{},MarkdownView:class{}}});
  assert.equal(currentHeading([.1,.4,.8],0),-1,'above the first heading');
  assert.equal(currentHeading([0,.4,.8],0),0);assert.equal(currentHeading([.1,.4,.8],.4),1);assert.equal(currentHeading([.1,.4,.8],1),2);
  const items=[{index:0,level:2,top:0},{index:1,level:2,top:100},{index:2,level:1,top:108},{index:3,level:3,top:200},{index:4,level:2,top:210}];
  assert.deepEqual(Array.from(layoutHeadings(items,16)),[0,2,4],'h1 beats h2, h2 beats h3');
  assert.deepEqual(Array.from(layoutHeadings(items,16,3)),[0,2,3],'the heading being read always stays');
  assert.deepEqual(Array.from(layoutHeadings([{index:0,level:2,top:0},{index:1,level:2,top:10}],16)),[0],'equal levels: the earlier one');
  assert.deepEqual(Array.from(layoutHeadings([],16)),[]);
});
// A note view with a ruler: Live Preview (CodeMirror) or reading view, a text column and a ruler.
function rulerFixture({mode='source',headings,sections,settings={},column={right:700,pad:20}}={}){
  const listeners=[];
  const make=tag=>{
    const n={tag,children:[],parentNode:null,className:'',dataset:{},title:'',textContent:'',hidden:false,rect:null,
      style:{props:{},setProperty(k,v){this.props[k]=v;}},
      classList:{add(){},remove(){},toggle(c,on){n[c]=on;}},
      get isConnected(){return !!n.parentNode;},
      get firstChild(){return n.children[0];},
      appendChild(c){c.parentNode=n;n.children.push(c);return c;},
      setAttribute(){},
      remove(){if(n.parentNode)n.parentNode.children.splice(n.parentNode.children.indexOf(n),1);n.parentNode=null;},
      addEventListener(type,fn){listeners.push({node:n,type,fn});},
      getBoundingClientRect(){return n.rect||{top:0,left:0,right:0,height:0};},
      querySelector(sel){return n.query?.(sel)??null;}};
    n.ownerDocument=doc;return n;
  };
  const doc={createElement:make,defaultView:{getComputedStyle:el=>({paddingRight:String(el.pad||0)})}};
  // The note scrolls 2000px through a 500px window, scrolled to 1000 (two thirds of the way).
  const scroller=make('div');Object.assign(scroller,{scrollTop:1000,scrollHeight:2000,clientHeight:500,rect:{top:50}});
  const sizer=make('div');sizer.rect={right:column.right,top:50-1000+30};sizer.pad=column.pad;
  scroller.query=sel=>/sizer/.test(sel)?sizer:null;
  const host=make('div');host.query=()=>scroller;
  // CodeMirror: line n (1-based) starts at 10(n-1) and sits 20px per line below the document top.
  const cm={documentTop:50-1000,state:{doc:{lines:100,line:n=>({from:(n-1)*10})}},lineBlockAt:pos=>({top:pos*2})};
  const view={file:{path:'note.md'},contentEl:host,getMode:()=>mode,editor:{cm,lineCount:()=>100},
    previewMode:{renderer:{sections}}};
  const H=(heading,level,line)=>({heading,level,position:{start:{line}}});
  const list=headings??[H('Intro',1,0),H('Too deep',4,5),H('XOR',2,40),H('Close',2,41),H('',2,60),H('End',2,90)];
  class Component{addChild(c){return c;}removeChild(){}registerEvent(){}registerDomEvent(){}}
  const {ScrollRuler}=loadModule('scroll-ruler.js',{obsidian:{Component,MarkdownView:class{}}});
  const ruler=new ScrollRuler({app:{metadataCache:{getFileCache:()=>({headings:list})}},data:{settings:{scrollRuler:true,...settings}}});
  ruler.attach(view);
  const entry=ruler.entries.get(view);entry.el.rect={top:66,left:900,height:400};
  const marks=()=>entry.heads.children.map(m=>({text:m.firstChild.textContent,cls:m.className,top:m.style.top,line:m.dataset.line}));
  return {ruler,view,entry,scroller,sizer,marks,listeners};
}
test('ruler headings sit at their place in the note, the one being read darker; clicking one moves the dot onto it',()=>{
  const f=rulerFixture();f.ruler.update(f.view);
  // Headings at lines 0, 40, 41, 90 are 0, 800, 820, 1800px down a 2000px note. XOR and Close are
  // 8px apart on a 400px ruler, so only Close (the one being read, at 0.67) keeps its label.
  assert.deepEqual(f.marks(),[
    {text:'Intro',cls:'aw-ruler-head is-level-1',top:'0.00%',line:'0'},
    {text:'Close',cls:'aw-ruler-head is-level-2 is-current',top:'41.00%',line:'41'},
    {text:'End',cls:'aw-ruler-head is-level-2',top:'90.00%',line:'90'}]);
  assert.equal(f.entry.heads.style.props['--aw-heads-width'],'196px','the margin is 220px from text to ruler');
  assert.equal(f.entry.el['is-on-heading'],false);assert.equal(f.entry.el['is-compact'],false,'wide margin: the names sit in it');
  // Clicking End moves the dot onto its tick (0.9 of the 1500px scroll range).
  const down=f.listeners.find(l=>l.node===f.entry.heads.children[2]&&l.type==='pointerdown');
  let stopped=false;down.fn({button:0,preventDefault(){},stopPropagation(){stopped=true;}});
  assert.equal(f.scroller.scrollTop,1350);assert.ok(stopped,'the ruler does not also start a drag');
  // Scrolled on: labels are reused, End is the one being read, and the dot's number gives way on it.
  f.view.editor.cm.documentTop=50-1350;f.ruler.update(f.view);
  assert.deepEqual(f.marks().map(m=>m.cls.includes('is-current')?m.text:null).filter(Boolean),['End']);
  assert.equal(f.entry.heads.children.length,3);assert.equal(f.entry.el['is-on-heading'],true,'0.90 sits on End: its number gives way');
  // A narrow margin: the same headings, shown over the text while the pointer is on the ruler.
  f.sizer.rect.right=820;f.ruler.update(f.view);
  assert.equal(f.entry.el['is-compact'],true);assert.equal(f.marks().length,3);
  assert.equal(f.entry.heads.style.props['--aw-heads-width'],'220px');
});
test('ruler headings can be turned off, and follow the reading view or the line count when there is no editor',()=>{
  const off=rulerFixture({settings:{rulerHeadings:false}});off.ruler.update(off.view);
  assert.deepEqual(off.marks(),[]);assert.equal(off.entry.el['is-compact'],false);
  // Reading view: Obsidian's sections (heights; positions as start/end {line,col,offset}, as in
  // 1.15.1), from the top of the sizer (30px into the note). The page header (title, 20px) and
  // footer are sections too, both at line 0.
  const at=(a,b)=>({start:{line:a,col:0,offset:0},end:{line:b,col:0,offset:0}});
  const header={...at(0,0),height:20},footer={...at(0,0),height:300};
  const sections=[header,{...at(0,0),height:50},{...at(1,39),height:900},{...at(40,40),height:40},{...at(41,41),height:40},{...at(42,100),height:900},footer];
  const read=rulerFixture({mode:'preview',sections});
  read.view.previewMode.renderer.header=header;read.view.previewMode.renderer.footer=footer;
  const hs=read.ruler.headings(read.view);
  assert.deepEqual(hs.map(h=>h.text),['Intro','XOR','Close','End'],'levels 1–3 with a name');
  assert.deepEqual(Array.from(read.ruler.fractions(read.view,read.scroller,hs)),[50/2000,1000/2000,1040/2000,1080/2000]);
  // A section on screen corrects the estimate.
  sections[3].el={isConnected:true,offsetParent:{},getBoundingClientRect:()=>({top:50-1000+990})};
  assert.deepEqual(Array.from(read.ruler.fractions(read.view,read.scroller,hs)),[50/2000,990/2000,1030/2000,1070/2000]);
  // No sections and no CodeMirror: the share of lines above.
  const plain=rulerFixture({mode:'preview'});
  assert.deepEqual(Array.from(plain.ruler.fractions(plain.view,plain.scroller,hs)),[0,.4,.41,.9]);
});
test('the document look is screen-only and every token it sets has a dark twin',()=>{
  const glass=fs.readFileSync(path.join(root,'src/styles/glass.css'),'utf8');
  const outside=glass.replace(/@media screen[^{]*\{[\s\S]*?\n\}/g,'').replace(/@supports[^{]*\{\s*@media screen \{[\s\S]*?\n  \}\n\}/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(outside,/body:is\(\.theme-light,\.theme-dark\)[^{]*\{/,'no rule outside @media screen');
  assert.doesNotMatch(glass,/aw-style-/,'no style class: this is the only look');
  const block=sel=>{const m=new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\{([^}]*)\\}').exec(glass);assert.ok(m,sel);return m[1].match(/--aw-[\w-]+(?=:)/g).sort();};
  assert.deepEqual(block('body.theme-dark:not(.theme-light)'),block('body:is(.theme-light,.theme-dark)'));
  const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.doesNotMatch(snippet,/--ds-wallpaper-sky|backdrop-filter: blur\(40px\)/,'the glass style is opaque: no sky, no see-through note');
  assert.ok(snippet.indexOf('Source: src/styles/glass.css')<snippet.indexOf('Source: src/styles/print.css'),'print rules load last');
  assert.match(snippet,/\.callout\[data-callout="diagram"\]\[data-callout-metadata="rows"\]/);
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.doesNotMatch(plugin,/--aw-sky/);
  assert.match(plugin,/@media print \{\s*\.aw-ruler,\.aw-decor \{display: none !important;\}/);
  assert.match(plugin,/body:is\(\.theme-light,\.theme-dark\) \.aw-ruler \{\s*display: block;/,'the ruler shows without any style class');
});
test('annotation styles ship with the plugin: eight positions, flow notes, print kept, nothing left in the theme snippet',()=>{
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8'),snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  for(const d of ['se','s','sw','ne','n','nw'])assert.match(plugin,new RegExp(`\\.aw-annot-${d} \\.aw-annot-pin \\{`),d);
  assert.match(plugin,/\.aw-annot-room \{display: inline-block;width: 0;height: 0;vertical-align: var\(--aw-annot-room\);\}/,'pinned notes make room from the baseline instead of covering the next line');
  for(const [d,v] of [['se','-3.45em'],['s','-4.1em'],['ne','4.3em'],['n','4.9em']])assert.match(plugin,new RegExp(`\\.aw-annot-${d} \\{--aw-annot-room: ${v.replace('.','\\.')};\\}`),d);
  assert.match(plugin,/\.aw-annot-flow\.aw-annot-w \.aw-annot-arrow \{transform: scaleX\(-1\);\}/);
  for(const c of ['blue','neutral','amber','orange','green','red','purple','rainbow'])assert.match(plugin,new RegExp(`\\.aw-annot-c-${c} \\{--aw-annot-color:`),c);
  const print=plugin.slice(plugin.lastIndexOf('@media print'));
  assert.doesNotMatch(print,/aw-annot[^{]*\{[^}]*display: none/,'annotations print as they look');
  assert.doesNotMatch(snippet,/\.aw-annot/,'the theme snippet no longer styles annotations');
  assert.match(snippet,/--ds-tone-amber: 184,134,22;/);assert.match(snippet,/--ds-tone-amber: 212,162,64;/);
});

test('pinned notes stay with their target when lines wrap: short targets are kept whole, the room is glued to the last character',()=>{
  const F=require(path.join(__dirname,'../src/features/annotation-format.js'));
  const pin=F.parseAnnotation('{n|左下}'),flow=F.parseAnnotation('{n|右}');
  assert.equal(F.KEEP,24);
  assert.ok(F.targetClasses(pin,'x'.repeat(24)).includes('aw-annot-keep'));
  assert.ok(!F.targetClasses(pin,'x'.repeat(25)).includes('aw-annot-keep'));
  assert.ok(F.targetClasses(pin,'饱和区').includes('aw-annot-keep'),'counted in characters, not bytes');
  assert.ok(!F.targetClasses(pin).includes('aw-annot-keep'),'no target text, no promise');
  assert.ok(!F.targetClasses(flow,'x').includes('aw-annot-keep'));
  assert.equal(F.noteTree(pin).text,'\u2060');assert.equal(F.noteTree(flow).text,null);
  const css=fs.readFileSync(path.join(__dirname,'../dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/\.aw-annot-target\.aw-annot-keep \{white-space: nowrap;\}/);
});
test('diagram cards: Chinese breaks between words, and four cards go two by two rather than three and one',()=>{
  const blocks=fs.readFileSync(path.join(root,'src/styles/blocks.css'),'utf8');
  const card=/\.callout\[data-callout="diagram"\] > \.callout-content > ul > li \{([^}]*)\}/.exec(blocks)[1];
  assert.match(card,/word-break: keep-all;/,'no "记 / 录" split inside a word');
  assert.match(card,/overflow-wrap: anywhere;/,'a run too long for the card still wraps');
  assert.match(blocks,/\.callout\[data-callout="diagram"\] > \.callout-content \{container-type: inline-size;\}/);
  const q=/@container \(min-width: 280px\) and \(max-width: (\d+)px\) \{\s*([^{]+)\{flex-basis: 40%;\}/.exec(blocks);
  assert.ok(q,'two-by-two query');
  // Below this width four 130px cards with 18px gaps no longer fit in one row.
  assert.equal(Number(q[1]),4*130+3*18-1);
  assert.match(q[2],/:not\(\[data-callout-metadata="rows"\]\)/,'rows layout untouched');
  assert.match(q[2],/ul:has\(> li:nth-child\(4\):last-child\) > li/,'only exactly four cards');
});
test('the ruler schedules its frames in its own window, so a popout keeps updating',()=>{
  const f=rulerFixture(),calls=[];
  f.entry.win.requestAnimationFrame=fn=>{calls.push('frame');return 7;};
  f.entry.win.cancelAnimationFrame=id=>calls.push(id);
  f.ruler.schedule(f.view);f.ruler.schedule(f.view);
  assert.deepEqual(calls,['frame'],'one frame at a time, from the ruler\'s window');
  f.ruler.detach(f.view);assert.deepEqual(calls,['frame',7],'cancelled in the same window');
});
