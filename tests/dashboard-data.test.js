'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../src/core');
const Dash=require('../src/features/dashboard-data');
const now=new Date(2026,10,14,12);
const data=days=>({days:Object.fromEntries(Object.entries(days).map(([k,v])=>[k,{characters:0,...v}]))});
test('trend series ends today and averages the trailing seven days',()=>{
  const d=data({'2026-11-14':{characters:700},'2026-11-08':{characters:700},'2026-11-07':{characters:7000}});
  const s=Dash.trendSeries(d,now,30);
  assert.equal(s.length,30);assert.equal(s.at(-1).date,'2026-11-14');assert.equal(s[0].date,'2026-10-16');
  assert.equal(s.at(-1).score,7);assert.equal(s.at(-1).avg,2);
  assert.equal(s.at(-2).avg,11);
});
test('axis maxima are round and the smooth path stays inside the plot',()=>{
  assert.equal(Dash.niceMax(0),4);assert.equal(Dash.niceMax(12.9),16);assert.equal(Dash.niceMax(37),40);assert.equal(Dash.niceMax(41),60);assert.equal(Dash.niceMax(8),8);
  const pts=[{x:0,y:100},{x:10,y:100},{x:20,y:0},{x:30,y:100}];
  const ys=[...Dash.smoothPath(pts,0,100).matchAll(/,(-?[\d.]+)/g)].map(m=>Number(m[1]));
  assert.ok(ys.every(y=>y>=0&&y<=100));assert.equal(Dash.smoothPath([],0,1),'');
});
test('today progress compares against the mean of earlier active days in range',()=>{
  const d=data({'2026-11-14':{characters:300,minutes:10},'2026-11-13':{characters:200,minutes:20},'2026-11-01':{characters:400,minutes:40},'2026-08-01':{characters:9000}});
  const t=Dash.todayProgress(d,now,30);
  assert.equal(t.characters,300);assert.equal(t.avgCharacters,300);assert.equal(t.avgMinutes,30);assert.equal(t.score,4);
  assert.equal(Dash.todayProgress(data({}),now,30).avgCharacters,null);
});
test('month bars run oldest to newest with the current month last',()=>{
  const rows=Array.from({length:12},(_,i)=>({month:`m${i}`,score:i===1?50:i===0?25:0,active:i}));
  const bars=Dash.monthBars(rows);
  assert.deepEqual(bars.map(b=>b.month),['m5','m4','m3','m2','m1','m0']);
  assert.equal(bars.at(-1).current,true);assert.equal(bars.at(-1).ratio,.5);assert.equal(bars[4].ratio,1);
  assert.ok(Core.dayKey);
});
