'use strict';
// Numbers behind the dashboard's charts and weekly review. Pure: data in, plain values out.
const Core=require('../core');
const round1=n=>Math.round(n*10)/10;
const WEEKDAYS=['周一','周二','周三','周四','周五','周六','周日'];

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
// Today against the mean of the active days before it within the range, plus optional daily goal.
function todayProgress(data,now,range){
  const today=data.days[Core.dayKey(now)];
  const goal=Math.max(0,Number(data.settings?.dailyGoal)||0);
  const before=Core.lastDays(Core.shiftDay(now,-1),range).map(d=>data.days[d]).filter(d=>Core.dayScore(d)>0);
  const mean=key=>before.length?round1(before.reduce((sum,d)=>sum+Core.metricValue(d,key),0)/before.length):null;
  const characters=today?.characters||0;
  return {
    score:Core.dayScore(today),characters,minutes:today?.minutes||0,focus:today?.focus||0,
    notes:today?.notes||0,tasks:today?.tasks||0,avgCharacters:mean('characters'),avgMinutes:mean('minutes'),
    dailyGoal:goal,goalRatio:goal>0?characters/goal:null,goalMet:goal>0&&characters>=goal,
  };
}
// The last six months, oldest first, from the monthly rows (newest first).
function monthBars(rows){
  const list=rows.slice(0,6).reverse(),best=Math.max(0,...list.map(r=>r.score));
  return list.map((r,i)=>({month:r.month,score:round1(r.score),active:r.active,ratio:best>0?r.score/best:0,current:i===list.length-1}));
}

function sumPeriod(data,dates,dailyGoal=0){
  const totals={score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0,goalDays:0};
  for(const date of dates){
    const day=data.days[date],score=Core.dayScore(day);
    for(const {key} of Core.METRICS)totals[key]+=Core.metricValue(day,key);
    if(score>0)totals.active++;
    if(dailyGoal>0&&(day?.characters||0)>=dailyGoal)totals.goalDays++;
  }
  totals.score=round1(totals.score);
  return totals;
}

// Natural Monday–Sunday weekly review (weekOffset = 0 is current week, -1 is previous week, etc.).
// For the current ongoing week, week-over-week comparison uses the same elapsed weekday span so
// Monday morning is compared fairly against last Monday rather than all seven days of last week.
function weeklyReview(data,now=new Date(),weekOffset=0){
  const offset=Math.min(0,Math.trunc(Number(weekOffset)||0));
  const todayKey=Core.dayKey(now),weekday=(now.getDay()+6)%7;
  const thisMonday=Core.shiftDay(now,-weekday);
  const start=Core.shiftDay(thisMonday,offset*7);
  const dates=Array.from({length:7},(_,i)=>Core.dayKey(Core.shiftDay(start,i)));
  const prevDates=Array.from({length:7},(_,i)=>Core.dayKey(Core.shiftDay(start,i-7)));
  const compareLen=offset===0?weekday+1:7;
  const dailyGoal=Math.max(0,Number(data.settings?.dailyGoal)||0);

  const totals=sumPeriod(data,dates.slice(0,compareLen),dailyGoal);
  const prevTotals=sumPeriod(data,prevDates.slice(0,compareLen),dailyGoal);
  const deltas={};
  for(const {key} of Core.METRICS){
    const cur=totals[key],prev=prevTotals[key],diff=key==='score'?round1(cur-prev):cur-prev;
    deltas[key]={diff,pct:prev>0?Math.round((cur-prev)/prev*100):null};
  }

  const days=dates.map((date,i)=>{
    const d=data.days[date];
    return {
      date,weekday:WEEKDAYS[i],future:date>todayKey,isToday:date===todayKey,
      score:Core.dayScore(d),characters:d?.characters||0,minutes:d?.minutes||0,
      focus:d?.focus||0,notes:d?.notes||0,tasks:d?.tasks||0,
      goalMet:dailyGoal>0&&(d?.characters||0)>=dailyGoal,
    };
  });

  const fileMap=new Map(),folderMap=new Map();
  for(const date of dates){
    if(date>todayKey)continue;
    const files=data.days[date]?.files;
    if(!files)continue;
    for(const [path,chars] of Object.entries(files)){
      if(!(chars>0))continue;
      const cur=fileMap.get(path)||{path,name:path.split('/').pop().replace(/\.md$/i,''),folder:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'笔记库根目录',characters:0,days:0};
      cur.characters+=chars;cur.days++;
      fileMap.set(path,cur);
      const fcur=folderMap.get(cur.folder)||{folder:cur.folder,characters:0,notes:new Set()};
      fcur.characters+=chars;fcur.notes.add(path);
      folderMap.set(cur.folder,fcur);
    }
  }
  const topFiles=[...fileMap.values()].sort((a,b)=>b.characters-a.characters||b.days-a.days||a.path.localeCompare(b.path));
  const topFolders=[...folderMap.values()].map(f=>({folder:f.folder,characters:f.characters,noteCount:f.notes.size}))
    .sort((a,b)=>b.characters-a.characters||b.noteCount-a.noteCount||a.folder.localeCompare(b.folder));

  return {
    weekOffset:offset,startDate:dates[0],endDate:dates[6],compareDays:compareLen,dailyGoal,
    totals,prevTotals,deltas,days,topFiles,topFolders,
  };
}

function formatWeeklyMarkdown(review){
  const fmt=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
  const deltaText=(key,unit)=>{
    const d=review.deltas[key];
    if(!d||d.diff===0)return '与上期持平';
    const sign=d.diff>0?'+':'';
    const pct=d.pct===null?'':`，${d.pct>0?'+':''}${d.pct}%`;
    return `较上期${review.compareDays<7?`同期（前 ${review.compareDays} 天）`:''} ${sign}${fmt(d.diff)} ${unit}${pct}`;
  };
  const t=review.totals;
  const lines=[
    `## 写作周报（${review.startDate} 至 ${review.endDate}）`,
    '',
    `- **贡献得分**：${fmt(t.score)} 分（${deltaText('score','分')}）`,
    `- **新增字数**：${fmt(t.characters)} 字（${deltaText('characters','字')}）`,
    `- **编辑 / 专注时长**：${fmt(t.minutes)} 分钟 / ${fmt(t.focus)} 分钟`,
    `- **新建笔记 / 完成任务**：${fmt(t.notes)} 篇 / ${fmt(t.tasks)} 项`,
    `- **活跃天数**：${t.active} / ${review.compareDays} 天${review.dailyGoal>0?`（达标 ${t.goalDays} 天，目标 ${fmt(review.dailyGoal)} 字/天）`:''}`,
  ];
  if(review.topFiles.length){
    lines.push('','### 本周重点笔记','');
    review.topFiles.slice(0,8).forEach((f,i)=>{
      lines.push(`${i+1}. **${f.name}**（\`${f.folder}\`）：+${fmt(f.characters)} 字 · 活跃 ${f.days} 天`);
    });
  }
  if(review.topFolders.length>1){
    lines.push('','### 目录投入分布','');
    for(const f of review.topFolders.slice(0,6)){
      lines.push(`- \`${f.folder}\`：+${fmt(f.characters)} 字（${f.noteCount} 篇笔记）`);
    }
  }
  return lines.join('\n')+'\n';
}

module.exports={trendSeries,niceMax,smoothPath,todayProgress,monthBars,weeklyReview,formatWeeklyMarkdown};
