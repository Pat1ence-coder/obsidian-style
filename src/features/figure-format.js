'use strict';
function imageReference(text) {
  const s=text.trim();
  if((s.match(/!\[/g)||[]).length!==1)return null;
  return /^!\[\[[^\r\n]+\]\]$/.test(s) || /^!\[[^\]\r\n]*\]\([^\r\n]+\)$/.test(s) ? s : null;
}
function figureMarkdown(reference, caption, width='640', align='center') {
  const references=Array.isArray(reference)?reference:[reference];
  const grid=/^grid-[1-4]$/.test(align);
  if(grid ? references.length<2 : references.length!==1)throw Error(grid?'多图布局至少需要两张图片。':'多张图片请选择多图布局。');
  const images=references.map(imageReference);
  if(images.some(image=>!image))throw Error('请为每个位置选择一张图片。');
  const size=grid?'':String(width).trim();
  if(size && (!/^\d+$/.test(size) || Number(size)<1 || Number(size)>4096))throw Error('宽度请输入 1–4096 的整数，留空使用原图宽度。');
  if(!grid&&!['left','center','right'].includes(align))throw Error('不支持的对齐方式。');
  const title=String(caption).replace(/[\r\n]+/g,' ').trim();
  if(!title)throw Error('请填写图注，例如「图 1 · 训练损失曲线」。');
  const embeds=images.map(image=>{
  let embed;
  if(image.startsWith('![[')) {
    const target=image.slice(3,-2).split('|')[0];
    embed=`![[${target}${size?'|'+Number(size):''}]]`;
  } else {
    embed=image.replace(/^!\[([^\]]*)\]/,(_m,alt)=>`![${alt.replace(/\|\d+(?:x\d+)?$/,'')}${size?'|'+Number(size):''}]`);
  }
  return embed;
  });
  return `> [!figure|${align}] ${title}\n${embeds.map(embed=>'> '+embed).join('\n')}`;
}
function spacedFigure(before,after,figure) {
  return (before && !before.endsWith('\n\n') ? before.endsWith('\n')?'\n':'\n\n' : '')
    +figure+(after ? after.startsWith('\n\n')?'':after.startsWith('\n')?'\n':'\n\n' : '\n');
}
module.exports={imageReference,figureMarkdown,spacedFigure};
