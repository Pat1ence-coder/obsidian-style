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
  const source=String(markdown||''),rawLines=source.split(/\r?\n/),out=[];
  const starts=[];
  let offset=0;
  for(const line of rawLines){
    starts.push(offset);
    offset+=line.length+(source[offset+line.length]==='\r'?2:1);
  }
  let i=0,fence=null,mathBlock=false;
  if(allowFrontMatter&&rawLines[0]?.trim()==='---'){
    let end=1;while(end<rawLines.length&&!/^(?:---|\.\.\.)\s*$/.test(rawLines[end]))end++;
    if(end<rawLines.length)i=end+1;
  }
  for(;i<rawLines.length;i++){
    const raw=rawLines[i],lineStart=starts[i];
    if(fence){
      if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(raw))fence=null;
      continue;
    }
    const open=/^\s*(`{3,}|~{3,})/.exec(raw);
    if(open){fence=open[1];continue;}
    if(/^\s*\$\$\s*$/.test(raw)){mathBlock=!mathBlock;continue;}
    if(mathBlock)continue;
    for(const a of findAnnotations(maskVerbatimInLine(raw),0)){
      out.push({...a,lineIndex:i,docFrom:lineStart+a.markFrom,docTo:lineStart+a.to,target:raw.slice(a.targetFrom,a.targetTo)});
    }
  }
  return out;
}
// Rewrite or remove one annotation inside a full Markdown document by matching its recorded target/spec.
function replaceNoteAnnotation(markdown,ref,replacement){
  const source=String(markdown||'');
  const hits=collectNoteAnnotations(source);
  const same=a=>a.target===ref.target&&sameSpec(a,ref);
  let hit=Number.isInteger(ref.docFrom)?hits.find(a=>a.docFrom===ref.docFrom&&same(a)):null;
  if(!hit&&Number.isInteger(ref.lineIndex))hit=hits.find(a=>a.lineIndex===ref.lineIndex&&same(a));
  if(!hit){
    const bySpec=hits.filter(same);
    if(bySpec.length===1)hit=bySpec[0];
  }
  if(!hit)throw Error('标注内容已变化，请刷新后重试。');
  const braceStart=hit.docFrom+(hit.from-hit.markFrom);
  return source.slice(0,braceStart)+replacement+source.slice(hit.docTo);
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
// Next or previous annotation relative to (lineIndex, ch), wrapping cleanly at document ends.
function findAdjacentAnnotation(items,lineIndex,ch,direction='next'){
  if(!items?.length)return null;
  if(direction==='prev'){
    for(let i=items.length-1;i>=0;i--){
      const a=items[i];
      if(a.lineIndex<lineIndex||(a.lineIndex===lineIndex&&a.markFrom<ch))return a;
    }
    return items[items.length-1];
  }
  return items.find(a=>a.lineIndex>lineIndex||(a.lineIndex===lineIndex&&a.markFrom>ch))??items[0];
}
// Index of the visible rect closest to the vertical viewport center, or -1 if none are in view.
function findClosestVisibleIndex(rects,viewTop,viewBottom){
  if(!rects?.length||!(viewBottom>viewTop))return -1;
  const center=(viewTop+viewBottom)/2;
  let best=-1,bestDist=Infinity;
  for(let i=0;i<rects.length;i++){
    const r=rects[i];
    if(!r||r.bottom<viewTop||r.top>viewBottom)continue;
    const dist=Math.abs((r.top+r.bottom)/2-center);
    if(dist<bestDist){bestDist=dist;best=i;}
  }
  return best;
}
// Choose left/right margin or inline (null) for one Reading-view annotation.
// In "smart" mode, mid-line targets (36%–64%) stay inline so connectors never cut across body text.
function chooseMarginSide(dir,layout,avail,counts,targetRect,sizerRect){
  if(layout==='inline')return null;
  if(layout==='left')return avail.left?'left':null;
  if(layout==='right')return avail.right?'right':null;
  if(targetRect&&sizerRect&&sizerRect.width>0){
    const ratio=Math.max(0,Math.min(1,(targetRect.left+targetRect.width/2-sizerRect.left)/sizerRect.width));
    if(ratio<0.36)return avail.left?'left':avail.right?'right':null;
    if(ratio>0.64)return avail.right?'right':avail.left?'left':null;
    return null;
  }
  const prefer=dir==='nw'||dir==='sw'?'left':dir==='ne'||dir==='se'?'right':null;
  if(prefer&&avail[prefer])return prefer;
  if(avail.left&&avail.right)return (counts?.left||0)<=(counts?.right||0)?'left':'right';
  return avail.left?'left':avail.right?'right':null;
}
// Deterministic vertical stacking for margin notes on one side: top-down push, bottom-up pull, top clamp.
function distributeMarginNotes(notes,containerHeight,gap=12,pad=8){
  if(!notes?.length)return [];
  const sorted=[...notes].sort((a,b)=>a.desiredY-b.desiredY);
  const placed=[];
  let nextY=pad;
  for(const n of sorted){
    const maxY=Math.max(pad,containerHeight-pad-n.height);
    const y=Math.min(maxY,Math.max(nextY,n.desiredY));
    placed.push({...n,y});
    nextY=y+n.height+gap;
  }
  for(let i=placed.length-2;i>=0;i--){
    placed[i].y=Math.min(placed[i].y,placed[i+1].y-gap-placed[i].height);
  }
  if(placed[0].y<pad){
    placed[0].y=pad;
    for(let i=1;i<placed.length;i++){
      placed[i].y=Math.max(placed[i].y,placed[i-1].y+placed[i-1].height+gap);
    }
  }
  return placed;
}
const fmtNum=v=>Number(v.toFixed(1)).toString();
const fmtPt=p=>`${fmtNum(p.x)} ${fmtNum(p.y)}`;
// Smooth polyline through sampled points using quadratic midpoints.
function smoothPolyline(pts){
  if(pts.length<2)return '';
  let d=`M${fmtPt(pts[0])}`;
  for(let i=1;i<pts.length-1;i++){
    const mid={x:(pts[i].x+pts[i+1].x)/2,y:(pts[i].y+pts[i+1].y)/2};
    d+=` Q${fmtPt(pts[i])} ${fmtPt(mid)}`;
  }
  return `${d} L${fmtPt(pts[pts.length-1])}`;
}
// Evaluate a cubic Bezier point and unit tangent at parameter t in [0, 1].
function cubicAt(p0,c1,c2,p3,t){
  const u=1-t,uu=u*u,tt=t*t;
  const x=uu*u*p0.x+3*uu*t*c1.x+3*u*tt*c2.x+tt*t*p3.x;
  const y=uu*u*p0.y+3*uu*t*c1.y+3*u*tt*c2.y+tt*t*p3.y;
  const dx=3*uu*(c1.x-p0.x)+6*u*t*(c2.x-c1.x)+3*tt*(p3.x-c2.x);
  const dy=3*uu*(c1.y-p0.y)+6*u*t*(c2.y-c1.y)+3*tt*(p3.y-c2.y);
  const m=Math.hypot(dx,dy)||1;
  return {x,y,tx:dx/m,ty:dy/m};
}
// Open hand-drawn arrowhead pointing into `to` along unit arrival direction (ux, uy).
function arrowHeadAt(to,ux,uy){
  const nx=-uy,ny=ux;
  const back=(d,w)=>({x:to.x-ux*d+nx*w,y:to.y-uy*d+ny*w});
  const a=back(8.5,4.6),m1=back(3.6,2.1),m2=back(3.6,-2.1),b=back(8.5,-4.6);
  return `M${fmtPt(a)} Q${fmtPt(m1)} ${fmtPt(to)} Q${fmtPt(m2)} ${fmtPt(b)}`;
}
// Long SVG connector from margin note (from) to target (to), supporting all 5 line styles.
// attach: 'side' (edge-flush target) | 'top' | 'bottom' (inset target, routed through inter-line gap).
function buildMarginConnector(side,lineStyle,from,to,attach='side'){
  const dx=to.x-from.x,dy=to.y-from.y,len=Math.max(1,Math.hypot(dx,dy));
  const sign=side==='left'?1:-1;
  let c1,c2;
  if(attach==='bottom'||attach==='top'){
    const ch=attach==='bottom'?15:-15;
    c1={x:from.x+dx*0.36,y:from.y+(to.y+ch-from.y)*0.35};
    c2={x:to.x-sign*14,y:to.y+ch};
  }else{
    const bend=Math.max(-22,Math.min(22,(dy>=0?1:-1)*Math.min(10,Math.abs(dy)*0.12+6)));
    c1={x:from.x+dx*0.36,y:from.y+bend};
    c2={x:from.x+dx*0.72,y:to.y-bend*0.6};
  }
  const endT=cubicAt(from,c1,c2,to,0.98);
  const head=arrowHeadAt(to,endT.tx,endT.ty);
  const offsetCurve=off=>{
    if(!off)return `M${fmtPt(from)} C${fmtPt(c1)} ${fmtPt(c2)} ${fmtPt(to)}`;
    const pts=[];
    for(let i=0;i<=18;i++){
      const p=cubicAt(from,c1,c2,to,i/18);
      pts.push({x:p.x-p.ty*off,y:p.y+p.tx*off});
    }
    return smoothPolyline(pts);
  };
  if(lineStyle==='double')return {lines:[offsetCurve(-1.5),offsetCurve(1.5)],head,dashed:true};
  if(lineStyle==='dashed')return {lines:[offsetCurve(0)],head,dashed:true};
  if(lineStyle==='solid')return {lines:[offsetCurve(0)],head,dashed:false};
  if(lineStyle==='wavy'){
    const waves=Math.max(2,Math.round(len/28)),samples=waves*8,pts=[];
    for(let i=0;i<=samples;i++){
      const t=i/samples,p=cubicAt(from,c1,c2,to,t),env=Math.sin(t*Math.PI);
      const across=Math.sin(t*waves*Math.PI*2)*3.8*env;
      pts.push({x:p.x-p.ty*across,y:p.y+p.tx*across});
    }
    return {lines:[smoothPolyline(pts)],head,dashed:false};
  }
  if(lineStyle==='spiral'){
    const turns=Math.min(2.4,Math.max(1.2,len/125)),amp=Math.min(11,Math.max(5.5,len*0.036));
    const alongR=Math.min(len*0.085,(len/turns)*0.3),samples=Math.max(40,Math.ceil(turns*22)),pts=[];
    for(let i=0;i<=samples;i++){
      const t=i/samples,p=cubicAt(from,c1,c2,to,t),ang=t*turns*Math.PI*2,rad=Math.sin(t*Math.PI)*(0.4+t*0.6);
      const along=Math.sin(ang)*alongR*rad,across=Math.cos(ang)*amp*rad;
      pts.push({x:p.x+p.tx*along-p.ty*across,y:p.y+p.ty*along+p.tx*across});
    }
    return {lines:[smoothPolyline(pts)],head,dashed:false};
  }
  return {lines:[offsetCurve(0)],head,dashed:false};
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
module.exports={parseAnnotation,findAnnotations,formatAnnotation,parseBody,targetClasses,noteLines,noteTree,collectNoteAnnotations,replaceNoteAnnotation,replaceSectionAnnotation,findAdjacentAnnotation,findClosestVisibleIndex,chooseMarginSide,distributeMarginNotes,buildMarginConnector,formatAnnotationSummary,sameSpec,DIRECTIONS,COLORS,LINES,DEFAULTS,MAX_NOTE,KEEP};
