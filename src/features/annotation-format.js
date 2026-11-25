'use strict';
// Handwritten annotations: ==target=={note} or ==target=={note|options}. The braces sit right
// after the closing == with no space, on one line. The note is up to 80 characters; options
// after the last "|" set where the note sits, its colour and its line:
//   position  右下 (default) 下 左下 右上 上 左上, or the arrows ↘ ↓ ↙ ↗ ↑ ↖
//   colour    蓝 (default) 中性 琥珀 橙 绿 红 紫 彩虹, or #rgb / #rrggbb
//   line      双线 (default) 虚线 实线 波浪 螺旋
//   无高亮     the target keeps no tinted background
// Text after a "|" that isn't all options belongs to the note. Nothing here touches the DOM.
const MAX_NOTE=80;
const DIRECTIONS=[
  {id:'nw',arrow:'↖',label:'左上'},{id:'n',arrow:'↑',label:'上'},{id:'ne',arrow:'↗',label:'右上'},
  {id:'sw',arrow:'↙',label:'左下'},{id:'s',arrow:'↓',label:'下'},{id:'se',arrow:'↘',label:'右下'},
];
const COLORS=[
  {id:'neutral',label:'中性'},{id:'amber',label:'琥珀'},{id:'orange',label:'橙'},
  {id:'blue',label:'蓝'},{id:'green',label:'绿'},{id:'red',label:'红'},
  {id:'purple',label:'紫'},{id:'rainbow',label:'彩虹'},
];
const LINES=[
  {id:'double',label:'双线'},{id:'dashed',label:'虚线'},{id:'solid',label:'实线'},
  {id:'wavy',label:'波浪'},{id:'spiral',label:'螺旋'},
];
const DEFAULTS={dir:'se',color:'blue',custom:null,line:'double',highlight:true};
const SPEC_KEYS=['note','dir','color','custom','line','highlight'];
const sameSpec=(a,b)=>Boolean(a&&b)&&SPEC_KEYS.every(k=>a[k]===b[k]);
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
// Classes for the highlighted target. Every annotation is pinned off its target's box, so a
// short target is kept on one line (it wraps to the next line as a whole): split over two lines,
// its box would span both and the note would drift. Targets longer than KEEP characters wrap
// normally, so they never overflow.
const KEEP=24;
function targetClasses(spec,target){
  const keep=target!=null&&[...String(target)].length<=KEEP;
  return ['aw-annot-target','aw-annot-c-'+spec.color].concat(spec.highlight?[]:['aw-annot-plain'],['aw-annot-holds'],keep?['aw-annot-keep']:[]);
}
// Visual width in the note's own em; pinned notes wrap at 13.5em and reserve room per line.
function noteLines(note){
  let em=0;
  for(const ch of String(note||''))em+=ch.codePointAt(0)>0x2e7f?1:0.56;
  return Math.min(6,Math.max(1,Math.ceil(em/13)));
}
const LEADER_PATHS={
  double:['M3.8 4.7 Q17.5 6.7 31.5 4.5','M4.2 7.3 Q17.8 9.3 31.5 7.2'],
  dashed:['M3.4 5.9 Q17.5 8.1 31.5 5.8'],
  solid:['M3.4 5.9 Q17.5 8.1 31.5 5.8'],
  wavy:['M3.6 6 C7.2 2.9,10.6 9.1,14.2 6 C17.8 2.9,21.2 9.1,24.8 6 C27.4 3.8,29.6 7.5,31.5 6'],
  spiral:['M3.5 6 C9.5 6.8,16.5 8.8,19.2 6.8 C21.4 5.1,20.4 1.6,17.2 1.6 C14 1.6,13.2 5.4,15.8 7.5 C19.2 10.1,26.2 7.4,31.5 5.9'],
};
// The note as a plain tree ({tag, cls, attrs, text, children, svg}); the plugin turns it into
// DOM and the preview script into HTML, so both draw the same thing.
function noteTree(spec){
  const lines=noteLines(spec.note);
  const strokes=LEADER_PATHS[spec.line]||LEADER_PATHS.double;
  const leader={tag:'svg',svg:true,attrs:{class:'aw-annot-arrow',viewBox:'0 0 32 12','aria-hidden':'true'},children:[
    {tag:'path',svg:true,attrs:{d:'M8.6 2.3 Q5.3 4.2 2.3 5.8 Q5.2 7.7 8.2 10',class:'aw-annot-head'}},
    ...strokes.map(d=>({tag:'path',svg:true,attrs:{d,class:'aw-annot-line'}})),
  ]};
  const text={tag:'span',cls:'aw-annot-text',text:spec.note};
  const children=[{tag:'span',cls:'aw-annot-room',attrs:{'aria-hidden':'true'}},{tag:'span',cls:'aw-annot-pin',children:[leader,text]}];
  const cls=['aw-annot','aw-annot-'+spec.dir,'aw-annot-'+spec.line,'aw-annot-c-'+spec.color,'aw-annot-pinned'];
  if(lines>1)cls.push('aw-annot-l'+lines);
  // A pinned note starts with a word joiner (U+2060): no line break between the target's last
  // character and the note's room block, so the room stays on the target's line.
  return {tag:'span',text:'\u2060',cls:cls.join(' '),
    attrs:{title:'标注：'+spec.note},color:spec.color==='custom'?spec.custom:null,children};
}
// Replace inline code, inline math and comments with equal-length spaces so character offsets stay exact.
function maskVerbatimInLine(line){
  return line.replace(/(`+)[^`]*?\1|\$\$[^$]+?\$\$|\$(?!\s)[^$\n]+?(?<!\s)\$|%%.*?%%|<!--.*?-->/g,m=>' '.repeat(m.length));
}
// Scan a Markdown document (or section), skipping YAML front matter, fenced code and $$ math blocks.
function collectNoteAnnotations(markdown,{allowFrontMatter=true}={}){
  const lines=String(markdown||'').split(/\r?\n/),out=[];
  let i=0,fence=null,mathBlock=false;
  if(allowFrontMatter&&lines[0]?.trim()==='---'){
    let end=1;while(end<lines.length&&!/^(?:---|\.\.\.)\s*$/.test(lines[end]))end++;
    if(end<lines.length)i=end+1;
  }
  for(;i<lines.length;i++){
    const raw=lines[i];
    if(fence){
      if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(raw))fence=null;
      continue;
    }
    const open=/^\s*(`{3,}|~{3,})/.exec(raw);
    if(open){fence=open[1];continue;}
    if(/^\s*\$\$\s*$/.test(raw)){mathBlock=!mathBlock;continue;}
    if(mathBlock)continue;
    for(const a of findAnnotations(maskVerbatimInLine(raw),0)){
      out.push({...a,lineIndex:i,target:raw.slice(a.targetFrom,a.targetTo)});
    }
  }
  return out;
}
// Rewrite or remove one annotation inside a Markdown section after verifying target and spec match.
function replaceSectionAnnotation(sectionText,target,oldSpec,ordinal,replacement){
  const eol=sectionText.includes('\r\n')?'\r\n':'\n',lines=sectionText.split(eol);
  const hits=collectNoteAnnotations(lines.join('\n'),{allowFrontMatter:false})
    .filter(a=>a.target===target&&sameSpec(a,oldSpec));
  const hit=hits[ordinal]??(hits.length===1?hits[0]:null);
  if(!hit)throw Error('笔记内容已变化，请稍后重试。');
  const line=lines[hit.lineIndex];
  lines[hit.lineIndex]=line.slice(0,hit.from)+replacement+line.slice(hit.to);
  return lines.join(eol);
}
// Markdown list of all annotations in a note for copying or review.
function formatAnnotationSummary(title,items){
  const heading=`## 标注汇总：${String(title||'当前笔记').trim()||'当前笔记'}`;
  if(!items?.length)return `${heading}\n\n（暂无标注）`;
  const rows=items.map((a,idx)=>{
    const dir=DIRECTIONS.find(d=>d.id===a.dir)?.label||'右下';
    return `${idx+1}. **${a.target}**（${dir}）：${a.note} *(第 ${a.lineIndex+1} 行)*`;
  });
  return `${heading}\n\n${rows.join('\n')}`;
}
module.exports={parseAnnotation,findAnnotations,formatAnnotation,parseBody,targetClasses,noteLines,noteTree,collectNoteAnnotations,replaceSectionAnnotation,formatAnnotationSummary,sameSpec,DIRECTIONS,COLORS,LINES,DEFAULTS,MAX_NOTE,KEEP};
