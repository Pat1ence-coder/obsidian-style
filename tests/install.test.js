'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const script=path.resolve(__dirname,'../scripts/install.py');
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aw-update-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),config=path.join(root,'.obsidian'),target=path.join(config,'plugins','algorithm-workbench');
  fs.mkdirSync(source,{recursive:true});fs.mkdirSync(target,{recursive:true});
  for(const dir of [source,target]){
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({id:'algorithm-workbench',version:'0.0.1'}));
    fs.writeFileSync(path.join(dir,'main.js'),dir===source?'new code':'old code');
    fs.writeFileSync(path.join(dir,'styles.css'),dir===source?'new css':'old css');
  }
  const data=Buffer.from('{"days":{"2026-11-12":{"characters":1234}},"settings":{"tracking":true}}\n');
  fs.writeFileSync(path.join(target,'data.json'),data);
  // Even if a stale/generated data file is accidentally packaged, ignore it.
  fs.writeFileSync(path.join(source,'data.json'),'{}');
  const run=(...flags)=>JSON.parse(execFileSync('python3',['-B',script,'--source',source,'--target',target,...flags],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  return {root,source,config,target,data,run};
}
test('update preview does not touch runtime or data files',t=>{
  const f=fixture(t);assert.equal(f.run().applied,false);
  assert.equal(fs.readFileSync(path.join(f.target,'main.js'),'utf8'),'old code');
  assert.ok(fs.readFileSync(path.join(f.target,'data.json')).equals(f.data));
  assert.equal(fs.existsSync(path.join(f.config,'algorithm-workbench-backups')),false);
});
test('update replaces only runtime files, preserving data byte-for-byte and backing it up separately',t=>{
  const f=fixture(t);const result=f.run('--apply');
  assert.equal(result.applied,true);assert.equal(fs.readFileSync(path.join(f.target,'main.js'),'utf8'),'new code');
  assert.ok(fs.readFileSync(path.join(f.target,'data.json')).equals(f.data));
  assert.ok(fs.readFileSync(path.join(result.backup,'data.json')).equals(f.data));
  assert.equal(fs.readFileSync(path.join(result.backup,'main.js'),'utf8'),'old code');
  assert.ok(!result.backup.startsWith(f.target+path.sep));
});
test('enabled plugin and incompatible package abort before any runtime change',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.config,'community-plugins.json'),'["algorithm-workbench"]');
  assert.throws(()=>f.run('--apply'));assert.equal(fs.readFileSync(path.join(f.target,'main.js'),'utf8'),'old code');
  fs.writeFileSync(path.join(f.config,'community-plugins.json'),'[]');
  fs.writeFileSync(path.join(f.source,'manifest.json'),'{"id":"different-plugin"}');
  assert.throws(()=>f.run('--apply'));assert.ok(fs.readFileSync(path.join(f.target,'data.json')).equals(f.data));
});
test('partial write failure rolls runtime back without modifying user statistics',t=>{
  const f=fixture(t);
  const code=`import importlib.util,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1]).parent))\nspec=importlib.util.spec_from_file_location('installer',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\noriginal=m.atomic_write\nfailed=False\ndef injected(path,content):\n global failed\n if path.name=='styles.css' and not failed:\n  failed=True\n  raise OSError('simulated disk error')\n return original(path,content)\nm.atomic_write=injected\ntry:\n m.install(Path(sys.argv[2]),Path(sys.argv[3]),True)\nexcept OSError:\n pass\nelse:\n raise AssertionError('expected failure')\n`;
  execFileSync('python3',['-B','-c',code,script,f.source,f.target],{stdio:['ignore','pipe','pipe']});
  assert.equal(fs.readFileSync(path.join(f.target,'main.js'),'utf8'),'old code');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'manifest.json'))).version,'0.0.1');
  assert.ok(fs.readFileSync(path.join(f.target,'data.json')).equals(f.data));
});

for(const kind of ['plugin','plugins-parent','backup','source-file','data-file','config-file','dangling-backup'])
test(`installer rejects ${kind} symlinks before backup or runtime changes`,t=>{
  const f=fixture(t),outside=path.join(f.root,'external');fs.mkdirSync(outside);
  const old=fs.readFileSync(path.join(f.target,'main.js'));
  let physical=f.target;
  if(kind==='plugin'){
    physical=path.join(outside,'plugins','algorithm-workbench');fs.mkdirSync(path.dirname(physical));
    fs.renameSync(f.target,physical);fs.symlinkSync(physical,f.target,'dir');
    fs.writeFileSync(path.join(f.config,'community-plugins.json'),'["algorithm-workbench"]');
  }else if(kind==='plugins-parent'){
    const parent=path.dirname(f.target),replacement=path.join(outside,'plugins');
    fs.renameSync(parent,replacement);fs.symlinkSync(replacement,parent,'dir');physical=path.join(replacement,'algorithm-workbench');
  }else if(kind==='backup'||kind==='dangling-backup'){
    fs.symlinkSync(kind==='backup'?outside:path.join(outside,'missing'),path.join(f.config,'algorithm-workbench-backups'),'dir');
  }else{
    const dest=kind==='source-file'?path.join(f.source,'main.js'):kind==='data-file'?path.join(f.target,'data.json'):path.join(f.config,'community-plugins.json');
    fs.rmSync(dest,{force:true});const victim=path.join(outside,'private');fs.writeFileSync(victim,'[]');fs.symlinkSync(victim,dest);
  }
  const externalEntries=fs.readdirSync(outside);
  for(const flags of [[],['--apply']])assert.throws(()=>f.run(...flags),/Symbolic links are not allowed/);
  assert.deepEqual(fs.readFileSync(path.join(physical,'main.js')),old);
  assert.deepEqual(fs.readdirSync(outside),externalEntries);
  if(kind!=='data-file')assert.deepEqual(fs.readFileSync(path.join(physical,'data.json')),f.data);
  if(!kind.includes('backup'))assert.equal(fs.existsSync(path.join(f.config,'algorithm-workbench-backups')),false);
});
