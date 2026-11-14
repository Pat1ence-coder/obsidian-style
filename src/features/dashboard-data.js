'use strict';
// Numbers behind the dashboard's charts. Pure: data in, plain values out.
const Core=require('../core');
const round1=n=>Math.round(n*10)/10;

// Daily score for the last n days with a trailing 7-day mean (earlier days feed the mean).
function trendSeries(data,now,n){
  const days=Core.lastDays(now,n+6),scores=days.map(d=>Core.dayScore(data.days[d]));
  return days.slice(6).map((date,i)=>({date,score:scores[i+6],avg:round1(scores.slice(i,i+7).reduce((a,b)=>a+b,0)/7)}));
}
// A round axis maximum split into four equal, readable steps (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k).
function niceMax(value){
  if(!(value>0))return 4;
  const raw=value/4,p=10**Math.floor(Math.log10(raw));
  return [1,1.5,2,2.5,3,4,5,6,8,10].map(m=>m*p).find(step=>step>=raw-1e-9)*4;
}
// Catmull-Rom through the points as cubic Béziers; control points stay inside [top,bottom]
// so a smooth curve never dips below the zero line.
function smoothPath(points,top,bottom){
  if(!points.length)return '';
  const clamp=y=>round1(Math.min(bottom,Math.max(top,y)));
  let d=`M${round1(points[0].x)},${round1(points[0].y)}`;
  for(let i=0;i<points.length-1;i++){
    const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;
    d+=` C${round1(p1.x+(p2.x-p0.x)/6)},${clamp(p1.y+(p2.y-p0.y)/6)} ${round1(p2.x-(p3.x-p1.x)/6)},${clamp(p2.y-(p3.y-p1.y)/6)} ${round1(p2.x)},${round1(p2.y)}`;
  }
  return d;
}
// Today against the mean of the active days before it within the range.
function todayProgress(data,now,range){
  const today=data.days[Core.dayKey(now)];
  const before=Core.lastDays(Core.shiftDay(now,-1),range).map(d=>data.days[d]).filter(d=>Core.dayScore(d)>0);
  const mean=key=>before.length?round1(before.reduce((sum,d)=>sum+Core.metricValue(d,key),0)/before.length):null;
  return {score:Core.dayScore(today),characters:today?.characters||0,minutes:today?.minutes||0,focus:today?.focus||0,
    notes:today?.notes||0,tasks:today?.tasks||0,avgCharacters:mean('characters'),avgMinutes:mean('minutes')};
}
// The last six months, oldest first, from the monthly rows (newest first).
function monthBars(rows){
  const list=rows.slice(0,6).reverse(),best=Math.max(0,...list.map(r=>r.score));
  return list.map((r,i)=>({month:r.month,score:round1(r.score),active:r.active,ratio:best>0?r.score/best:0,current:i===list.length-1}));
}
module.exports={trendSeries,niceMax,smoothPath,todayProgress,monthBars};
