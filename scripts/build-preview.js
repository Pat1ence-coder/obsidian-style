'use strict';
// Standard-library only. Render project-owned view code against a local stand-in.
// Output is script-free HTML: no browser, server, downloaded package or real-vault data.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {fixture,serialize}=require(path.join(root,'tests/helpers/workbench-host'));
const f=fixture(),today=f.Core.dayKey();
for(let i=1;i<=36;i++){
  const day=f.Core.dayKey(f.Core.shiftDay(new Date(),-i));
  const count=120+(i*73)%850;
  f.plugin.data.days[day]={characters:count,files:{[f.files[i%f.files.length].path]:count}};
}
f.plugin.data.settings.recentLimit=6;f.view.render();
const css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>海岸蓝工作台 · 静态示例</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f3}.preview-notice{padding:10px 20px;text-align:center;background:#fcfbf7;color:#68767c;font:12px system-ui}.aw-view{min-height:100vh}${css}</style></head><body class="theme-light"><div class="preview-notice">静态版式示例 · 演示数据 · 按钮不执行操作</div>${serialize(f.content)}</body></html>`;
const out=path.join(root,'artifacts/preview');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'workbench-static.html'),html);
fs.writeFileSync(path.join(out,'preview-meta.json'),JSON.stringify({createdAt:new Date().toISOString(),data:'synthetic',scripts:0,network:'blocked by CSP; embedded image only',renderer:'project-owned stand-in; not a browser screenshot'},null,2)+'\n');
if(/<script\b/i.test(html))throw Error('Static preview unexpectedly contains a script');
console.log('Script-free preview written:',path.join(out,'workbench-static.html'));
