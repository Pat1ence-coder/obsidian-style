'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..');
function fixture(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aw-security-')));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const repo=path.join(base,'repo'),external=path.join(base,'external');
  fs.mkdirSync(repo);fs.mkdirSync(external);
  for(const name of ['scripts','src','examples','tests/helpers','manifest.json','package.json'])
    fs.cpSync(path.join(project,name),path.join(repo,name),{recursive:true});
  const run=(script,...args)=>spawnSync(script.endsWith('.py')?'python3':process.execPath,
    script.endsWith('.py')?['-B',script,...args]:[script,...args],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const build=run('scripts/build.js');assert.equal(build.status,0,build.stderr);
  return {base,repo,external,run};
}
function snapshot(root){
  const entries=[];
  function visit(p){
    const s=fs.lstatSync(p),rel=path.relative(root,p);
    if(s.isSymbolicLink())entries.push([rel,'link',fs.readlinkSync(p)]);
    else if(s.isDirectory()){entries.push([rel,'dir']);for(const name of fs.readdirSync(p).sort())visit(path.join(p,name));}
    else entries.push([rel,'file',fs.readFileSync(p).toString('base64')]);
  }
  visit(root);return entries;
}
function link(f,relative,{directory=false,dangling=false}={}){
  const dest=path.join(f.repo,relative),outside=path.join(f.external,'victim');
  fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(path.dirname(dest),{recursive:true});
  if(!dangling){if(directory)fs.mkdirSync(outside);else fs.writeFileSync(outside,'SYNTHETIC_PRIVATE_CONTENT');}
  fs.symlinkSync(outside,dest,directory?'dir':'file');
}
function rejectedWithoutWrites(f,script,...args){
  const before=snapshot(f.base),result=f.run(script,...args);
  assert.notEqual(result.status,0,'Expected rejection');
  assert.match(result.stderr,/Symbolic links are not allowed|Invalid preview view/);
  assert.deepEqual(snapshot(f.base),before,'Rejected operation must not alter any files');
}
for(const [script,relative,directory] of [
  ['build.js','dist',true],['build.js','dist/algorithm-workbench',true],
  ['build.js','dist/snippets/style.css',false],['build.js','dist/algorithm-workbench/main.js',false],
  ['build-preview.js','artifacts',true],['build-preview.js','artifacts/preview/preview-meta.json',false],
  ['build-theme-preview.js','artifacts/preview',true],['build-theme-preview.js','artifacts/preview/theme-static.html',false],
  ['stage-preview.py','sandbox-vault',true],['stage-preview.py','sandbox-vault/.obsidian/plugins',true],
  ['stage-preview.py','sandbox-vault/.obsidian/snippets/style.css',false],
  ['stage-preview.py','sandbox-vault/assets',true],['stage-preview.py','sandbox-vault/01-排版样板.md',false],
  ['stage-preview.py','sandbox-vault/.obsidian/app.json',false],
  ['stage-preview.py','examples/notes/imported.md',false],
  ['stage-preview.py','examples/notes/assets/private',true],
  ['stage-preview.py','examples/notes/assets/private.svg',false],
  ['stage-preview.py','dist/algorithm-workbench/main.js',false]
])test(`${script} refuses linked ${relative} before any writes`,t=>{
  const f=fixture(t);link(f,relative,{directory});rejectedWithoutWrites(f,'scripts/'+script);
});
for(const [script,relative] of [
  ['build.js','dist/algorithm-workbench/main.js'],['build-preview.js','artifacts/preview/workbench-static.html'],
  ['stage-preview.py','sandbox-vault/.obsidian/appearance.json'],['stage-preview.py','examples/notes/dangling.md']
])test(`${script} refuses dangling link ${relative}`,t=>{
  const f=fixture(t);link(f,relative,{dangling:true});rejectedWithoutWrites(f,'scripts/'+script);
});
test('view arguments cannot escape the preview output or select unknown views',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.external,'report.html'),'original');
  for(const value of ['../../../../../external/report','/tmp/report','unknown',''])
    rejectedWithoutWrites(f,'scripts/build-preview.js',value);
});
test('normal build, all preview views and staging still work and preserve settings',t=>{
  const f=fixture(t);
  for(const tab of [undefined,'board','recent','monthly']){
    const r=f.run('scripts/build-preview.js',...(tab===undefined?[]:[tab]));assert.equal(r.status,0,r.stderr);
  }
  let r=f.run('scripts/build-theme-preview.js');assert.equal(r.status,0,r.stderr);
  r=f.run('scripts/stage-preview.py');assert.equal(r.status,0,r.stderr);
  const settings=path.join(f.repo,'sandbox-vault/.obsidian/app.json');fs.writeFileSync(settings,'{"preserve":true}');
  r=f.run('scripts/stage-preview.py');assert.equal(r.status,0,r.stderr);
  assert.equal(fs.readFileSync(settings,'utf8'),'{"preserve":true}');
  assert.deepEqual(fs.readFileSync(path.join(f.repo,'sandbox-vault/.obsidian/plugins/algorithm-workbench/main.js')),
    fs.readFileSync(path.join(f.repo,'dist/algorithm-workbench/main.js')));
});
