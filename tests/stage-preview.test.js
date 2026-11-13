'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'aw-stage-test-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'repo'),outside=path.join(base,'outside');
  function write(name,content){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
  write('scripts/stage-preview.py',fs.readFileSync(path.join(__dirname,'../scripts/stage-preview.py')));
  for(const name of ['main.js','styles.css','manifest.json'])write('dist/algorithm-workbench/'+name,'runtime '+name);
  write('dist/snippets/style.css','snippet');
  write('examples/notes/note.md','sample note');
  write('examples/notes/assets/nested/chart.svg','sample image');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel'),'private content');
  const run=()=>spawnSync('python3',['-B','scripts/stage-preview.py'],{cwd:root,encoding:'utf8'});
  return {base,root,outside,write,run};
}

// Compare bytes and links without following them, including all external files.
function snapshot(directory){
  const result={};
  function visit(dir){
    for(const name of fs.readdirSync(dir).sort()){
      const file=path.join(dir,name),relative=path.relative(directory,file),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())result[relative]=['link',fs.readlinkSync(file)];
      else if(stat.isDirectory()){result[relative]=['directory'];visit(file);}
      else result[relative]=['file',fs.readFileSync(file).toString('base64')];
    }
  }
  visit(directory);return result;
}

test('staging initializes a fresh sandbox and preserves existing settings and user data',t=>{
  const f=fixture(t);let result=f.run();assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(path.join(f.root,'sandbox-vault/note.md'),'utf8'),'sample note');
  assert.equal(fs.readFileSync(path.join(f.root,'sandbox-vault/assets/nested/chart.svg'),'utf8'),'sample image');
  assert.equal(fs.readFileSync(path.join(f.root,'sandbox-vault/.obsidian/plugins/algorithm-workbench/main.js'),'utf8'),'runtime main.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'sandbox-vault/.obsidian/community-plugins.json'))),['algorithm-workbench']);
  f.write('sandbox-vault/.obsidian/appearance.json','{"custom":true}\n');
  f.write('sandbox-vault/.obsidian/plugins/algorithm-workbench/data.json','{"private":"statistics"}\n');
  const before=snapshot(f.base);result=f.run();assert.equal(result.status,0,result.stderr);
  assert.deepEqual(snapshot(f.base),before);
});

for(const target of [
  'sandbox-vault',
  'sandbox-vault/.obsidian',
  'sandbox-vault/.obsidian/plugins',
  'sandbox-vault/.obsidian/plugins/algorithm-workbench/main.js',
  'sandbox-vault/.obsidian/snippets/style.css',
  'sandbox-vault/.obsidian/appearance.json',
  'sandbox-vault/assets/nested',
  'sandbox-vault/assets/nested/chart.svg',
  'examples/notes/assets/nested',
  'dist/algorithm-workbench/main.js',
]){
  test('rejects symlink before any writes: '+target,t=>{
    const f=fixture(t),link=path.join(f.root,target);
    // All mutations here are restricted to this test's disposable fixture.
    fs.rmSync(link,{recursive:true,force:true});fs.mkdirSync(path.dirname(link),{recursive:true});
    fs.symlinkSync(f.outside,link,'dir');
    const before=snapshot(f.base),result=f.run();
    assert.notEqual(result.status,0);assert.match(result.stderr,/Symbolic links are not allowed/);
    assert.deepEqual(snapshot(f.base),before);
  });
}

test('rejects dangling destination links instead of creating an external file',t=>{
  const f=fixture(t),link=path.join(f.root,'sandbox-vault/.obsidian/app.json');
  fs.mkdirSync(path.dirname(link),{recursive:true});
  fs.symlinkSync(path.join(f.outside,'missing.json'),link);
  const before=snapshot(f.base),result=f.run();
  assert.notEqual(result.status,0);assert.match(result.stderr,/Symbolic links are not allowed/);
  assert.deepEqual(snapshot(f.base),before);
});

test('rejects links pointing inside the sandbox too',t=>{
  const f=fixture(t);f.write('sandbox-vault/other.md','keep');
  fs.symlinkSync('other.md',path.join(f.root,'sandbox-vault/note.md'));
  const before=snapshot(f.base),result=f.run();
  assert.notEqual(result.status,0);assert.match(result.stderr,/Symbolic links are not allowed/);
  assert.deepEqual(snapshot(f.base),before);
});
