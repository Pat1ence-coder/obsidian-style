'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../src/core');
const day='2026-10-12';
const setup=()=>C.emptyData(new Date(2026,9,12,12));
test('Chinese, emoji, code and whitespace are counted as non-whitespace code points',()=>{
  assert.equal(C.countCharacters('中文 A\n😀\t'),4);
  assert.equal(C.countCharacters('$x_i$'),5);
});
test('initial document is not backfilled and growth is recorded per file',()=>{
  const d=setup(); assert.equal(C.recordChange(d,'a.md',100,110,day),10);
  assert.equal(C.recordChange(d,'b.md',9000,9001,day),1);
  assert.equal(d.days[day].characters,11);
});
test('undo/redo, deletion and repeated observations never double-count',()=>{
  const d=setup(); C.recordChange(d,'a.md',100,110,day);
  for(const [a,b] of [[110,100],[100,110],[110,110],[110,90],[90,110]]) assert.equal(C.recordChange(d,'a.md',a,b,day),0);
  assert.equal(C.recordChange(d,'a.md',110,115,day),5);
  assert.equal(d.days[day].characters,15);
});
test('new local date starts from the current document length',()=>{
  const d=setup();C.recordChange(d,'a.md',100,110,day);
  C.recordChange(d,'a.md',110,90,day);
  assert.equal(C.recordChange(d,'a.md',90,95,'2026-10-13'),5);
});
test('external changes and pasted existing files do not count as local writing',()=>{
  const d=setup();C.recordChange(d,'a.md',100,110,day);
  C.recordChange(d,'a.md',110,1110,day,false);
  assert.equal(d.days[day].characters,10);
  assert.equal(C.recordChange(d,'a.md',1110,1112,day),2);
  C.recordChange(d,'a.md',1112,20,day,false);
  assert.equal(C.recordChange(d,'a.md',20,23,day),3);
});
test('missed external changes reconcile the baseline without attribution',()=>{
  const d=setup();C.recordChange(d,'a.md',100,110,day);
  assert.equal(C.recordChange(d,'a.md',500,505,day),5);
});
test('restart preserves same-day high-water mark and totals',()=>{
  let d=setup();C.recordChange(d,'a.md',100,120,day);C.recordChange(d,'a.md',120,100,day);
  d=C.loadState(JSON.parse(JSON.stringify(d)),new Date(2026,9,12,12));
  assert.equal(C.recordChange(d,'a.md',100,120,day),0);
  assert.equal(d.days[day].characters,20);
});
test('file and folder renames keep history and ongoing baselines',()=>{
  const d=setup();C.recordChange(d,'old/a.md',0,12,day);C.recordChange(d,'old/sub/b.md',0,3,day);
  C.renamePath(d,'old','new');assert.equal(d.days[day].files['new/a.md'],12);
  assert.equal(d.days[day].files['new/sub/b.md'],3);assert.equal(d.records['old/a.md'],undefined);
  C.renamePath(d,'new/a.md','new/c.md');assert.equal(C.recordChange(d,'new/c.md',12,14,day),2);
  assert.equal(d.days[day].characters,17);
});
test('recent list filters exact folders, sorts newest first and limits',()=>{
  const files=['Templates/a.md','Templates2/b.md','a.md','b.md'].map((path,i)=>({path,stat:{mtime:i}}));
  assert.deepEqual(C.recentFiles(files,{excludedFolders:['Templates'],recentLimit:3}).map(f=>f.path),['b.md','a.md','Templates2/b.md']);
});
test('calendar is Monday-first, includes today, crosses years and leap day',()=>{
  const days=C.calendarDays(new Date(2026,0,1,12),27);
  assert.equal(days.length,189);assert.equal(new Date(days[0]+'T12:00:00').getDay(),1);assert.ok(days.includes('2026-01-01'));
  assert.ok(C.calendarDays(new Date(2024,2,1,12),27).includes('2024-02-29'));
  assert.equal(new Set(days).size,days.length);
});
test('corrupt/newer data is rejected rather than silently overwritten',()=>{
  assert.throws(()=>C.loadState({version:2}));
  const d=setup();d.days[day]={characters:3,files:{'a.md':4}};assert.throws(()=>C.loadState(d));
});
test('special path keys are safe',()=>{
  const d=setup(); C.recordChange(d,'__proto__',0,2,day);C.recordChange(d,'constructor',0,1,day);
  const restored=C.loadState(JSON.parse(JSON.stringify(d)),new Date(2026,9,12));
  assert.equal(restored.days[day].files['__proto__'],2);
});

test('daily baseline cleanup keeps historical contributions intact',()=>{
  const d=setup();C.recordChange(d,'yesterday.md',0,10,'2026-10-11');C.recordChange(d,'today.md',0,3,day);
  assert.equal(C.pruneRecords(d,day),true);
  assert.deepEqual(Object.keys(d.records),['today.md']);
  assert.equal(d.days['2026-10-11'].characters,10);
  assert.equal(C.pruneRecords(d,day),false);
});
test('incremental counter handles disjoint changes and edits through surrogate pairs',()=>{
  const doc=text=>({length:text.length,toString:()=>text,sliceString:(a,b)=>text.slice(a,b)});
  const cases=[
    ['A😀B','A😃B',[[2,3,2,3,'\ude03']]],
    ['A😀B','A\ud83dB',[[2,3,2,2,'']]],
    ['甲 乙 丙','甲丁 乙 戊',[[1,1,1,2,'丁'],[4,5,5,6,'戊']]],
    ['ab','a😀b',[[1,1,1,3,'😀']]]
  ];
  for(const [before,after,changes] of cases){
    const tr={startState:{doc:doc(before)},newDoc:doc(after),changes:{iterChanges:fn=>changes.forEach(([a,b,c,d,text])=>fn(a,b,c,d,doc(text)))}};
    assert.deepEqual(C.transactionCounts(tr,new WeakMap()),[C.countCharacters(before),C.countCharacters(after)]);
  }
});
