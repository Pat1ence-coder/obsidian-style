'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

function loadTypingMotion(extra={}){
  const mod={exports:{}};
  const made=[];
  const EditorView={editable:'editable-facet'};
  const ViewPlugin={fromClass:(cls,spec)=>{made.push({cls,spec});return {cls,spec};}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/features/typing-motion.js'),'utf8'),{
    module:mod,
    require:name=>{
      if(name in extra)return extra[name];
      if(name==='obsidian')return {Component:class{registerEvent(){}}};
      if(name==='@codemirror/view')return {EditorView,ViewPlugin};
      throw Error(name);
    },
    globalThis,
  });
  return {...mod.exports,made,EditorView};
}

function makeEl(tag,doc){
  const classes=new Set(),listeners=new Map();
  const el={
    tag,ownerDocument:doc,children:[],parentNode:null,attrs:{},style:{},classes,listeners,
    get className(){return [...classes].join(' ');},
    set className(v){classes.clear();for(const c of String(v||'').split(/\s+/).filter(Boolean))classes.add(c);},
    classList:{
      add:(...ns)=>ns.forEach(n=>classes.add(n)),
      remove:(...ns)=>ns.forEach(n=>classes.delete(n)),
      toggle:(n,on)=>{const next=on===undefined?!classes.has(n):Boolean(on);if(next)classes.add(n);else classes.delete(n);return next;},
      contains:n=>classes.has(n),
    },
    setAttribute(k,v){el.attrs[k]=String(v);},
    getAttribute(k){return el.attrs[k]??null;},
    appendChild(c){c.parentNode=el;el.children.push(c);return c;},
    remove(){if(el.parentNode){const i=el.parentNode.children.indexOf(el);if(i>=0)el.parentNode.children.splice(i,1);el.parentNode=null;}},
    addEventListener(type,fn){(listeners.get(type)||listeners.set(type,[]).get(type)).push(fn);},
    removeEventListener(type,fn){const list=listeners.get(type);if(!list)return;const i=list.indexOf(fn);if(i>=0)list.splice(i,1);},
    emit(type,ev={}){for(const fn of [...(listeners.get(type)||[])])fn(ev);},
    closest:()=>null,
    contains:node=>node===el||el.children.includes(node),
  };
  return el;
}

test('typing motion guards: activation, glide distance and coordinate math',()=>{
  const T=loadTypingMotion();
  const base={enabled:true,reducedMotion:false,hasFocus:true,editable:true,rangeCount:1,empty:true,vim:false,blocked:false};
  assert.equal(T.shouldActivate(base),true);
  for(const [k,v] of [['enabled',false],['reducedMotion',true],['hasFocus',false],['editable',false],['rangeCount',2],['empty',false],['vim',true],['blocked',true]]){
    assert.equal(T.shouldActivate({...base,[k]:v}),false,`${k}=${v} must disable smooth caret`);
  }
  assert.equal(T.shouldGlide({hadPos:false,animate:true,prevX:0,prevY:0,x:100,y:40}),false,'first placement snaps');
  assert.equal(T.shouldGlide({hadPos:true,animate:false,prevX:100,prevY:40,x:120,y:40}),false,'layout reflow snaps');
  assert.equal(T.shouldGlide({hadPos:true,animate:true,prevX:100,prevY:40,x:112,y:40}),true,'normal typing glides');
  assert.equal(T.shouldGlide({hadPos:true,animate:true,prevX:800,prevY:40,x:24,y:68}),true,'Enter across 820px line glides diagonally');
  assert.equal(T.shouldGlide({hadPos:true,animate:true,prevX:24,prevY:40,x:24,y:420}),false,'multi-page vertical jump snaps');
  assert.deepEqual({...T.caretRect({left:120,top:90,bottom:114},{left:20,top:50},10,300,0,0)},{x:109.5,y:340,height:24});
  assert.deepEqual({...T.caretRect({left:20,top:50,bottom:56},{left:20,top:50},0,0)},{x:0,y:0,height:12},'x clamps to >=0 and height to >=12');
  assert.equal(T.caretRect({left:20,top:50,bottom:50},{left:20,top:50},0,0),null);
});

test('typing motion tracks native IME composition selection without modifying DOM selection',()=>{
  const T=loadTypingMotion();
  const node={id:'preedit'};
  const domSel={rangeCount:1,isCollapsed:true,focusNode:node,getRangeAt:()=>({getBoundingClientRect:()=>({left:240,top:80,bottom:104,height:24})})};
  const view={
    composing:true,
    dom:{ownerDocument:{getSelection:()=>domSel}},
    contentDOM:{contains:n=>n===node},
    state:{selection:{ranges:[{empty:true,head:5,assoc:1}],main:{empty:true,head:5,assoc:1}}},
    coordsAtPos:()=>({left:180,top:80,bottom:104}),
  };
  assert.deepEqual({...T.measureCaretCoords(view)},{left:240,top:80,bottom:104},'uses live preedit caret while composing');
  view.composing=false;
  assert.deepEqual({...T.measureCaretCoords(view)},{left:180,top:80,bottom:104},'uses CM6 coordsAtPos when not composing');
  // Falls back to coordsAtPos if collapsed DOM range reports zero height during composition.
  view.composing=true;
  domSel.getRangeAt=()=>({getBoundingClientRect:()=>({left:0,top:0,bottom:0,height:0}),getClientRects:()=>[]});
  assert.deepEqual({...T.measureCaretCoords(view)},{left:180,top:80,bottom:104});
});

test('TypingMotion ViewPlugin snaps on focus, glides on typing/Enter, breathes when idle, and yields on selection, Vim, reduced-motion or disable',()=>{
  const T=loadTypingMotion();
  const timers=new Map();let nextTimer=1;
  const mqlListeners=[];
  const mql={matches:false,addEventListener(_t,fn){mqlListeners.push(fn);},removeEventListener(_t,fn){const i=mqlListeners.indexOf(fn);if(i>=0)mqlListeners.splice(i,1);}};
  const win={
    matchMedia:()=>mql,
    setTimeout:(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,ms});return id;},
    clearTimeout:id=>timers.delete(id),
  };
  const doc={defaultView:win,body:null,createElement:tag=>makeEl(tag,doc)};
  doc.body=makeEl('body',doc);
  const editorDom=makeEl('div',doc);editorDom.className='cm-editor';
  const scroller=makeEl('div',doc);scroller.className='cm-scroller';
  scroller.scrollLeft=0;scroller.scrollTop=120;scroller.clientLeft=0;scroller.clientTop=0;
  scroller.getBoundingClientRect=()=>({left:20,top:40});
  const contentDOM=makeEl('div',doc);contentDOM.className='cm-content';
  editorDom.appendChild(scroller);scroller.appendChild(contentDOM);

  let coords={left:100,top:80,bottom:104};
  let selection={ranges:[{empty:true,head:0,assoc:1}],main:{empty:true,head:0,assoc:1}};
  let hasFocus=true,editable=true,vimConfig=false;
  const configHandlers=[];
  const view={
    dom:editorDom,scrollDOM:scroller,contentDOM,
    get hasFocus(){return hasFocus;},
    composing:false,
    state:{get selection(){return selection;},facet:f=>f===T.EditorView.editable?editable:undefined},
    coordsAtPos:()=>coords,
    requestMeasure({read,write}){write(read(view),view);},
  };
  const plugin={
    data:{settings:{smoothCaret:true}},
    app:{vault:{getConfig:k=>k==='vimMode'?vimConfig:undefined,on:(e,fn)=>{if(e==='config-changed')configHandlers.push(fn);}}},
    registerEditorExtension(){},
    applyAppearanceEverywhere(){},
    changed(){},
  };
  const tm=new T.TypingMotion(plugin);
  tm.onload();
  const inst=new T.made[0].cls(view);
  const caret=scroller.children.find(c=>c.classList.contains('aw-caret'));
  assert.ok(caret,'caret mounted inside .cm-scroller');
  assert.equal(editorDom.classList.contains('aw-caret-active'),true);
  assert.equal(caret.classList.contains('is-visible'),true);
  assert.equal(caret.classList.contains('is-gliding'),false,'initial focus snaps without flying in');
  assert.equal(caret.style.transform,'translate(79.5px, 160.0px)');
  assert.equal(caret.style.height,'24px');

  // Typing advances smoothly with is-gliding enabled.
  coords={left:118,top:80,bottom:104};
  inst.update({view,docChanged:true,selectionSet:true});
  assert.equal(caret.classList.contains('is-gliding'),true);
  assert.equal(caret.style.transform,'translate(97.5px, 160.0px)');
  assert.equal(caret.classList.contains('is-idle'),false);

  // A follow-up geometryChanged with identical coordinates keeps the in-flight glide intact.
  inst.update({view,geometryChanged:true});
  assert.equal(caret.classList.contains('is-gliding'),true,'no-op geometryChanged does not abort active glide');

  // Pressing Enter moves diagonally to line 2 with smooth glide.
  coords={left:24,top:108,bottom:132};
  inst.update({view,docChanged:true,selectionSet:true});
  assert.equal(caret.classList.contains('is-gliding'),true);
  assert.equal(caret.style.transform,'translate(3.5px, 188.0px)');

  // Idle timer transitions caret into soft breathing fade.
  assert.equal(timers.size,1);
  const [{fn:fireIdle,ms}]=[...timers.values()];
  assert.equal(ms,T.IDLE_MS);
  timers.clear();fireIdle();
  assert.equal(caret.classList.contains('is-idle'),true);

  // Range selection hides smooth caret and restores native caret immediately.
  selection={ranges:[{empty:false,head:4,assoc:1}],main:{empty:false,head:4,assoc:1}};
  inst.update({view,selectionSet:true});
  assert.equal(editorDom.classList.contains('aw-caret-active'),false);
  assert.equal(caret.classList.contains('is-visible'),false);

  // Returning to collapsed cursor snaps cleanly without sliding from stale spot.
  selection={ranges:[{empty:true,head:4,assoc:1}],main:{empty:true,head:4,assoc:1}};
  coords={left:200,top:108,bottom:132};
  inst.update({view,selectionSet:true});
  assert.equal(caret.classList.contains('is-visible'),true);
  assert.equal(caret.classList.contains('is-gliding'),false,'re-entering after range selection snaps');

  // Vim mode disables smooth caret dynamically via config-changed.
  vimConfig=true;
  for(const fn of configHandlers)fn('vimMode');
  assert.equal(caret.classList.contains('is-visible'),false);
  assert.equal(editorDom.classList.contains('aw-caret-active'),false);
  vimConfig=false;
  for(const fn of configHandlers)fn('vimMode');
  assert.equal(caret.classList.contains('is-visible'),true);

  // prefers-reduced-motion: reduce immediately yields to native caret.
  mql.matches=true;mqlListeners.forEach(fn=>fn());
  assert.equal(caret.classList.contains('is-visible'),false);
  mql.matches=false;mqlListeners.forEach(fn=>fn());
  assert.equal(caret.classList.contains('is-visible'),true);

  // Toggling setting off hides caret across live editors; destroy cleans DOM and listeners.
  plugin.data.settings.smoothCaret=false;tm.refresh();
  assert.equal(caret.classList.contains('is-visible'),false);
  plugin.data.settings.smoothCaret=true;tm.refresh();
  assert.equal(caret.classList.contains('is-visible'),true);

  // Blur hides caret immediately.
  hasFocus=false;contentDOM.emit('blur');
  assert.equal(caret.classList.contains('is-visible'),false);

  inst.destroy();
  assert.equal(scroller.children.includes(caret),false,'caret removed on destroy');
  assert.equal(contentDOM.listeners.get('compositionupdate').length,0,'IME listeners removed');
  assert.equal(tm.instances.size,0);
});

test('typing motion CSS uses pure 2D transform with zero will-change, blur, or print leak',()=>{
  const css=fs.readFileSync(path.join(root,'src/styles/typing-motion.css'),'utf8');
  const code=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const built=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(built,/Source: src\/styles\/typing-motion\.css/);
  assert.doesNotMatch(code,/will-change|translate3d|translateZ|backdrop-filter/,'translucent macOS anti-ghosting contract');
  assert.match(css,/\.aw-caret\.is-gliding \{transition: transform 90ms/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css,/@media print \{\s*\.aw-caret \{display: none !important;\}/);
});
