'use strict';
const {Component}=require('obsidian');
const {EditorView,ViewPlugin}=require('@codemirror/view');

const IDLE_MS=480;
const MAX_GLIDE_DY=260;
const MAX_GLIDE_DIST=1000;

function shouldActivate({enabled,reducedMotion,hasFocus,editable,rangeCount,empty,vim,blocked}){
  return Boolean(enabled&&!reducedMotion&&hasFocus&&editable&&rangeCount===1&&empty&&!vim&&!blocked);
}

function shouldGlide({hadPos,animate,prevX,prevY,x,y}){
  if(!hadPos||!animate)return false;
  const dx=x-prevX,dy=y-prevY;
  if(Math.abs(dx)<0.5&&Math.abs(dy)<0.5)return false;
  return Math.abs(dy)<=MAX_GLIDE_DY&&Math.hypot(dx,dy)<=MAX_GLIDE_DIST;
}

function caretRect(coords,scrollerRect,scrollLeft,scrollTop,clientLeft=0,clientTop=0){
  if(!coords||!scrollerRect||!(coords.bottom>coords.top))return null;
  const rawX=coords.left-scrollerRect.left+scrollLeft-clientLeft;
  const x=Math.max(0,rawX-0.5);
  const y=coords.top-scrollerRect.top+scrollTop-clientTop;
  const height=Math.max(12,Math.min(96,Math.round(coords.bottom-coords.top)));
  return {x,y,height};
}

function measureCaretCoords(view){
  const sel=view.state?.selection;
  if(!sel||sel.ranges.length!==1||!sel.main.empty)return null;
  const doc=view.dom?.ownerDocument;
  // During IME composition, the live collapsed DOM selection tracks the end of the preedit text
  // without touching selection state, keeping macOS candidate popups anchored natively.
  if(view.composing){
    const domSel=doc?.getSelection?.();
    if(domSel&&domSel.rangeCount>0&&domSel.isCollapsed&&view.contentDOM?.contains?.(domSel.focusNode)){
      const range=domSel.getRangeAt(0);
      const rect=range.getBoundingClientRect?.();
      if(rect&&rect.height>0)return {left:rect.left,top:rect.top,bottom:rect.bottom};
      const rects=range.getClientRects?.();
      if(rects?.length&&rects[0].height>0)return {left:rects[0].left,top:rects[0].top,bottom:rects[0].bottom};
    }
  }
  const c=view.coordsAtPos?.(sel.main.head,sel.main.assoc||1);
  return c&&c.bottom>c.top?c:null;
}

function isVimActive(view,app){
  if(app?.vault?.getConfig?.('vimMode')===true)return true;
  if(view.dom?.classList?.contains?.('cm-fat-cursor'))return true;
  if(view.dom?.closest?.('.cm-vim-mode'))return true;
  if(view.dom?.ownerDocument?.body?.classList?.contains?.('is-vim-mode'))return true;
  return false;
}

function isBlockedEditor(view){
  return Boolean(view.dom?.closest?.('.cm-table-widget,.formula-editor,.mod-image-selected'));
}

function isEditable(view){
  if(view.contentDOM?.getAttribute?.('contenteditable')==='false')return false;
  if(EditorView?.editable&&typeof view.state?.facet==='function'){
    try{if(view.state.facet(EditorView.editable)===false)return false;}catch{}
  }
  return true;
}

class TypingMotion extends Component{
  constructor(plugin){
    super();
    this.plugin=plugin;
    this.app=plugin.app;
    this.instances=new Set();
  }
  onload(){
    this.plugin.registerEditorExtension(this.editorExtension());
    if(typeof this.app?.vault?.on==='function'){
      this.registerEvent(this.app.vault.on('config-changed',key=>{if(key==='vimMode')this.refresh();}));
    }
  }
  onunload(){
    for(const inst of [...this.instances])inst.hide();
    this.instances.clear();
  }
  enabled(){return this.plugin.data?.settings?.smoothCaret!==false;}
  classes(){return this.enabled()?['aw-smooth-caret']:[];}
  refresh(){
    for(const inst of this.instances)inst.schedule(false);
  }
  editorExtension(){
    const host=this;
    return ViewPlugin.fromClass(class{
      constructor(view){
        this.view=view;
        this.doc=view.dom?.ownerDocument;
        this.win=this.doc?.defaultView||globalThis;
        this.measureKey={};
        this.caret=null;
        this.hasPos=false;
        this.prevX=0;
        this.prevY=0;
        this.prevH=0;
        this.idleTimer=null;
        this.rafId=null;
        this.pendingAnimate=false;
        this.destroyed=false;
        this.mql=this.win.matchMedia?.('(prefers-reduced-motion: reduce)')||null;
        this.onReduced=()=>this.schedule(false);
        this.onCompose=()=>this.schedule(true);
        this.onFocus=()=>this.schedule(false);
        this.onBlur=()=>this.hide();
        this.mql?.addEventListener?.('change',this.onReduced);
        const content=view.contentDOM;
        if(typeof content?.addEventListener==='function'){
          content.addEventListener('compositionstart',this.onCompose);
          content.addEventListener('compositionupdate',this.onCompose);
          content.addEventListener('compositionend',this.onCompose);
          content.addEventListener('focus',this.onFocus);
          content.addEventListener('blur',this.onBlur);
        }
        host.instances.add(this);
        this.schedule(false);
      }
      ensureCaret(){
        if(this.caret)return this.caret;
        const scroller=this.view.scrollDOM;
        if(!scroller||typeof this.doc?.createElement!=='function')return null;
        const el=this.doc.createElement('div');
        el.className='aw-caret';
        el.setAttribute?.('aria-hidden','true');
        scroller.appendChild(el);
        this.caret=el;
        return el;
      }
      clearIdle(){
        if(this.idleTimer!=null){this.win.clearTimeout?.(this.idleTimer);this.idleTimer=null;}
      }
      resetIdle(){
        this.clearIdle();
        this.caret?.classList?.remove?.('is-idle');
        if(typeof this.win.setTimeout==='function'){
          this.idleTimer=this.win.setTimeout(()=>{
            this.idleTimer=null;
            if(!this.destroyed&&this.hasPos)this.caret?.classList?.add?.('is-idle');
          },IDLE_MS);
        }
      }
      hide(){
        this.clearIdle();
        this.hasPos=false;
        this.view.dom?.classList?.remove?.('aw-caret-active');
        if(this.caret){
          this.caret.classList?.remove?.('is-visible','is-gliding','is-idle');
        }
      }
      canActivate(){
        const sel=this.view.state?.selection;
        return shouldActivate({
          enabled:host.enabled(),
          reducedMotion:Boolean(this.mql?.matches),
          hasFocus:Boolean(this.view.hasFocus),
          editable:isEditable(this.view),
          rangeCount:sel?.ranges?.length??0,
          empty:Boolean(sel?.main?.empty),
          vim:isVimActive(this.view,host.app),
          blocked:isBlockedEditor(this.view),
        });
      }
      update(update){
        if(update.focusChanged&&!update.view.hasFocus){this.hide();return;}
        if(update.docChanged||update.selectionSet){this.schedule(true);return;}
        if(update.geometryChanged||update.focusChanged){this.schedule(false);}
      }
      schedule(animate){
        if(this.destroyed)return;
        if(!this.canActivate()){this.hide();return;}
        this.pendingAnimate=this.pendingAnimate||animate;
        const read=view=>{
          if(this.destroyed||!this.canActivate())return null;
          const scroller=view.scrollDOM;
          if(!scroller||typeof scroller.getBoundingClientRect!=='function')return null;
          const coords=measureCaretCoords(view);
          if(!coords)return null;
          return caretRect(coords,scroller.getBoundingClientRect(),scroller.scrollLeft||0,scroller.scrollTop||0,scroller.clientLeft||0,scroller.clientTop||0);
        };
        const write=rect=>{
          const wantAnimate=this.pendingAnimate;
          this.pendingAnimate=false;
          if(this.destroyed||!rect){this.hide();return;}
          const el=this.ensureCaret();
          if(!el)return;
          const moved=!this.hasPos||Math.abs(rect.x-this.prevX)>=0.5||Math.abs(rect.y-this.prevY)>=0.5||rect.height!==this.prevH;
          this.view.dom?.classList?.add?.('aw-caret-active');
          el.classList?.add?.('is-visible');
          // Do not toggle is-gliding off when target coordinates are unchanged, or an in-flight
          // glide would be cut short by a follow-up geometryChanged notification.
          if(!moved)return;
          const glide=shouldGlide({hadPos:this.hasPos,animate:wantAnimate,prevX:this.prevX,prevY:this.prevY,x:rect.x,y:rect.y});
          el.classList?.toggle?.('is-gliding',glide);
          el.style.transform=`translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`;
          el.style.height=`${rect.height}px`;
          this.prevX=rect.x;
          this.prevY=rect.y;
          this.prevH=rect.height;
          this.hasPos=true;
          this.resetIdle();
        };
        if(typeof this.view.requestMeasure==='function'){
          this.view.requestMeasure({key:this.measureKey,read,write});
          return;
        }
        if(this.rafId!=null)return;
        const raf=this.win.requestAnimationFrame;
        if(typeof raf==='function'){
          this.rafId=raf(()=>{this.rafId=null;write(read(this.view));});
        }else write(read(this.view));
      }
      destroy(){
        this.destroyed=true;
        if(this.rafId!=null){this.win.cancelAnimationFrame?.(this.rafId);this.rafId=null;}
        this.hide();
        this.mql?.removeEventListener?.('change',this.onReduced);
        const content=this.view.contentDOM;
        if(typeof content?.removeEventListener==='function'){
          content.removeEventListener('compositionstart',this.onCompose);
          content.removeEventListener('compositionupdate',this.onCompose);
          content.removeEventListener('compositionend',this.onCompose);
          content.removeEventListener('focus',this.onFocus);
          content.removeEventListener('blur',this.onBlur);
        }
        this.caret?.remove?.();
        this.caret=null;
        host.instances.delete(this);
      }
    });
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings;
    new Setting(container).setName('平滑光标')
      .addToggle(t=>t.setValue(s.smoothCaret!==false).onChange(v=>{
        s.smoothCaret=v;
        this.plugin.applyAppearanceEverywhere();
        this.refresh();
        this.plugin.changed();
      }));
  }
}

module.exports={TypingMotion,shouldActivate,shouldGlide,caretRect,measureCaretCoords,IDLE_MS,MAX_GLIDE_DY,MAX_GLIDE_DIST};
