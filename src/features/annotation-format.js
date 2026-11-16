'use strict';
// Handwritten annotations: ==target=={note} or ==target=={note|options}. The braces sit right
// after the closing == with no space, on one line. The note is up to 80 characters; options
// after the last "|" set where the note sits, its colour and its line:
//   position  右下 (default) 下 左下 右 左 右上 上 左上, or the arrows ↘ ↓ ↙ → ← ↗ ↑ ↖
//   colour    蓝 (default) 中性 琥珀 橙 绿 红 紫 彩虹, or #rgb / #rrggbb
//   line      双线 (default) 虚线
//   无高亮     the target keeps no tinted background
// Text after a "|" that isn't all options belongs to the note. Nothing here touches the DOM.
const MAX_NOTE=80;
const DIRECTIONS=[
  {id:'nw',arrow:'↖',label:'左上'},{id:'n',arrow:'↑',label:'上'},{id:'ne',arrow:'↗',label:'右上'},
  {id:'w',arrow:'←',label:'左'},{id:'e',arrow:'→',label:'右'},
  {id:'sw',arrow:'↙',label:'左下'},{id:'s',arrow:'↓',label:'下'},{id:'se',arrow:'↘',label:'右下'},
];
const COLORS=[
  {id:'neutral',label:'中性'},{id:'amber',label:'琥珀'},{id:'orange',label:'橙'},
  {id:'blue',label:'蓝'},{id:'green',label:'绿'},{id:'red',label:'红'},
  {id:'purple',label:'紫'},{id:'rainbow',label:'彩虹'},
];
const LINES=[{id:'double',label:'双线'},{id:'dashed',label:'虚线'}];
const DEFAULTS={dir:'se',color:'blue',custom:null,line:'double',highlight:true};
const HEX=/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NO_HIGHLIGHT=['无高亮','不高亮'];

// One option word, or null when the word isn't an option.
function option(word){
  const dir=DIRECTIONS.find(d=>d.arrow===word||d.label===word);
  if(dir)return {dir:dir.id};
  const color=COLORS.find(c=>c.label===word||c.label+'色'===word);
  if(color)return {color:color.id,custom:null};
  if(HEX.test(word))return {color:'custom',custom:word.toLowerCase()};
  const line=LINES.find(l=>l.label===word);
  if(line)return {line:line.id};
  if(NO_HIGHLIGHT.includes(word))return {highlight:false};
  return null;
}
// "note|options" (the text inside the braces) to a full annotation, or null.
function parseBody(body){
  let note=body,spec={...DEFAULTS};
  const bar=body.lastIndexOf('|');
  if(bar>=0){
    const words=body.slice(bar+1).trim().split(/\s+/).filter(Boolean);
    const options=words.map(option);
    if(words.length&&options.every(Boolean)){note=body.slice(0,bar);for(const o of options)Object.assign(spec,o);}
  }
  note=note.trim();
  if(!note||note.length>MAX_NOTE)return null;
  return {...spec,note};
}
// Braces, with up to 80 characters of note and room for a few options.
const BODY='[^{}\\n]{1,120}';
const NOTE=new RegExp(`^\\{(${BODY})\\}`);
const SOURCE=new RegExp(`==([^=\\n]+)==\\{(${BODY})\\}`,'g');

// Reading view: the text that follows a rendered <mark>.
function parseAnnotation(text) {
  const m=NOTE.exec(text||'');
  const spec=m&&parseBody(m[1]);
  return spec?{...spec,rest:text.slice(m[0].length)}:null;
}
// Live Preview: offsets of every annotation in a stretch of source text. markFrom is the opening
// ==, targetFrom..targetTo the highlighted words, from..to the braces.
function findAnnotations(text, offset=0) {
  const found=[];
  for(const m of text.matchAll(SOURCE)){
    const spec=parseBody(m[2]);
    if(!spec)continue;
    const markFrom=offset+m.index,targetFrom=markFrom+2,targetTo=targetFrom+m[1].length;
    found.push({...spec,markFrom,targetFrom,targetTo,from:targetTo+2,to:markFrom+m[0].length});
  }
  return found;
}
// The braces for an annotation; defaults are left out, so a plain note stays {note}.
function formatAnnotation(spec){
  const s={...DEFAULTS,...spec},note=String(s.note||'').replace(/[{}\r\n]+/g,' ').trim().slice(0,MAX_NOTE);
  if(!note)throw Error('请填写标注内容。');
  const words=[];
  if(s.dir!==DEFAULTS.dir)words.push(DIRECTIONS.find(d=>d.id===s.dir)?.label??DIRECTIONS.find(d=>d.id===DEFAULTS.dir).label);
  if(s.color==='custom'&&HEX.test(s.custom||''))words.push(s.custom.toLowerCase());
  else if(s.color!==DEFAULTS.color&&COLORS.some(c=>c.id===s.color))words.push(COLORS.find(c=>c.id===s.color).label);
  if(s.line!==DEFAULTS.line&&LINES.some(l=>l.id===s.line))words.push(LINES.find(l=>l.id===s.line).label);
  if(s.highlight===false)words.push(NO_HIGHLIGHT[0]);
  // A note that itself ends in "|option" would be misread; spell out the default position then.
  if(!words.length&&note.includes('|')&&parseBody(note)?.note!==note)words.push(DIRECTIONS.find(d=>d.id===DEFAULTS.dir).label);
  return `{${note}${words.length?'|'+words.join(' '):''}}`;
}
// Where the note goes relative to its target: pinned outside the line (the eight positions),
// or in the text flow after / before the target (右, 左).
function placement(spec){
  if(spec.dir==='e')return 'after';
  if(spec.dir==='w')return 'before';
  return 'pin';
}
// Classes for the highlighted target. A pinned note is laid out against the target's box.
function targetClasses(spec){
  return ['aw-annot-target','aw-annot-c-'+spec.color].concat(spec.highlight?[]:['aw-annot-plain'],placement(spec)==='pin'?['aw-annot-holds']:[]);
}
// The note as a plain tree ({tag, cls, attrs, text, children, svg}); the plugin turns it into
// DOM and the preview script into HTML, so both draw the same thing.
function noteTree(spec){
  const where=placement(spec);
  const leader={tag:'svg',svg:true,attrs:{class:'aw-annot-arrow',viewBox:'0 0 32 12','aria-hidden':'true'},children:[
    {tag:'path',svg:true,attrs:{d:'M8 2 L2 6 L8 10',class:'aw-annot-head'}},
    ...(spec.line==='double'?[4.6,7.4]:[6]).map(y=>({tag:'line',svg:true,attrs:{x1:'4',y1:String(y),x2:'32',y2:String(y),class:'aw-annot-line'}})),
  ]};
  const text={tag:'span',cls:'aw-annot-text',text:spec.note};
  let children;
  if(where==='pin')children=[{tag:'span',cls:'aw-annot-room',attrs:{'aria-hidden':'true'}},{tag:'span',cls:'aw-annot-pin',children:[leader,text]}];
  else children=where==='before'?[text,leader]:[leader,text];
  return {tag:'span',cls:['aw-annot','aw-annot-'+spec.dir,'aw-annot-'+spec.line,'aw-annot-c-'+spec.color,where==='pin'?'aw-annot-pinned':'aw-annot-flow'].join(' '),
    attrs:{title:'标注：'+spec.note},color:spec.color==='custom'?spec.custom:null,children};
}
module.exports={parseAnnotation,findAnnotations,formatAnnotation,parseBody,placement,targetClasses,noteTree,DIRECTIONS,COLORS,LINES,DEFAULTS,MAX_NOTE};
