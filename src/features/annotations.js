'use strict';
const {Component,editorLivePreviewField}=require('obsidian');
const {ViewPlugin,Decoration,WidgetType}=require('@codemirror/view');
const {parseAnnotation,findAnnotations}=require('./annotation-format');

// "<--- note" in a handwriting face, placed after the highlighted text.
function noteNode(doc,note){
  const span=doc.createElement('span');span.className='aw-annot';span.title='批注：'+note;
  const arrow=doc.createElement('span');arrow.className='aw-annot-arrow';arrow.textContent='<---';arrow.setAttribute('aria-hidden','true');
  span.appendChild(arrow);span.appendChild(doc.createTextNode(note));
  return span;
}
const livePreview=state=>!editorLivePreviewField||state.field(editorLivePreviewField,false)===true;

// Live Preview: {note} becomes the handwritten widget unless the cursor is on the annotation,
// in which case the source stays editable (as Obsidian does for its own formatting).
function editorExtension(){
  class NoteWidget extends WidgetType{
    constructor(note){super();this.note=note;}
    eq(other){return other.note===this.note;}
    toDOM(view){return noteNode(view.dom.ownerDocument,this.note);}
  }
  const build=view=>{
    if(!livePreview(view.state))return Decoration.none;
    const doc=view.state.doc,ranges=view.state.selection.ranges,seen=new Map();
    for(const {from,to} of view.visibleRanges){
      // Whole lines, so a match is never cut at the viewport edge.
      const start=doc.lineAt(from).from,end=doc.lineAt(to).to;
      for(const a of findAnnotations(view.state.sliceDoc(start,end),start))seen.set(a.from,a);
    }
    const decorations=[...seen.values()].sort((a,b)=>a.from-b.from).map(a=>{
      const editing=ranges.some(r=>r.from<=a.to&&r.to>=a.markFrom);
      return (editing?Decoration.mark({class:'aw-annot-source'}):Decoration.replace({widget:new NoteWidget(a.note)})).range(a.from,a.to);
    });
    return Decoration.set(decorations);
  };
  return ViewPlugin.fromClass(class{
    constructor(view){this.decorations=build(view);}
    update(update){
      if(update.docChanged||update.viewportChanged||update.selectionSet||livePreview(update.startState)!==livePreview(update.state))
        this.decorations=build(update.view);
    }
  },{decorations:plugin=>plugin.decorations});
}

class Annotations extends Component{
  constructor(plugin){super();this.plugin=plugin;}
  onload(){
    this.plugin.registerMarkdownPostProcessor(el=>this.process(el));
    this.plugin.registerEditorExtension(editorExtension());
  }
  // Reading view: Obsidian renders ==text== as <mark>; the {note} is the text right after it.
  process(el){
    for(const mark of el.querySelectorAll('mark')){
      const next=mark.nextSibling;
      if(!next||next.nodeType!==3)continue;
      const found=parseAnnotation(next.textContent);
      if(!found)continue;
      next.textContent=found.rest;
      mark.parentNode.insertBefore(noteNode(el.ownerDocument,found.note),next);
    }
  }
}
module.exports={Annotations,noteNode};
