'use strict';
// Line-level edits of a figure callout. Every function takes the note's lines and
// returns new lines; nothing here touches the DOM or the vault.
const {LAYOUT,isGroup}=require('./figure-format');
const HEADER=/^(\s*>\s*)\[!(figure|table)(?:\|([^\]]*))?\]([+-]?)(.*)$/i;
const QUOTED=/^\s*>/;
const IMAGE=/!\[\[([^\]|]+)(?:\|(\d+)(?:x\d+)?)?\]\]|!\[([^\]|]*)(?:\|(\d+)(?:x\d+)?)?\]\(([^)]+)\)/g;

function imagesIn(text) {
  return [...text.matchAll(IMAGE)].map(m=>({text:m[0],index:m.index,width:Number(m[2]||m[4])||null}));
}
// Walk up to the callout header and down to its last quoted line.
function findBlock(lines, line) {
  if(line<0||line>=lines.length||!QUOTED.test(lines[line]))return null;
  let start=line;
  while(start>0&&!HEADER.test(lines[start])&&QUOTED.test(lines[start-1]))start--;
  const header=HEADER.exec(lines[start]);
  if(!header||header[2].toLowerCase()!=='figure')return null;
  let end=start;
  while(end+1<lines.length&&QUOTED.test(lines[end+1])&&!HEADER.test(lines[end+1]))end++;
  const images=[];
  for(let i=start+1;i<=end;i++){
    const found=imagesIn(lines[i]);
    if(found.length===1)images.push({line:i,width:found[0].width});
  }
  return {start,end,prefix:header[1],meta:(header[3]||'').trim(),fold:header[4],caption:header[5],images};
}
function replaceWidth(embed, width) {
  const size=width?'|'+width:'';
  if(embed.startsWith('![['))return embed.replace(/^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/,(_m,target)=>`![[${target}${size}]]`);
  return embed.replace(/^!\[([^\]|]*)(?:\|[^\]]*)?\]/,(_m,alt)=>`![${alt}${size}]`);
}
function setWidth(lines, block, imageIndex, width) {
  const image=block.images[imageIndex];
  if(!image)throw Error('找不到这张图片。');
  if(width!==null&&(!Number.isInteger(width)||width<1||width>4096))throw Error('宽度需为 1–4096 的整数。');
  const text=lines[image.line],[found]=imagesIn(text),next=lines.slice();
  next[image.line]=text.slice(0,found.index)+replaceWidth(found.text,width)+text.slice(found.index+found.text.length);
  return next;
}
function setMeta(lines, block, meta) {
  if(!LAYOUT.test(meta))throw Error('不支持的布局。');
  const grid=isGroup(meta),wasGrid=isGroup(block.meta);
  if(grid!==wasGrid)throw Error(grid?'单图不能切换为多图布局。':'多图组只能切换多图布局。');
  const next=lines.slice();
  next[block.start]=`${block.prefix}[!figure|${meta}]${block.fold}${block.caption}`;
  return next;
}
// Reorder image lines only; captions, blank quoted lines and other content stay put.
function moveImage(lines, block, from, to) {
  const slots=block.images.map(image=>image.line);
  const valid=i=>Number.isInteger(i)&&i>=0&&i<slots.length;
  if(!valid(from)||!valid(to))throw Error('找不到要移动的图片。');
  const order=slots.map(line=>lines[line]),[moved]=order.splice(from,1);order.splice(to,0,moved);
  const next=lines.slice();
  slots.forEach((line,i)=>{next[line]=order[i];});
  return next;
}
// "图 1"、"表 2-3"、"Figure 4"、"Fig. 5"、"Table 6": the label part of a caption.
const LABEL=/^\s*((?:图|表|Fig\.?|Figure|Table)\s*\d+(?:[.\-–]\d+)*)/i;
function captionLabel(text) {
  const m=LABEL.exec(text);
  return m?{label:m[1],rest:text.slice(m[0].length)}:null;
}
module.exports={findBlock,setWidth,setMeta,moveImage,captionLabel,imagesIn,isGroup};
