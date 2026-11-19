'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');

function load(){
  const mod={exports:{}};
  const obsidian={Component:class{registerEvent(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/features/markdown-paste.js'),'utf8'),{module:mod,require:n=>n==='obsidian'?obsidian:null});
  return mod.exports;
}
const TABLE=['| 运行 ID | 模型 | F1 ↑ |','| :--- | :--- | ---: |','| run-001 | baseline | 81.24 |','| run-002 | variant-a | 82.61 |'];
// What VS Code puts on the clipboard: the plain text, and HTML with one <div> per line inside a
// preformatted outer <div>.
const vscodeHTML=lines=>`<meta charset='utf-8'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Menlo, Monaco, 'Courier New', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;">`
  +lines.map(l=>`<div><span style="color: #cccccc;">${l}</span></div>`).join('')+'</div>';

test('paste: source text from a code editor, or text holding a Markdown table, is pasted as written',()=>{
  const {sourceText}=load();
  assert.equal(sourceText(vscodeHTML(TABLE),TABLE.join('\n')),TABLE.join('\n'),'a table copied from VS Code');
  assert.equal(sourceText(vscodeHTML(TABLE),TABLE.join('\r\n')),TABLE.join('\n'),'Windows line ends become \\n');
  assert.equal(sourceText(vscodeHTML(['# 标题','- 列表']),'# 标题\n- 列表'),'# 标题\n- 列表','any source from a code editor');
  assert.equal(sourceText('<p>前文</p><p>后文</p>',TABLE.join('\n')),TABLE.join('\n'),'a Markdown table from anywhere');
  assert.equal(sourceText('<table><tr><td>a</td></tr></table>','a\tb\n1\t2'),null,'a rendered web table is left to Obsidian');
  assert.equal(sourceText('<p><b>粗体</b>与链接</p>','粗体与链接'),null,'rich text from a web page keeps the HTML conversion');
  assert.equal(sourceText('',TABLE.join('\n')),null,'no HTML: Obsidian pastes the plain text anyway');
  assert.equal(sourceText(vscodeHTML(['x']),''),null);
  assert.equal(sourceText('<p>a</p>','| 只有竖线 | 没有分隔行 |'),null,'pipes alone do not make a table');
  // Windows: Chromium keeps the CF_HTML wrapper around the fragment.
  const windows='<html>\r\n<body>\r\n<!--StartFragment-->'+vscodeHTML(['# 标题'])+'<!--EndFragment-->\r\n</body>\r\n</html>';
  assert.equal(sourceText(windows,'# 标题'),'# 标题','VS Code on Windows');
});
test('paste: rich text whose spans carry pre-wrap or pre-line keeps Obsidian\'s conversion',()=>{
  const {sourceText}=load();
  // Google Docs: every run of text is a span with white-space:pre-wrap, inside headings and links.
  const docs='<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h2 dir="ltr" style="line-height:1.38;"><span style="font-size:16pt;white-space:pre;white-space:pre-wrap;">小标题</span></h2>'
    +'<p dir="ltr"><a href="https://example.com"><span style="color:#1155cc;white-space:pre-wrap;">链接</span></a></p></b>';
  assert.equal(sourceText(docs,'小标题\n\n链接'),null,'Google Docs');
  assert.equal(sourceText('<div style="white-space: pre-line;">a<br>b</div>','a\nb'),null,'pre-line on the outer element');
  assert.equal(sourceText('<div style="white-space: pre-wrap;"><div>x</div></div>','x'),null,'pre-wrap on the outer element');
  assert.equal(sourceText('<p>前文</p><div style="white-space: pre;">code</div>','前文\ncode'),null,'a preformatted block further in is not the outer element');
});

test('paste: the plugin takes over only clear source pastes, and only when switched on',()=>{
  const {MarkdownPaste}=load();
  const handlers={},plugin={data:{settings:{pasteSource:true}},changed(){},app:{workspace:{on:(name,fn)=>{handlers[name]=fn;return {};}}}};
  const paste=new MarkdownPaste(plugin);paste.onload();
  const run=(types,{files=[],prevented=false}={})=>{
    let inserted=null;
    const evt={defaultPrevented:prevented,preventDefault(){this.defaultPrevented=true;},clipboardData:{files,getData:t=>types[t]??''}};
    handlers['editor-paste'](evt,{replaceSelection:(t,origin)=>{inserted=t;assert.equal(origin,'input.paste','marked as a paste, like Obsidian\'s own');}});
    return {taken:evt.defaultPrevented&&!prevented,inserted};
  };
  const table={'text/html':vscodeHTML(TABLE),'text/plain':TABLE.join('\r\n')};
  assert.deepEqual(run(table),{taken:true,inserted:TABLE.join('\n')});
  assert.deepEqual(run(table,{files:[{name:'a.png'}]}),{taken:false,inserted:null},'pasted images keep their handling');
  assert.deepEqual(run({...table,'text/markdown':'x'}),{taken:false,inserted:null},'Obsidian\'s own Markdown flavour wins');
  assert.deepEqual(run(table,{prevented:true}),{taken:false,inserted:null},'another handler already took it');
  assert.deepEqual(run({'text/html':'<p>网页</p>','text/plain':'网页'}),{taken:false,inserted:null});
  plugin.data.settings.pasteSource=false;
  assert.deepEqual(run(table),{taken:false,inserted:null},'switched off');
});
