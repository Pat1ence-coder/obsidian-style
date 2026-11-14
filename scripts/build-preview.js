'use strict';
// Standard-library only. Render project-owned view code against a local stand-in.
// Output is script-free HTML: no browser, server, downloaded package or real-vault data.
const fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(path.resolve(__dirname,'..'));
const {checkedPath}=require('./safe-paths');
const tab=process.argv[2];
if(process.argv.length>3||(tab!==undefined&&!['board','recent','monthly'].includes(tab)))throw Error('Invalid preview view; use board, recent or monthly');
const out=path.join(root,'artifacts/preview');
const name=tab?`workbench-${tab}.html`:'workbench-static.html';
for(const file of [path.join(out,name),path.join(out,'preview-meta.json'),path.join(root,'dist/algorithm-workbench/styles.css')])checkedPath(root,file);
const {fixture,serialize}=require(path.join(root,'tests/helpers/workbench-host'));
const f=fixture(),today=f.Core.dayKey();
// Synthetic history: about six active weeks, with gaps and varied intensity.
f.plugin.data.activityStarted=f.plugin.data.started;
for(let i=1;i<=44;i++){
  if(i%9===4||i%13===7)continue;
  const day=f.Core.dayKey(f.Core.shiftDay(new Date(),-i));
  const count=120+(i*73)%1650,file=f.files[i%f.files.length].path;
  f.plugin.data.days[day]={characters:count,files:{[file]:count},minutes:12+(i*37)%95,focus:i%3?0:25+(i*11)%40,notes:i%4===0?1+(i%3):0,tasks:(i*5)%7};
}
Object.assign(f.plugin.data.days[today],{minutes:74,focus:31,notes:2,tasks:3});
f.plugin.data.settings.recentLimit=6;
if(process.argv[2])f.view.tab=process.argv[2];
f.view.render();
// ItemView.contentEl is Obsidian's .view-content; keep that class so its default padding is exercised.
f.content.classList.add('view-content');
const css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>知识脉冲看板 · 静态示例</title><style>*{box-sizing:border-box}body{margin:0;background:#eceef2}.preview-notice{padding:8px 20px;text-align:center;background:#fff;color:#686d7e;font:12px system-ui}.workspace-leaf-content{min-height:100vh;display:flex;flex-direction:column}.view-header{display:flex;align-items:center;height:40px;padding:0 16px;background:#fff;color:#686d7e;font:13px system-ui}.view-content{flex:1;padding:12px 12px 32px}${css}</style></head><body class="theme-light"><div class="preview-notice">静态版式示例 · 演示数据 · 按钮不执行操作</div><div class="workspace"><div class="workspace-split mod-root"><div class="workspace-leaf-content" data-type="algorithm-workbench"><div class="view-header">知识脉冲</div>${serialize(f.content)}</div></div></div></body></html>`;
if(/<script\b/i.test(html))throw Error('Static preview unexpectedly contains a script');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,name),html);
fs.writeFileSync(path.join(out,'preview-meta.json'),JSON.stringify({createdAt:new Date().toISOString(),data:'synthetic',scripts:0,network:'blocked by CSP; embedded image only',renderer:'project-owned stand-in; not a browser screenshot'},null,2)+'\n');
console.log('Script-free preview written:',path.join(out,name));
