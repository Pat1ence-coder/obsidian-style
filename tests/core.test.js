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
  assert.equal(C.loadState(null,new Date(2026,9,12,12)).version,2,'missing data.json (null) starts fresh');
  assert.throws(()=>C.loadState(undefined),/格式/,'unparseable data.json (undefined) must never start fresh');
  assert.throws(()=>C.loadState('corrupt'),/格式/);assert.throws(()=>C.loadState([]),/格式/);
  assert.throws(()=>C.loadState({version:3}));assert.throws(()=>C.loadState({version:2}));
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

test('version 1 data migrates without losing history; activity counters start at migration',()=>{
  const v1={version:1,started:'2026-05-01',settings:{weeks:53,tracking:true},days:{[day]:{characters:12,files:{'a.md':12}}},records:{}};
  const d=C.loadState(v1,new Date(2026,9,12,12));
  assert.equal(d.version,2);assert.equal(d.started,'2026-05-01');assert.equal(d.activityStarted,day);
  assert.equal(d.days[day].characters,12);assert.equal(d.settings.range,90);assert.equal(d.settings.metric,'score');
  const round=C.loadState(JSON.parse(JSON.stringify(d)),new Date(2026,9,12,12));
  assert.equal(round.activityStarted,day);
  assert.throws(()=>C.loadState({...v1,version:2}),/格式/);
  assert.throws(()=>C.loadState({...d,days:{[day]:{characters:0,files:{},minutes:-1}}}),/活动/);
});
test('editing time bridges short pauses; a 25-minute session becomes focus',()=>{
  const d=setup(),s={last:null,span:0},at=m=>new Date(2026,9,12,9,m,30).getTime();
  assert.equal(C.recordActivity(d,s,at(0)),1);
  assert.equal(C.recordActivity(d,s,at(0)),0);
  assert.equal(C.recordActivity(d,s,at(4)),4);
  assert.equal(C.recordActivity(d,s,at(30)),1);
  assert.equal(d.days[day].minutes,6);assert.equal(d.days[day].focus,undefined);
  for(let m=31;m<=54;m++)C.recordActivity(d,s,at(m));
  assert.equal(d.days[day].focus,25);
  C.recordActivity(d,s,at(56));
  assert.equal(d.days[day].focus,27);assert.equal(d.days[day].minutes,32);
});
test('task deltas read only touched lines and re-ticking counts once',()=>{
  const doc=text=>({sliceString:(a,b)=>text.slice(a,b),lineAt:pos=>({from:text.lastIndexOf('\n',pos-1)+1,to:text.indexOf('\n',pos)<0?text.length:text.indexOf('\n',pos)})});
  const tr=(before,after,changes)=>({startState:{doc:doc(before)},newDoc:doc(after),changes:{iterChanges:fn=>changes.forEach(c=>fn(...c))}});
  const a='- [ ] 一\n- [x] 二\n> - [ ] 三',b='- [x] 一\n- [x] 二\n> - [x] 三';
  assert.equal(C.taskDelta(tr(a,b,[[3,4,3,4],[22,23,22,23]])),2);
  assert.equal(C.taskDelta(tr(b,a,[[3,4,3,4]])),-1);
  const d=setup();C.recordChange(d,'t.md',10,10,day);
  assert.equal(C.recordTasks(d,'t.md',1,day),1);
  assert.equal(C.recordTasks(d,'t.md',-1,day),0);
  assert.equal(C.recordTasks(d,'t.md',1,day),0);
  assert.equal(C.recordTasks(d,'t.md',2,day),2);
  assert.equal(d.days[day].tasks,3);
  assert.equal(C.recordTasks(d,'other.md',1,day),0);
});
test('score, summary, streaks and personal quartiles',()=>{
  const d=setup(),now=new Date(2026,9,12,12),key=n=>C.dayKey(C.shiftDay(now,n));
  d.days[key(0)]={characters:300,files:{'a.md':300},minutes:20,focus:0,notes:1,tasks:2};
  d.days[key(-1)]={characters:100,files:{'a.md':100}};
  d.days[key(-3)]={characters:0,files:{},minutes:10};
  assert.equal(C.dayScore(d.days[key(0)]),3+2+2+2);
  const s=C.summary(d,now,30);
  assert.equal(s.active,3);assert.equal(s.longest,2);assert.equal(s.characters,400);assert.equal(s.score,9+1+1);
  assert.equal(C.currentStreak(d,now),2);
  delete d.days[key(0)];assert.equal(C.currentStreak(d,now),1);
  const ranked=C.activeValues([0,8,1,2,3,4,5,6,7]);assert.deepEqual(ranked,[1,2,3,4,5,6,7,8]);
  assert.deepEqual([0,1,2,3,4,6,8].map(v=>C.intensity(v,ranked)),[0,1,1,2,2,3,4]);
  assert.equal(C.intensity(5,[]),4);assert.equal(C.intensity(9,[9]),4);
  assert.equal(C.percentile(8,ranked),100);assert.equal(C.percentile(2,ranked),25);assert.equal(C.percentile(0,ranked),null);
});

test('a palette saved by an older version is dropped on load',()=>{
  const d=setup();assert.equal(d.settings.palette,undefined);assert.equal(C.PALETTES,undefined);
  assert.equal(C.loadState({...JSON.parse(JSON.stringify(d)),settings:{palette:'sand'}},new Date(2026,9,12,12)).settings.palette,undefined);
});

test('caption size and figure tools settings default sensibly and reject bad values',()=>{
  const d=setup();assert.equal(d.settings.captionSize,'normal');assert.equal(d.settings.figureTools,true);
  assert.deepEqual(C.CAPTION_SIZES.map(c=>c.id),['small','normal','large']);
  const load=settings=>C.loadState({...JSON.parse(JSON.stringify(d)),settings},new Date(2026,9,12,12)).settings;
  assert.equal(load({captionSize:'small'}).captionSize,'small');assert.equal(load({captionSize:'tiny'}).captionSize,'normal');
  assert.equal(load({figureTools:false}).figureTools,false);assert.equal(load({figureTools:'no'}).figureTools,true);
});

test('scroll ruler and decoration settings validate; a style saved by an older version is dropped',()=>{
  const d=setup();assert.equal(d.settings.style,undefined);assert.equal(C.STYLES,undefined);assert.equal(d.settings.scrollRuler,true);assert.equal(d.settings.decorImage,'');
  const load=settings=>C.loadState({...JSON.parse(JSON.stringify(d)),settings},new Date(2026,9,12,12)).settings;
  assert.equal(load({style:'card'}).style,undefined);
  assert.equal(load({scrollRuler:false}).scrollRuler,false);assert.equal(load({scrollRuler:1}).scrollRuler,true);
  assert.equal(d.settings.rulerHeadings,true);assert.equal(load({rulerHeadings:false}).rulerHeadings,false);assert.equal(load({rulerHeadings:'off'}).rulerHeadings,true);
  assert.equal(d.settings.rulerHeadingLevels,4);assert.equal(load({rulerHeadingLevels:6}).rulerHeadingLevels,6);assert.equal(load({rulerHeadingLevels:3}).rulerHeadingLevels,3);assert.equal(load({rulerHeadingLevels:9}).rulerHeadingLevels,4);
  assert.equal(load({decorImage:'  /assets/dog.png '}).decorImage,'assets/dog.png');assert.equal(load({decorImage:42}).decorImage,'');
  // The window glass no longer takes a picture: it is on by default and a saved path is dropped.
  assert.equal(d.settings.glass,true);assert.equal(load({glass:false}).glass,false);assert.equal(load({glass:'no'}).glass,true);
  assert.equal(d.settings.pasteSource,true);assert.equal(load({pasteSource:false}).pasteSource,false);assert.equal(load({pasteSource:'x'}).pasteSource,true);
  assert.equal(d.settings.smoothCaret,true);assert.equal(load({smoothCaret:false}).smoothCaret,false);assert.equal(load({smoothCaret:'no'}).smoothCaret,true);
  assert.equal(d.settings.rulerMemory,true);assert.equal(load({rulerMemory:false}).rulerMemory,false);assert.equal(load({rulerMemory:'x'}).rulerMemory,true);
  assert.equal(load({glassImage:'assets/wall.jpg'}).glassImage,undefined);assert.equal(load({glassFog:'strong'}).glassFog,'strong');
});

test('reading position memory loads safely, caps at 200 entries, clears near ends and follows renames',()=>{
  const raw={...JSON.parse(JSON.stringify(setup())),reading:{
    'a/note.md':{p:0.45678,line:12,text:'推导',hp:0.4,at:10},
    'bad.md':{p:1.5,at:20},
    'zero.md':{p:0,at:30}
  }};
  const d=C.loadState(raw,new Date(2026,9,12,12));
  assert.deepEqual({...d.reading},{'a/note.md':{p:0.4568,line:12,text:'推导',hp:0.4,at:10}});
  assert.equal(C.setReading(d.reading,'a/note.md',{p:0.457,line:12,text:'推导',at:15}),false,'tiny scroll delta ignored');
  assert.equal(C.setReading(d.reading,'a/note.md',{p:0.99,at:20}),true,'reaching the end clears memory');
  assert.equal(d.reading['a/note.md'],undefined);
  for(let i=0;i<205;i++)C.setReading(d.reading,`n/${i}.md`,{p:0.5,at:i+1});
  assert.equal(Object.keys(d.reading).length,200);
  assert.equal(d.reading['n/0.md'],undefined);assert.ok(d.reading['n/204.md']);
  C.renamePath(d,'n/204.md','moved/204.md');
  assert.ok(d.reading['moved/204.md']);assert.equal(d.reading['n/204.md'],undefined);
});

test('dailyGoal and statusBar settings validate, and same-day empty new notes retract on delete',()=>{
  const d=setup();
  assert.equal(d.settings.dailyGoal,0);assert.equal(d.settings.statusBar,true);
  const load=settings=>C.loadState({...JSON.parse(JSON.stringify(d)),settings},new Date(2026,9,12,12)).settings;
  assert.equal(load({dailyGoal:1500}).dailyGoal,1500);
  assert.equal(load({dailyGoal:-5}).dailyGoal,0);
  assert.equal(load({dailyGoal:999999}).dailyGoal,C.MAX_DAILY_GOAL);
  assert.equal(load({statusBar:false}).statusBar,false);
  // Empty new note created and deleted on the same day retracts +1 note; written new note keeps its count.
  C.recordNote(d,day,'empty.md');
  C.recordNote(d,day,'written.md');
  C.recordChange(d,'written.md',0,50,day);
  assert.equal(d.days[day].notes,2);
  assert.equal(C.retractEmptyNewNote(d,'empty.md',day),true);
  assert.equal(d.days[day].notes,1);
  assert.equal(C.retractEmptyNewNote(d,'written.md',day),false,'written note keeps its count');
  assert.equal(d.days[day].notes,1);
});
