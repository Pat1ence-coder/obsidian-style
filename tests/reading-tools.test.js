'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const A=require('../src/features/annotation-format');
const root=path.resolve(__dirname,'..');

test('annotation syntax: ==text=={note} right after the highlight, one line, up to 80 characters',()=>{
  assert.deepEqual(A.parseAnnotation('{标注下}，然后继续'),{note:'标注下',rest:'，然后继续'});
  assert.deepEqual(A.parseAnnotation('{ 空格会去掉 }'),{note:'空格会去掉',rest:''});
  for(const text of [' {有空格}','{}','{  }','{跨\n行}','{'+'长'.repeat(81)+'}','(括号)'])assert.equal(A.parseAnnotation(text),null,text);
  const src='前文 ==vertex shader=={标注下} 中间 ==只是高亮== 和 ==b=={二}';
  const found=A.findAnnotations(src,100);
  assert.deepEqual(found.map(a=>a.note),['标注下','二']);
  for(const a of found){assert.equal(src.slice(a.from-100,a.to-100),`{${a.note}}`);assert.equal(src.slice(a.markFrom-100,a.markFrom-98),'==');}
});

function loadModule(file,extra={}){
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/features',file),'utf8'),{module:mod,require:name=>{
    if(name in extra)return extra[name];
    if(name==='./annotation-format')return A;
    throw Error(name);
  },requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout});
  return mod.exports;
}
test('reading view: the note after a <mark> becomes a handwritten annotation, other text stays',()=>{
  const {Annotations}=loadModule('annotations.js',{obsidian:{Component:class{}},'@codemirror/view':{}});
  const created=[];
  const doc={createElement:tag=>{const n={tag,children:[],className:'',attrs:{},appendChild(c){this.children.push(c);},setAttribute(k,v){this.attrs[k]=v;}};created.push(n);return n;},createTextNode:text=>({nodeType:3,textContent:text})};
  const parent={inserted:[],insertBefore(node,ref){this.inserted.push([node,ref]);}};
  const after={nodeType:3,textContent:'{标注下}。后文'},plain={nodeType:3,textContent:' 没有批注'};
  const el={ownerDocument:doc,querySelectorAll:()=>[{nextSibling:after,parentNode:parent},{nextSibling:plain,parentNode:parent},{nextSibling:null,parentNode:parent}]};
  new Annotations({}).process(el);
  assert.equal(after.textContent,'。后文');assert.equal(plain.textContent,' 没有批注');
  assert.equal(parent.inserted.length,1);
  const [note,ref]=parent.inserted[0];
  assert.equal(ref,after);assert.equal(note.className,'aw-annot');assert.equal(note.children[0].textContent,'<---');assert.equal(note.children[1].textContent,'标注下');
});
test('scroll ruler maps scroll position to a fraction and back, and idles on short notes',()=>{
  const {progressOf,topFor}=loadModule('scroll-ruler.js',{obsidian:{Component:class{},MarkdownView:class{}}});
  assert.equal(progressOf(0,2000,800),0);assert.equal(progressOf(600,2000,800),.5);assert.equal(progressOf(1200,2000,800),1);
  assert.equal(progressOf(5000,2000,800),1);assert.equal(progressOf(0,802,800),null);
  assert.equal(topFor(.5,2000,800),600);assert.equal(topFor(-1,2000,800),0);assert.equal(topFor(2,2000,800),1200);assert.equal(topFor(.5,500,800),0);
});
test('glass style is screen-only and every glass token has a dark twin',()=>{
  const glass=fs.readFileSync(path.join(root,'src/styles/glass.css'),'utf8');
  const outside=glass.replace(/@media screen[^{]*\{[\s\S]*?\n\}/g,'').replace(/@supports[^{]*\{\s*@media screen \{[\s\S]*?\n  \}\n\}/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(outside,/aw-style-glass[^{]*\{/,'no glass rule outside @media screen');
  const block=sel=>{const m=new RegExp(sel.replace(/\./g,'\\.')+' \\{([^}]*)\\}').exec(glass);assert.ok(m,sel);return m[1].match(/--aw-[\w-]+(?=:)/g).sort();};
  assert.deepEqual(block('body.theme-dark.aw-style-glass'),block('body.aw-style-glass'));
  const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.match(snippet,/--ds-wallpaper-sky:url\("data:image\/png;base64,/);
  assert.ok(snippet.indexOf('Source: src/styles/glass.css')<snippet.indexOf('Source: src/styles/print.css'),'print rules load last');
  assert.match(snippet,/\.callout\[data-callout="diagram"\]\[data-callout-metadata="rows"\]/);
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(plugin,/\.workspace-leaf-content\[data-type="algorithm-workbench"\] \{--aw-sky:url\("data:image\/png;base64,/);
  assert.match(plugin,/@media print \{\s*\.aw-ruler,\.aw-decor \{display: none !important;\}/);
  assert.match(plugin,/^\.aw-ruler,\.aw-decor \{display: none;\}/m,'ruler and decoration only show in the glass style');
});
