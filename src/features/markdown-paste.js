'use strict';
const {Component}=require('obsidian');

// Pasting Markdown source. Code editors such as VS Code put the copied text on the clipboard
// twice: as plain text and as HTML, one <div> per line. Obsidian prefers the HTML and converts
// it to Markdown ("Auto convert HTML"), so every line becomes its own paragraph: a table falls
// apart into rows separated by blank lines. When the clipboard is clearly source text, the
// plain text is pasted as it is instead.

// A Markdown table: a row with a pipe, then the delimiter row (| --- | :-: | ...).
const TABLE=/^[ \t]*\|?[^\n]*\|[^\n]*\r?\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;
// Code editors (VS Code and its kin) wrap the copy in one <div> styled white-space: pre. Only
// that outer element counts: rich text from documents and web pages often carries pre-wrap or
// pre-line on inner spans (Google Docs does on every one), and keeps Obsidian's conversion.
const LEAD=/^(?:\s|<meta\b[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<!--[\s\S]*?-->)*/i;
const OUTER=/^<div\b[^>]*?\sstyle\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/i;
const PRE=/(?:^|;)\s*white-space\s*:\s*pre\s*(?:;|$)/i;
function fromCodeEditor(html){
  const outer=OUTER.exec(html.replace(LEAD,''));
  return !!outer&&PRE.test(outer[2]);
}

// The text to paste instead of Obsidian's HTML conversion, or null to leave the paste alone.
function sourceText(html,text){
  if(!html||!text)return null;
  if(!fromCodeEditor(html)&&!TABLE.test(text))return null;
  return text.replace(/\r\n?/g,'\n');
}

class MarkdownPaste extends Component{
  constructor(plugin){super();this.plugin=plugin;this.app=plugin.app;}
  onload(){this.registerEvent(this.app.workspace.on('editor-paste',(evt,editor)=>this.paste(evt,editor)));}
  paste(evt,editor){
    if(evt.defaultPrevented||!this.plugin.data?.settings?.pasteSource)return;
    const data=evt.clipboardData;
    // Files (pasted images) and Obsidian's own Markdown flavour keep their usual handling.
    if(!data||data.files?.length||data.getData('text/markdown'))return;
    const text=sourceText(data.getData('text/html'),data.getData('text/plain'));
    if(text==null)return;
    evt.preventDefault();
    // Marked as a paste, like Obsidian's own: counted as writing, and its own undo step.
    editor.replaceSelection(text,'input.paste');
  }
  displaySettings(container,Setting){
    const s=this.plugin.data.settings;
    new Setting(container).setName('粘贴 Markdown 源码保持原样')
      .setDesc('从 VS Code 等代码编辑器复制的内容，或带 Markdown 表格的文字，粘贴时按原文插入，不经过 Obsidian 的「自动转换 HTML」，表格不会被拆成一行一段。其他粘贴不受影响；需要临时按原文粘贴任何内容时，可用 ⌘⇧V（Windows 为 Ctrl+Shift+V）。')
      .addToggle(t=>t.setValue(!!s.pasteSource).onChange(v=>{s.pasteSource=v;this.plugin.changed();}));
  }
}
module.exports={MarkdownPaste,sourceText};
