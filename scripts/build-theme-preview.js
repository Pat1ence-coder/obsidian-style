'use strict';
// Standard-library only. A script-free mock of Obsidian's window using its real class
// names, so the document snippet can be eyeballed. HOST approximates how Obsidian's own
// app.css consumes theme variables; it is not Obsidian's stylesheet.
const fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(path.resolve(__dirname,'..'));
const {checkedPath}=require('./safe-paths');
const out=path.join(root,'artifacts/preview');
checkedPath(root,path.join(out,'theme-static.html'));
checkedPath(root,path.join(root,'dist/snippets/style.css'));
const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
// Plugin styles too: the scroll ruler, annotations and figure tools live there.
const pluginCSS=fs.readFileSync(checkedPath(root,path.join(root,'dist/algorithm-workbench/styles.css')),'utf8');
const assets=path.join(root,'examples/notes/assets');
const svg=name=>{const file=checkedPath(root,path.join(assets,name));return 'data:image/svg+xml;base64,'+fs.readFileSync(file).toString('base64');};
// A wide, unsized "screenshot" exercises the screen size guard for single figures.
const wide='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1000"><rect width="1800" height="1000" fill="#f5f5f7"/><rect x="60" y="60" width="1680" height="80" rx="16" fill="#e6e8ec"/><rect x="60" y="190" width="520" height="740" rx="20" fill="#dde8f0"/><rect x="640" y="190" width="1100" height="340" rx="20" fill="#e9e6ef"/><rect x="640" y="590" width="1100" height="340" rx="20" fill="#e1eeea"/></svg>').toString('base64');
const embed=(src,alt)=>`<span class="internal-embed media-embed image-embed is-loaded"><img src="${src}" alt="${alt}"></span>`;
const HOST=`*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:var(--font-interface);font-size:13px;color:var(--text-normal);background:var(--background-secondary);--tab-container-background:var(--background-secondary)}
.app-container{display:flex;height:100vh}
.markdown-rendered mark{background:var(--text-highlight-bg)}
.markdown-rendered ul{padding-inline-start:1.4em}.markdown-rendered li::marker{color:var(--list-marker-color)}
.menu{position:fixed;right:64px;top:120px;width:210px;padding:6px;z-index:5}.menu-item{padding:6px 10px;border-radius:6px;font-size:13px}.menu-item.selected{background:var(--background-modifier-hover)}.menu-separator{height:1px;margin:4px 8px;background:var(--divider-color)}
.workspace-ribbon{width:48px;background:var(--ribbon-background);display:flex;flex-direction:column;align-items:center;padding:46px 0 10px;border-right:1px solid var(--divider-color)}
.side-dock-actions,.side-dock-settings{display:flex;flex-direction:column;align-items:center;gap:6px}.side-dock-settings{margin-top:auto}
.clickable-icon{display:flex;align-items:center;justify-content:center;padding:4px 6px;border-radius:var(--clickable-icon-radius,4px);color:var(--icon-color)}
.clickable-icon svg,.workspace-tab-header-inner-icon svg,.collapse-icon svg{width:var(--icon-size,18px);height:var(--icon-size,18px);fill:none;stroke:currentColor;stroke-width:var(--icon-stroke,1.75px);stroke-linecap:round;stroke-linejoin:round}
.workspace-split.mod-left-split{position:relative;width:250px;background:var(--background-secondary);display:flex;flex-direction:column}
/* Obsidian draws the sidebar divider with the resize handle on the split's inner edge. */
.workspace-leaf-resize-handle{position:absolute;top:0;bottom:0;right:0;width:3px;border-right:1px solid var(--divider-color)}
.mod-left-split>.workspace-tabs{flex:1;display:flex;flex-direction:column;min-height:0}
.workspace-split.mod-root{flex:1;display:flex;flex-direction:column;min-width:0}
/* Approximates Obsidian's own header sizing: the inner row sits 6px down and tabs stretch to fill it. */
.workspace-tab-header-container{display:flex;height:40px;background:var(--tab-container-background)}
.workspace-tab-header-container-inner{display:flex;flex:1;gap:4px;margin-top:6px;padding:0 10px}
.workspace-tab-header{display:flex;align-items:center;padding:0 14px;border-radius:var(--tab-radius) var(--tab-radius) 0 0;color:var(--tab-text-color)}
.mod-left-split .workspace-tab-header-container{padding-left:76px;align-items:center}.mod-left-split .workspace-tab-header-container-inner{margin:0;padding:0 6px;gap:2px;align-items:center}
.mod-left-split .workspace-tab-header{padding:0;border-radius:var(--tab-radius)}.workspace-tab-header-inner{display:flex;align-items:center;padding:4px 6px}.workspace-tab-header-inner-icon{display:flex;color:var(--icon-color)}
.traffic{position:fixed;left:12px;top:13px;display:flex;gap:8px;z-index:9}.traffic i{width:12px;height:12px;border-radius:50%;background:#ed6a5e}.traffic i+i{background:#f5bf4f}.traffic i+i+i{background:#61c554}
.workspace-tab-header.is-active{background:var(--tab-background-active);color:var(--tab-text-color-focused-active)}
.workspace-tab-container{flex:1;display:flex;min-height:0}
.workspace-leaf-content{flex:1;display:flex;flex-direction:column;min-width:0}
.view-header{height:40px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px}
.view-content{flex:1;min-height:0;display:flex;overflow:hidden}.markdown-reading-view{flex:1;display:flex;min-height:0;min-width:0}.markdown-reading-view>.markdown-preview-view{flex:1;overflow:auto}
.nav-header{padding:8px 12px}.nav-buttons-container{display:flex;justify-content:center;gap:2px}
.nav-files-container{padding:4px 8px}
.tree-item-self{display:flex;align-items:center;padding:var(--nav-item-padding,4px 8px 4px 24px);margin:1px 0;border-radius:var(--nav-item-radius);color:var(--nav-item-color);font-size:var(--nav-item-size,13px);font-weight:var(--nav-item-weight,400);position:relative}
.tree-item-self.is-active{background:var(--nav-item-background-active);color:var(--nav-item-color-active);font-weight:var(--nav-item-weight-active)}
.nav-folder-title{padding-left:24px}.collapse-icon{position:absolute;left:4px;display:flex;color:var(--nav-collapse-icon-color,var(--icon-color))}.collapse-icon svg{width:14px;height:14px}
.tree-item-children{margin-inline-start:var(--nav-item-children-margin-start,12px);padding-inline-start:var(--nav-item-children-padding-start,4px);border-inline-start:var(--nav-indentation-guide-width,1px) solid var(--nav-indentation-guide-color)}
.markdown-preview-view{padding:32px var(--file-margins);color:var(--text-normal)}
.inline-title{font-size:var(--inline-title-size);font-weight:var(--inline-title-weight);line-height:var(--inline-title-line-height);color:var(--inline-title-color)}
.markdown-rendered h1{font-size:var(--h1-size);font-weight:var(--h1-weight);color:var(--h1-color)}
.markdown-rendered h2{font-size:var(--h2-size);font-weight:var(--h2-weight);color:var(--h2-color)}
.markdown-rendered h3{font-size:var(--h3-size);font-weight:var(--h3-weight);color:var(--h3-color)}
.markdown-rendered a{color:var(--link-color);text-decoration:none}
a.tag{background:var(--tag-background);color:var(--tag-color);border-radius:var(--tag-radius);padding:var(--tag-padding-y) var(--tag-padding-x);font-weight:var(--tag-weight)}
.markdown-rendered blockquote{border-inline-start:var(--blockquote-border-thickness) solid var(--blockquote-border-color);background:var(--blockquote-background-color);color:var(--blockquote-color);margin-inline:0}
.callout{padding:var(--callout-padding);margin:1em 0}.callout-title{display:flex;gap:8px;font-weight:var(--callout-title-weight)}
.task-list-item{list-style:none;margin-inline-start:-1.4em}.task-list-item input{appearance:none;width:15px;height:15px;border:1px solid var(--checkbox-border-color);border-radius:var(--checkbox-radius);vertical-align:-2px;margin-right:8px}
.task-list-item.is-checked input{background:var(--checkbox-color);border-color:var(--checkbox-color)}.task-list-item.is-checked{color:var(--checklist-done-color);text-decoration:line-through}
.status-bar{position:fixed;right:10px;bottom:4px;color:var(--status-bar-text-color);background:var(--status-bar-background)}
code .kw{color:var(--code-keyword)}code .fn{color:var(--code-function)}code .st{color:var(--code-string)}code .cm{color:var(--code-comment)}code .nu{color:var(--code-value)}`;
// Lucide-style outline icons, drawn with the host's stroke settings.
const ICONS={grid:'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',calendar:'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',chart:'M4 20V10 M10 20V4 M16 20v-8 M22 20H2',activity:'M22 12h-4l-3 9L9 3l-3 9H2',notebookPen:'M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4 M2 6h4 M2 10h4 M2 14h4 M2 18h4 M21.4 5.6a2 2 0 1 0-2.8-2.8l-5.4 5.4-.9 3.7 3.7-.9z',
  file:'M6 3h8l4 4v14H6z M14 3v5h4',help:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7 M12 17h.01',settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  folder:'M3 6h7l2 2h9v11H3z',search:'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',bookmark:'M6 3h12v18l-6-4-6 4z',edit:'M12 20h9 M16.4 3.6a2 2 0 0 1 2.9 2.9L7 18.8 3 20l1.2-4z',
  folderPlus:'M3 6h7l2 2h9v11H3z M12 11v5 M9.5 13.5h5',sort:'M3 6h12 M3 12h8 M3 18h4 M18 6v14 M15 17l3 3 3-3',collapse:'M7 15l5 5 5-5 M7 9l5-5 5 5',chevron:'M6 9l6 6 6-6'};
const ico=name=>`<svg viewBox="0 0 24 24"><path d="${ICONS[name]}"/></svg>`;
const ribbon=`<div class="side-dock-actions">${['grid','calendar','chart','notebookPen','file'].map(n=>`<div class="clickable-icon side-dock-ribbon-action">${ico(n)}</div>`).join('')}</div><div class="side-dock-settings">${['help','settings'].map(n=>`<div class="clickable-icon side-dock-ribbon-action">${ico(n)}</div>`).join('')}</div>`;
const sideTabs=`<div class="workspace-tab-header-container-inner">${['folder','search','bookmark'].map((n,i)=>`<div class="workspace-tab-header${i?'':' is-active'}"><div class="workspace-tab-header-inner"><div class="workspace-tab-header-inner-icon">${ico(n)}</div></div></div>`).join('')}</div>`;
const navButtons=`<div class="nav-buttons-container">${['edit','folderPlus','sort','collapse'].map(n=>`<div class="clickable-icon nav-action-button">${ico(n)}</div>`).join('')}</div>`;
const tree=[['研究',[['Attention 机制与梯度推导',true],['对比学习阅读笔记']]],['实验',[['检索模型消融实验']]],['工程',[['推理服务延迟排查'],['数据集版本说明']]]];
const files=tree.map(([folder,items])=>`<div class="tree-item nav-folder"><div class="tree-item-self nav-folder-title is-clickable mod-collapsible"><div class="tree-item-icon collapse-icon">${ico('chevron')}</div><div class="tree-item-inner nav-folder-title-content">${folder}</div></div><div class="tree-item-children nav-folder-children">`
  +items.map(([name,active])=>`<div class="tree-item nav-file"><div class="tree-item-self nav-file-title is-clickable${active?' is-active':''}"><div class="tree-item-inner nav-file-title-content">${name}</div></div></div>`).join('')+'</div></div>').join('')
  +`<div class="tree-item nav-file"><div class="tree-item-self nav-file-title is-clickable"><div class="tree-item-inner nav-file-title-content">README</div></div></div>`;
// Annotations drawn by the plugin's own tree (annotation-format.js is pure), so the preview
// shows exactly what the plugin renders.
const Annot=require('../src/features/annotation-format');
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const toHTML=node=>{
  const attrs=Object.entries(node.attrs||{}).map(([k,v])=>` ${k}="${esc(v)}"`).join('');
  const cls=node.cls?` class="${esc(node.cls)}"`:'',style=node.color?` style="--aw-annot-color:${esc(node.color)}"`:'';
  return `<${node.tag}${cls}${attrs}${style}>${node.text!=null?esc(node.text):''}${(node.children||[]).map(toHTML).join('')}</${node.tag}>`;
};
const annotate=source=>source.replace(/==([^=]+)==(\{[^{}]+\})/g,(_m,target,braces)=>{
  const spec=Annot.parseAnnotation(braces),where=Annot.placement(spec),note=toHTML(Annot.noteTree(spec));
  const mark=`<mark class="${Annot.targetClasses(spec).join(' ')}">${esc(target)}${where==='pin'?note:''}</mark>`;
  return where==='before'?note+mark:where==='after'?mark+note:mark;
});
const note=`<div class="inline-title">Attention 机制与梯度推导</div>
<p><a class="tag">#研究</a> <a class="tag">#transformer</a></p>
<p>缩放点积注意力把查询与键的相似度归一化后，对值做加权平均。下面整理前向公式与 <code>softmax</code> 的雅可比矩阵，并记录一次<a>消融实验</a>的结论。</p>
<h2>1. 前向计算</h2>
<p>给定 <strong>Q、K、V</strong>，输出为 softmax(QKᵀ/√d)·V。缩放因子${annotate('防止点积随维度增大而进入 ==softmax 的饱和区=={标注一下}，梯度几乎为零；')}${annotate('在 ==√d 缩放=={防止梯度消失|右上 橙}之外，')}还可以引入 ${annotate('==温度系数=={可学习|左下 绿 虚线}')}，并在消融中对比 ${annotate('==两种写法=={对照|右 紫}')}。</p>
<div class="callout" data-callout="diagram"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">Knowledge / four states</div></div><div class="callout-content"><ul><li><strong>原始输入</strong>文章 · 想法 · 记录<code>raw</code></li><li><strong>参考资料</strong>来源 · 证据 · 资料<code>source</code></li><li><strong>综合认识</strong>对照 · 判断 · 提炼<code>knowledge</code></li><li><strong>场景输出</strong>文章 · 方案 · 答案<code>output</code></li></ul><p>按需要来回使用，也可以停留在任何一种状态</p></div></div>
<div class="callout" data-callout="diagram" data-callout-metadata="rows"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">Vault / three planes</div></div><div class="callout-content"><ul><li><strong>CORE /</strong>跨主题规范与系统规则<code>protected</code></li><li><strong>TOPICS /</strong>资料、研究、知识与输出<code>context</code></li><li><strong>SIDECAR /</strong>工具、索引与运行状态<code>runtime</code></li></ul></div></div>
<div class="callout" data-callout="note"><div class="callout-title">ⓘ 记录</div><div class="callout-content"><p>维度 d=64 时，未缩放版本训练前 2k 步的梯度范数下降约 40%。</p></div></div>
<h2>2. 实验对比</h2>
<div class="callout" data-callout="table"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner"><span class="aw-caption-label">表 1</span> 不同配置的检索效果与开销</div></div><div class="callout-content"><table><thead><tr><th>方法</th><th align="right">MRR@10</th><th align="right">延迟 ms</th><th align="right">参数量</th></tr></thead>
<tbody><tr><td>Baseline</td><td align="right">0.372</td><td align="right">18.4</td><td align="right">110M</td></tr><tr><td>+ 缩放</td><td align="right">0.391</td><td align="right">18.6</td><td align="right">110M</td></tr><tr><td>+ 缩放 + 温度</td><td align="right">0.398</td><td align="right">18.7</td><td align="right">110M</td></tr></tbody></table></div></div>
<pre><code><span class="kw">def</span> <span class="fn">attention</span>(q, k, v, d):
    <span class="cm"># 缩放点积注意力</span>
    w = softmax(q @ k.T / d ** <span class="nu">0.5</span>)
    <span class="kw">return</span> w @ v  <span class="st">"weighted sum"</span></code></pre>
<h3>待办</h3>
<ul class="contains-task-list"><li class="task-list-item is-checked"><input type="checkbox" checked>推导 softmax 雅可比</li><li class="task-list-item is-checked"><input type="checkbox" checked>补充温度系数实验</li><li class="task-list-item"><input type="checkbox">整理成组会报告</li></ul>
<blockquote><p>注意力不是解释，但它是一个好的调试入口。</p></blockquote>
<h2>3. 插图</h2>
<p>未设置宽度的大截图在屏幕上限制为 720px，并保持比例；多图组的小图不再被拉伸。<mark>打印规则保持不变</mark>。</p>
<div class="callout" data-callout="figure" data-callout-metadata="center"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner"><span class="aw-caption-label">图 1</span> · 未设宽度的宽幅截图</div></div><div class="callout-content"><p>${embed(wide,'wide')}</p></div></div>
<div class="callout" data-callout="figure" data-callout-metadata="grid-2"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner"><span class="aw-caption-label">图 2</span> · 两列小图保持原始尺寸</div></div><div class="callout-content"><p>${embed(svg('compact-1.svg'),'a')}<br>${embed(svg('compact-2.svg'),'b')}<br>${embed(svg('compact-3.svg'),'c')}</p></div></div>
<div class="callout" data-callout="figure" data-callout-metadata="mosaic-left"><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner"><span class="aw-caption-label">图 3</span> · 一大两小：左侧大图，右侧两张小图</div></div><div class="callout-content"><p>${embed(wide,'big')}<br>${embed(svg('compact-1.svg'),'a')}<br>${embed(svg('compact-2.svg'),'b')}</p></div></div>
<hr>
<div class="callout" data-callout="tip"><div class="callout-title">✦ 提示</div><div class="callout-content"><p>温度系数与缩放因子可以合并为一个可学习参数。</p></div></div>
<div class="callout" data-callout="warning"><div class="callout-title">⚠ 注意</div><div class="callout-content"><p>batch 内的负样本过少时，MRR 波动会明显增大。</p></div></div>
<div class="callout" data-callout="abstract"><div class="callout-title">≡ 摘要</div><div class="callout-content"><p>缩放 + 温度带来约 2.6 个点的 MRR 提升，延迟几乎不变。</p></div></div>`;
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>主题外框 · 静态示例</title><style>${HOST}\n${snippet}\n${pluginCSS}</style></head>
<body class="theme-light"><div class="app-container workspace"><div class="workspace-ribbon side-dock-ribbon mod-left">${ribbon}</div>
<div class="traffic"><i></i><i></i><i></i></div><div class="workspace-split mod-horizontal mod-sidedock mod-left-split"><div class="workspace-tabs"><div class="workspace-tab-header-container">${sideTabs}</div><div class="workspace-tab-container"><div class="workspace-leaf-content" data-type="file-explorer"><div class="nav-header">${navButtons}</div><div class="nav-files-container">${files}</div></div></div></div><div class="workspace-leaf-resize-handle"></div></div>
<div class="workspace-split mod-vertical mod-root"><div class="workspace-tabs"><div class="workspace-tab-header-container"><div class="workspace-tab-header-container-inner"><div class="workspace-tab-header"><div class="workspace-tab-header-inner"><div class="workspace-tab-header-inner-title">写作工作台</div></div></div><div class="workspace-tab-header is-active"><div class="workspace-tab-header-inner"><div class="workspace-tab-header-inner-title">Attention 机制与梯度推导</div></div></div></div></div></div>
<div class="workspace-tab-container"><div class="workspace-leaf-content" data-type="markdown"><div class="view-header"><div class="view-header-title">研究 / Attention 机制与梯度推导</div></div><div class="view-content aw-has-ruler"><div class="markdown-reading-view"><div class="markdown-preview-view markdown-rendered"><div class="markdown-preview-sizer">${note}</div></div></div><div class="aw-ruler" aria-hidden="true"><div class="aw-ruler-knob" style="top:18%"><span class="aw-ruler-label">0.18</span></div></div></div></div></div></div>
</div><div class="menu"><div class="menu-item">在新标签页打开</div><div class="menu-item selected">在右侧打开</div><div class="menu-separator"></div><div class="menu-item">复制链接</div><div class="menu-item">重命名…</div></div><div class="status-bar">1,286 字 · 编辑 74 分钟</div></body></html>`;
if(/<script\b/i.test(html))throw Error('Static preview unexpectedly contains a script');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'theme-static.html'),html);
console.log('Script-free theme preview written:',path.join(out,'theme-static.html'));
// Frosted paper window variants (窗口毛玻璃). The paper and the glass are drawn by the theme
// itself, so these pages show exactly what Obsidian will: no stand-in picture.
for(const [file,theme] of [['theme-glass.html','theme-light'],['theme-glass-dark.html','theme-dark']]){
  const page=html.replace('<body class="theme-light">',`<body class="${theme} aw-glass aw-glass-fog-normal">`);
  fs.writeFileSync(checkedPath(root,path.join(out,file)),page);
}
console.log('Frosted window previews written.');
