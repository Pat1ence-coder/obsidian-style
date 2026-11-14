'use strict';
const {ItemView,Menu,Notice,TFile,setIcon}=require('obsidian');
const Core=require('../core');
const Dash=require('./dashboard-data');
const VIEW='algorithm-workbench';
const WEEKS=53;
const number=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
const hours=minutes=>number(Math.round(minutes/6)/10);
const clockFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateFormat=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric'});
const fullDateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric'});
const TABS=[['board','看板视图'],['recent','最近笔记'],['monthly','月度汇总']];
const metricOf=key=>Core.METRICS.find(m=>m.key===key)||Core.METRICS[0];
// One companion hue per metric; cards, dots, tabs and the heatmap ramp all follow it.
const HUES={score:'tone-accent',characters:'tone-4',minutes:'tone-2',focus:'tone-3',notes:'tone-1',tasks:'tone-5'};
const tint=(node,hue)=>{node.style.setProperty('--aw-hue',`var(--ds-${hue})`);return node;};
function el(parent,tag,cls,text){
  const node=parent.ownerDocument.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  parent.appendChild(node);return node;
}
function button(parent,text,cls,fn){
  const node=el(parent,'button',cls,text);node.type='button';node.addEventListener('click',fn);return node;
}
function icon(parent,name,cls='aw-icon'){
  const node=el(parent,'span',cls);node.setAttribute('aria-hidden','true');setIcon(node,name);return node;
}
// Every module shares one header: icon tile, title, dotted subtitle and a pill badge.
function card(parent,{name,iconName,title,sub,badge,hue='tone-accent'}){
  const section=tint(el(parent,'section',`aw-card aw-card-${name}`),hue);
  const head=el(section,'header','aw-card-head');
  icon(head,iconName,'aw-card-icon');
  const copy=el(head,'div','aw-card-copy');el(copy,'h2','aw-card-title',title);
  const subtitle=el(copy,'p','aw-card-sub',sub);
  const pill=el(head,'span','aw-badge',badge);
  return {section,subtitle,pill,body:el(section,'div','aw-panel')};
}
function stat(parent,label,value,unit,cls='',hue){
  const item=el(parent,'div','aw-stat'+(cls?' '+cls:''));
  if(hue)tint(item,hue);
  const caption=el(item,'span','aw-stat-label');
  if(hue)tint(el(caption,'i','aw-dot'),hue).setAttribute('aria-hidden','true');
  el(caption,'span','',label);
  const line=el(item,'div','aw-stat-value');const strong=el(line,'strong','',value);el(line,'span','aw-unit',unit);
  return strong;
}
const SVG='http://www.w3.org/2000/svg';
function svg(parent,tag,attrs={},text){
  const doc=parent.ownerDocument,node=doc.createElementNS?doc.createElementNS(SVG,tag):doc.createElement(tag);
  for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));
  if(text!==undefined)node.textContent=text;
  parent.appendChild(node);return node;
}
const shortDate=key=>`${Number(key.slice(5,7))}/${Number(key.slice(8))}`;
function folderLabel(file){return file.parent?.path&&file.parent.path!=='/'?file.parent.path:'笔记库';}
function modifiedLabel(mtime,now=new Date()){
  const date=new Date(mtime),day=Core.dayKey(date);
  if(day===Core.dayKey(now))return `今天 ${clockFormat.format(date)}`;
  if(day===Core.dayKey(Core.shiftDay(now,-1)))return '昨天';
  return date.getFullYear()===now.getFullYear()?dateFormat.format(date):`${date.getFullYear()}年${dateFormat.format(date)}`;
}
function overview(data,now=new Date()){
  const s=Core.summary(data,now,data.settings.range);
  return {score:number(s.score),characters:number(s.characters),active:number(s.active),
    streak:number(Core.currentStreak(data,now)),minutes:hours(s.minutes),focus:hours(s.focus),longest:s.longest};
}
function csv(data){
  const rows=[['日期','贡献分','新增字数','编辑分钟','专注分钟','新建笔记','完成任务']];
  for(const date of Object.keys(data.days).sort()){
    const day=data.days[date];rows.push([date,Core.dayScore(day),...Core.METRICS.slice(1).map(m=>Core.metricValue(day,m.key))]);
  }
  return '\ufeff'+rows.map(r=>r.join(',')).join('\n')+'\n';
}
function months(data,now=new Date()){
  const list=[];
  for(let i=11;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);list.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);}
  const rows=new Map(list.map(m=>[m,{month:m,score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0}]));
  for(const [date,day] of Object.entries(data.days)){
    const row=rows.get(date.slice(0,7));if(!row)continue;
    for(const {key} of Core.METRICS)row[key]+=Core.metricValue(day,key);
    if(Core.dayScore(day)>0)row.active++;
  }
  return [...rows.values()].reverse();
}

class WorkbenchView extends ItemView{
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.selectedDate=Core.dayKey();this.tab='board';this.creatingNote=false;}
  getViewType(){return VIEW;}
  getDisplayText(){return '知识脉冲';}
  getIcon(){return 'activity';}
  async onOpen(){this.render();}
  async onClose(){
    this.contentEl.replaceChildren();this.dayEl=null;this.recentEl=null;
    this.heatCells=null;this.statNumbers=null;this.longestEl=null;this.liveParts=[];this.renderStamp=null;this.recentStamp=null;this.dayStamp=null;
  }
  stamp(){return [Core.dayKey(),JSON.stringify(this.plugin.data.settings),this.plugin.saveError,this.plugin.folderNotes?.getFolder()?.path??'',this.tab].join('|');}
  daySignature(){
    const day=this.plugin.data.days[this.selectedDate],records=day?.files||{};
    return this.selectedDate+'|'+JSON.stringify(day||null)+'|'+(this.ranked||[]).join()+'|'+JSON.stringify(Object.keys(records).map(path=>this.app.vault.getAbstractFileByPath(path) instanceof TFile));
  }
  refresh(){
    if(this.contentEl.getClientRects().length===0)return;
    if(this.renderStamp!==this.stamp()||this.tab==='monthly'){this.render();return;}
    if(this.statNumbers){
      const values=overview(this.plugin.data);
      for(const [key,node] of this.statNumbers)if(node.textContent!==values[key])node.textContent=values[key];
      if(this.longestEl)this.longestEl.textContent=`最长连续 ${values.longest} 天`;
    }
    for(const part of this.liveParts||[]){const key=part.key();if(key!==part.stamp){part.stamp=key;part.draw();}}
    if(this.heatCells)this.paintHeat();
    const files=Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings);
    if(this.recentEl&&this.recentStamp!==JSON.stringify(files.map(f=>[f.path,f.stat.mtime])))this.renderRecent(files);
    if(this.dayEl&&this.dayStamp!==this.daySignature())this.renderDay();
  }
  render(){
    const active=this.contentEl.ownerDocument.activeElement;
    const focusDate=active?.dataset?.awDate,focusKey=active?.dataset?.awFocus;
    const scrollTop=this.contentEl.scrollTop;
    const helpOpen=this.contentEl.querySelector('.aw-help')?.open||false;
    const heatScroll=this.contentEl.querySelector('.aw-heat-scroll')?.scrollLeft;
    this.contentEl.replaceChildren();this.contentEl.classList.add('aw-view');
    this.statNumbers=null;this.longestEl=null;this.heatCells=null;this.dayEl=null;this.recentEl=null;this.liveParts=[];
    const data=this.plugin.data,settings=data.settings;
    const root=el(this.contentEl,'div','aw-page');
    // The banner, blurred and enlarged, lights the glass cards from behind.
    el(root,'div','aw-ambient').setAttribute('aria-hidden','true');
    this.renderHero(root);
    if(!settings.tracking)el(root,'p','aw-notice','活动统计已暂停，可在插件设置中恢复。');
    if(this.plugin.saveError)el(root,'p','aw-notice','统计暂未保存成功，请检查磁盘空间或权限；插件会重试。').setAttribute('role','status');
    // The glass style lays the board out as a bento grid with its own chart modules.
    const bento=this.tab==='board'&&settings.style==='glass';
    const stack=el(root,'div',bento?'aw-bento':'aw-stack');
    let heatWrap=null;
    if(bento){
      this.renderKpis(stack);this.renderToday(stack);this.renderTrend(stack);
      heatWrap=this.renderPulse(stack);
      this.dayEl=el(stack,'div','aw-day-slot');this.renderDay();
      this.renderMonths(stack);this.renderRecentCard(stack,Math.min(settings.recentLimit,5));
    }else if(this.tab==='board'){
      this.renderOverview(stack);heatWrap=this.renderPulse(stack);
      this.dayEl=el(stack,'div','aw-day-slot');this.renderDay();
      this.renderRecentCard(stack,Math.min(settings.recentLimit,5));
    }else if(this.tab==='recent')this.renderRecentCard(stack,settings.recentLimit);
    else this.renderMonthly(stack);
    const footer=el(root,'footer','aw-footer');
    const local=el(footer,'span','aw-local');icon(local,'hard-drive');el(local,'span','',settings.tracking?'仅保存在本地':'本地记录 · 已暂停');
    const help=el(footer,'details','aw-help');help.open=helpOpen;el(help,'summary','','如何统计？');
    el(help,'p','','新增字数：本机编辑器内新增的非空白字符，含公式、代码和粘贴内容，删除后恢复不重复计数。编辑时长：有输入的分钟，以及其间不超过 5 分钟的停顿。深度专注：连续编辑达到 25 分钟的时段。新建笔记：Obsidian 中新建的 Markdown 文件。完成任务：编辑器里新勾选的任务，反复勾选只算一次。');
    el(help,'p','','贡献分 = 新增字数 ÷ 100 + 编辑分钟 ÷ 10 + 专注分钟 ÷ 10 + 新建笔记 × 2 + 完成任务。热力图强度按所选时间范围内活跃日的四分位数分级。');
    this.renderStamp=this.stamp();this.contentEl.scrollTop=scrollTop;
    if(heatWrap)heatWrap.scrollLeft=heatScroll??heatWrap.scrollWidth;
    if(focusDate)this.heatCells?.get(focusDate)?.focus({preventScroll:true});
    else if(focusKey)this.contentEl.querySelector(`[data-aw-focus="${focusKey}"]`)?.focus({preventScroll:true});
  }
  renderHero(root){
    const settings=this.plugin.data.settings;
    const hero=el(root,'header','aw-hero');el(hero,'div','aw-backdrop').setAttribute('aria-hidden','true');
    const bar=el(hero,'div','aw-hero-bar'),brand=el(bar,'div','aw-brand');
    icon(brand,'activity','aw-brand-mark');el(brand,'h1','aw-title','知识脉冲看板');
    const tabs=el(bar,'nav','aw-tabs');tabs.setAttribute('aria-label','视图');
    for(const [key,label] of TABS){
      const tab=button(tabs,label,'aw-tab',()=>{if(this.tab!==key){this.tab=key;this.render();}});
      tab.dataset.awFocus='tab-'+key;tab.setAttribute('aria-pressed',String(this.tab===key));
    }
    const tools=el(hero,'div','aw-toolbar');
    const range=button(tools,'','aw-chip',event=>this.chooseRange(event));range.dataset.awFocus='range';
    el(range,'span','aw-chip-key','时间:');el(range,'span','',`最近 ${settings.range} 天`);icon(range,'chevron-down','aw-chip-icon');
    el(tools,'span','aw-chip aw-chip-static',settings.tracking?'范围: 本机记录':'范围: 统计已暂停');
    const palette=button(tools,'','aw-chip aw-palette',event=>this.choosePalette(event));palette.dataset.awFocus='palette';
    el(palette,'span','aw-chip-key','配色:');el(palette,'span','',(Core.PALETTES.find(p=>p.id===settings.palette)||Core.PALETTES[0]).label);
    icon(palette,'chevron-down','aw-chip-icon');
    const style=button(tools,'','aw-chip aw-style',event=>this.chooseStyle(event));style.dataset.awFocus='style';
    el(style,'span','aw-chip-key','风格:');el(style,'span','',(Core.STYLES.find(x=>x.id===settings.style)||Core.STYLES[0]).label);
    icon(style,'chevron-down','aw-chip-icon');
    const create=button(tools,'','aw-chip aw-new-note',()=>this.newNote());icon(create,'plus','aw-chip-icon');el(create,'span','','新建笔记');
    const folder=this.plugin.folderNotes?.getFolder();
    create.title=folder?`在 ${folder.path==='/'?'笔记库根目录':folder.path} 中新建`:'按 Obsidian 当前的新建笔记设置创建';
    button(tools,'导出全量 CSV','aw-chip aw-export',()=>this.exportCSV());
    const refresh=button(tools,'刷新','aw-chip aw-refresh',()=>this.render());refresh.setAttribute('aria-label','刷新看板');
  }
  chooseRange(event){
    const settings=this.plugin.data.settings;
    const choose=value=>{if(settings.range===value)return;settings.range=value;this.plugin.changed();this.render();};
    if(typeof Menu!=='function'){choose(Core.RANGES[(Core.RANGES.indexOf(settings.range)+1)%Core.RANGES.length]);return;}
    const menu=new Menu();
    for(const value of Core.RANGES)menu.addItem(item=>item.setTitle(`最近 ${value} 天`).setChecked(settings.range===value).onClick(()=>choose(value)));
    menu.showAtMouseEvent(event);
  }
  choosePalette(event){
    const current=this.plugin.data.settings.palette,choose=id=>{if(id!==current)this.plugin.setPalette(id);};
    if(typeof Menu!=='function'){choose(Core.PALETTES[(Core.PALETTES.findIndex(p=>p.id===current)+1)%Core.PALETTES.length].id);return;}
    const menu=new Menu();
    for(const p of Core.PALETTES)menu.addItem(item=>item.setTitle(p.label).setChecked(p.id===current).onClick(()=>choose(p.id)));
    menu.showAtMouseEvent(event);
  }
  chooseStyle(event){
    const current=this.plugin.data.settings.style,choose=id=>{if(id!==current)this.plugin.setStyle(id);};
    if(typeof Menu!=='function'){choose(Core.STYLES[(Core.STYLES.findIndex(x=>x.id===current)+1)%Core.STYLES.length].id);return;}
    const menu=new Menu();
    for(const x of Core.STYLES)menu.addItem(item=>item.setTitle(x.label).setChecked(x.id===current).onClick(()=>choose(x.id)));
    menu.showAtMouseEvent(event);
  }
  renderOverview(stack){
    const data=this.plugin.data,values=overview(data);
    const c=card(stack,{name:'overview',iconName:'activity',title:'知识脉冲概览',sub:`最近 ${data.settings.range} 天 · 本机记录`,badge:`最长连续 ${values.longest} 天`,hue:'tone-accent'});
    this.longestEl=c.pill;
    const row=el(c.body,'div','aw-stats');this.statNumbers=new Map();
    for(const [key,label,unit,cls] of [['score','累计贡献分','分'],['characters','新增字数','字'],['active','活跃天数','天'],['streak','当前连续','天','aw-stat-accent'],['minutes','编辑时长','小时'],['focus','深度专注','小时']])
      this.statNumbers.set(key,stat(row,label,values[key],unit,cls,HUES[key]));
  }
  // A part that redraws itself on refresh() whenever its data key changes.
  live(key,draw){const part={key,stamp:key(),draw};this.liveParts.push(part);draw();return part;}
  renderKpis(stack){
    const data=this.plugin.data,values=overview(data);this.statNumbers=new Map();
    const kpis=[
      {key:'score',label:'累计贡献分',unit:'分',iconName:'sparkles',badge:`近 ${data.settings.range} 天`,foot:['active','活跃天数','天']},
      {key:'characters',label:'新增字数',unit:'字',iconName:'pen-line',badge:`最长连续 ${values.longest} 天`,foot:['streak','当前连续','天'],longest:true},
      {key:'minutes',label:'编辑时长',unit:'小时',iconName:'clock',badge:'本机记录',foot:['focus','深度专注','小时']},
    ];
    for(const k of kpis){
      const box=tint(el(stack,'section',`aw-kpi aw-kpi-${k.key}`),HUES[k.key]);
      el(box,'i','aw-kpi-glow').setAttribute('aria-hidden','true');
      const head=el(box,'header','aw-kpi-head');icon(head,k.iconName,'aw-kpi-icon');el(head,'h2','aw-kpi-label',k.label);
      const pill=el(head,'span','aw-badge',k.badge);if(k.longest)this.longestEl=pill;
      const line=el(box,'div','aw-kpi-value');this.statNumbers.set(k.key,el(line,'strong','',values[k.key]));el(line,'span','aw-unit',k.unit);
      const [fk,fl,fu]=k.foot,foot=el(box,'div','aw-kpi-foot');
      el(foot,'span','',fl);this.statNumbers.set(fk,el(foot,'strong','',values[fk]));el(foot,'span','',fu);
    }
  }
  renderToday(stack){
    const c=card(stack,{name:'today',iconName:'sun',title:'今日进度',sub:`${dateFormat.format(new Date())} · 对比近期日均`,badge:'',hue:'tone-accent'});
    const box=el(c.body,'div','aw-today'),range=this.plugin.data.settings.range;
    const read=()=>Dash.todayProgress(this.plugin.data,new Date(),range);
    this.live(()=>JSON.stringify(read()),()=>{
      const t=read();c.pill.textContent=`${number(t.score)} 分`;box.replaceChildren();
      for(const [key,label,value,avg,unit] of [['characters','新增字数',t.characters,t.avgCharacters,'字'],['minutes','编辑时长',t.minutes,t.avgMinutes,'分钟']]){
        const row=tint(el(box,'div','aw-progress-row'),HUES[key]),top=el(row,'div','aw-progress-top');
        el(top,'span','aw-progress-label',label);
        const v=el(top,'span','aw-progress-value');el(v,'strong','',number(value));el(v,'span','aw-unit',unit);
        const ratio=avg?value/avg:0,bar=el(row,'div','aw-progress');bar.setAttribute('role','presentation');
        el(bar,'i').style.setProperty('--aw-progress',String(Math.min(1,ratio)));
        el(row,'div','aw-progress-note',avg?`日均 ${number(avg)} ${unit} · ${Math.round(ratio*100)}%`:'近期还没有可对比的活跃日');
      }
      const foot=el(box,'div','aw-today-foot');
      for(const [label,value,unit] of [['专注',t.focus,'分钟'],['新建',t.notes,'篇'],['任务',t.tasks,'项']]){
        const item=el(foot,'span','aw-today-item');el(item,'span','',label);el(item,'strong','',number(value));el(item,'span','',unit);
      }
    });
    const create=button(c.body,'','aw-primary',()=>this.newNote());create.dataset.awFocus='today-new';
    icon(create,'plus','aw-chip-icon');el(create,'span','','新建笔记');
  }
  renderTrend(stack){
    const range=this.plugin.data.settings.range,n=range<=30?30:90;
    const c=card(stack,{name:'trend',iconName:'trending-up',title:'活跃趋势',sub:`最近 ${n} 天 · 每日贡献分与 7 日均线`,badge:'',hue:HUES.score});
    const legend=el(c.body,'div','aw-chart-legend');
    for(const [cls,text] of [['aw-key-bar','每日贡献分'],['aw-key-line','7 日均线']]){
      const key=el(legend,'span','aw-key');el(key,'i',cls).setAttribute('aria-hidden','true');el(key,'span','',text);
    }
    const plot=el(c.body,'div','aw-trend-plot');
    const read=()=>Dash.trendSeries(this.plugin.data,new Date(),n);
    this.live(()=>JSON.stringify(read()),()=>{plot.replaceChildren();this.drawTrend(plot,read(),c.pill);});
  }
  drawTrend(plot,series,pill){
    const W=640,H=220,L=34,R=10,T=16,B=192,n=series.length,step=(W-L-R)/(n-1);
    const peak=series.reduce((best,d)=>d.score>best.score?d:best,series[0]);
    const max=Dash.niceMax(Math.max(peak.score,...series.map(d=>d.avg)));
    const x=i=>L+i*step,y=v=>B-v/max*(B-T);
    pill.textContent=peak.score>0?`峰值 ${number(peak.score)} 分`:'暂无活动';
    const chart=svg(plot,'svg',{class:'aw-trend',viewBox:`0 0 ${W} ${H}`,role:'img',
      'aria-label':`最近 ${n} 天每日贡献分，峰值 ${number(peak.score)} 分（${peak.date}），今天 ${number(series[n-1].score)} 分`});
    const grid=svg(chart,'g',{class:'aw-trend-grid'});
    for(let k=0;k<=4;k++){const v=max*k/4,yy=y(v);svg(grid,'line',{x1:L,x2:W-R,y1:yy,y2:yy});svg(grid,'text',{x:L-8,y:yy+4,'text-anchor':'end'},number(v));}
    const every=Math.ceil(n/6);
    for(let i=n-1;i>=0;i-=every){if(x(i)<L+18)break;svg(grid,'text',{x:x(i),y:H-8,'text-anchor':i===n-1?'end':'middle'},i===n-1?'今天':shortDate(series[i].date));}
    // Daily values as thin columns; the 7-day mean is the smooth line that carries the trend.
    const bars=svg(chart,'g',{class:'aw-trend-bars'}),bw=Math.max(1.5,Math.min(8,step-2));
    series.forEach((d,i)=>{if(d.score>0)svg(bars,'rect',{x:x(i)-bw/2,y:y(d.score),width:bw,height:B-y(d.score),rx:Math.min(2,bw/2)});});
    const line=Dash.smoothPath(series.map((d,i)=>({x:x(i),y:y(d.avg)})),T,B);
    svg(chart,'path',{class:'aw-trend-area',d:`${line} L${x(n-1)},${B} L${L},${B} Z`});
    svg(chart,'path',{class:'aw-trend-line',d:line});
    if(peak.score>0){
      const i=series.indexOf(peak),px=x(i),py=y(peak.score);
      svg(chart,'circle',{class:'aw-trend-peak',cx:px,cy:py-4,r:3});
      svg(chart,'text',{class:'aw-trend-peak-label',x:Math.min(W-R,Math.max(L,px)),y:Math.max(12,py-12),'text-anchor':px>W-60?'end':px<L+40?'start':'middle'},`峰值 ${number(peak.score)}`);
    }
    // Hover: a crosshair per day plus one HTML tooltip.
    const hits=svg(chart,'g',{class:'aw-trend-hits'});
    const tip=el(plot,'div','aw-tip');tip.setAttribute('aria-hidden','true');
    series.forEach((d,i)=>{
      const g=svg(hits,'g',{class:'aw-trend-hit'});
      svg(g,'rect',{x:x(i)-step/2,y:T,width:step,height:B-T,'data-aw-index':i});
      svg(g,'line',{x1:x(i),x2:x(i),y1:T,y2:B});svg(g,'circle',{cx:x(i),cy:y(d.avg),r:4.5});
    });
    hits.addEventListener('pointerover',event=>{
      const i=Number(event.target.getAttribute?.('data-aw-index'));if(!Number.isInteger(i))return;
      const d=series[i];tip.replaceChildren();
      el(tip,'span','aw-tip-date',d.date);
      const a=el(tip,'span','aw-tip-row');el(a,'i','aw-key-bar');el(a,'span','',`贡献分 ${number(d.score)}`);
      const b=el(tip,'span','aw-tip-row');el(b,'i','aw-key-line');el(b,'span','',`7 日均 ${number(d.avg)}`);
      tip.style.setProperty('--aw-x',String(x(i)/W));tip.classList.add('is-shown');
    });
    hits.addEventListener('pointerleave',()=>tip.classList.remove('is-shown'));
  }
  renderMonths(stack){
    const c=card(stack,{name:'months',iconName:'calendar-range',title:'月度贡献',sub:'最近 6 个月 · 贡献分',badge:'',hue:HUES.score});
    const read=()=>Dash.monthBars(months(this.plugin.data));
    this.live(()=>JSON.stringify(read()),()=>{
      const bars=read(),current=bars[bars.length-1];c.body.replaceChildren();
      c.pill.textContent=`本月 ${current.active} 天活跃`;
      const chart=el(c.body,'div','aw-bars');chart.setAttribute('role','list');
      for(const b of bars){
        const label=`${b.month.slice(0,4)}年${Number(b.month.slice(5))}月 · 贡献分 ${number(b.score)} · 活跃 ${b.active} 天`;
        const col=el(chart,'div','aw-bar-col'+(b.current?' is-current':''));col.setAttribute('role','listitem');col.title=label;col.setAttribute('aria-label',label);
        el(col,'span','aw-bar-value',number(b.score));
        const track=el(col,'div','aw-bar-track');el(track,'i','aw-bar-fill'+(b.score>0?'':' is-empty')).style.setProperty('--aw-bar',String(b.ratio));
        el(col,'span','aw-bar-label',`${Number(b.month.slice(5))}月`);
      }
      const total=bars.reduce((s,b)=>s+b.score,0),active=bars.reduce((s,b)=>s+b.active,0);
      el(c.body,'p','aw-bars-note',`6 个月合计 ${number(Math.round(total*10)/10)} 分 · ${active} 天活跃`);
    });
  }
  renderPulse(stack){
    const data=this.plugin.data,settings=data.settings,metric=metricOf(settings.metric);
    const c=card(stack,{name:'pulse',iconName:'calendar-days',title:'年度知识活跃脉冲',sub:`${metric.label} · 强度按个人近期分位数`,badge:'',hue:HUES[metric.key]});
    this.activeEl=c.pill;
    const tabs=el(c.body,'div','aw-segment');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','热力图指标');
    for(const m of Core.METRICS){
      const tab=tint(button(tabs,'','aw-segment-item',()=>{if(settings.metric===m.key)return;settings.metric=m.key;this.plugin.changed();this.render();}),HUES[m.key]);
      el(tab,'i','aw-dot').setAttribute('aria-hidden','true');el(tab,'span','',m.label);
      tab.dataset.awFocus='metric-'+m.key;tab.setAttribute('aria-pressed',String(settings.metric===m.key));
    }
    const heatWrap=el(c.body,'div','aw-heat-scroll'),heat=el(heatWrap,'div','aw-heatmap');heat.style.setProperty('--aw-weeks',String(WEEKS));
    const grid=el(heat,'div','aw-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label','活跃日历，方向键移动，回车选择日期');
    const days=Core.calendarDays(new Date(),WEEKS),today=Core.dayKey();let previousMonth='';
    this.heatCells=new Map();this.calendar=days;
    for(let week=0;week<WEEKS;week++){
      const column=el(grid,'div','aw-week'),month=days[week*7].slice(0,7);
      el(column,'span','aw-month',month!==previousMonth?`${Number(month.slice(5))}月`:'');previousMonth=month;
      for(let row=0;row<7;row++){
        const date=days[week*7+row];
        const cell=button(column,'','aw-cell',()=>{
          this.selectedDate=date;
          for(const [day,node] of this.heatCells){node.setAttribute('aria-pressed',String(day===date));node.tabIndex=day===date?0:-1;}
          this.renderDay();
        });
        cell.dataset.awDate=date;cell.setAttribute('aria-pressed',String(date===this.selectedDate));
        cell.tabIndex=date===(days.includes(this.selectedDate)?this.selectedDate:today)?0:-1;
        cell.disabled=date>today;this.heatCells.set(date,cell);
      }
    }
    grid.addEventListener('keydown',event=>{
      const offset={ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}[event.key];
      if(offset===undefined||!event.target.dataset.awDate)return;
      event.preventDefault();const date=days[days.indexOf(event.target.dataset.awDate)+offset],target=this.heatCells.get(date);
      if(target&&!target.disabled){event.target.tabIndex=-1;target.tabIndex=0;target.focus();}
    });
    const caption=el(c.body,'div','aw-heat-caption');
    el(caption,'span','',`完整 ${WEEKS} 周 · 统计：最近 ${settings.range} 天 · 区间外淡化 · 自 ${metric.key==='characters'?data.started:data.activityStarted} 起记录`);
    const legend=el(caption,'span','aw-legend');el(legend,'span','','少');
    for(let level=0;level<=4;level++)el(legend,'i',`aw-level-${level}`).setAttribute('aria-hidden','true');
    el(legend,'span','','多');
    this.paintHeat();return heatWrap;
  }
  // Recolour in place; personal quartiles move as new activity arrives.
  paintHeat(){
    const data=this.plugin.data,metric=metricOf(data.settings.metric),today=Core.dayKey();
    const windowDays=Core.lastDays(new Date(),data.settings.range),from=windowDays[0];
    const values=windowDays.map(d=>Core.metricValue(data.days[d],metric.key));
    this.ranked=Core.activeValues(values);
    this.activeEl.textContent=`${values.filter(v=>v>0).length} 天活跃`;
    const started=metric.key==='characters'?data.started:data.activityStarted;
    for(const [date,cell] of this.heatCells){
      const value=Core.metricValue(data.days[date],metric.key),future=date>today,untracked=date<started;
      const cls=`aw-cell aw-level-${Core.intensity(value,this.ranked)}${date<from||future?' aw-out':''}${untracked&&!value?' aw-untracked':''}`;
      if(cell.className!==cls)cell.className=cls;
      const label=`${date} · ${future?'未来日期':untracked&&!value?'启用前，无记录':`${metric.label} ${number(value)} ${metric.unit}`}`;
      if(cell.title!==label){cell.title=label;cell.setAttribute('aria-label',label);}
    }
  }
  renderDay(){
    if(!this.dayEl)return;
    this.dayEl.replaceChildren();this.dayStamp=this.daySignature();
    const data=this.plugin.data,day=data.days[this.selectedDate],score=Core.dayScore(day);
    const metric=metricOf(data.settings.metric),value=Core.metricValue(day,metric.key);
    const rank=this.ranked&&this.selectedDate>=Core.lastDays(new Date(),data.settings.range)[0]?Core.percentile(value,this.ranked):null;
    const date=new Date(this.selectedDate+'T12:00:00');
    const sub=rank===null?(this.selectedDate<data.started?'启用之前 · 没有记录':'本机记录'):`本机记录 · ${metric.label}强度第 ${rank}% 分位`;
    const c=card(this.dayEl,{name:'day',iconName:'file-text',title:`${fullDateFormat.format(date)} 明细`,sub,badge:`${number(score)} 分`,hue:'tone-1'});
    c.section.querySelector('.aw-card-title').title=this.selectedDate;
    const row=el(c.body,'div','aw-stats aw-stats-compact');
    stat(row,'贡献得分',number(score),'分','',HUES.score);
    stat(row,'新增字数',number(day?.characters||0),'字','',HUES.characters);
    stat(row,'编辑时长',number(day?.minutes||0),'分钟','',HUES.minutes);
    stat(row,'新建笔记',number(day?.notes||0),'篇','',HUES.notes);
    stat(row,'完成任务',number(day?.tasks||0),'项','',HUES.tasks);
    const entries=Object.entries(day?.files||{}).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){el(c.body,'p','aw-empty',this.selectedDate<data.started?'这一天在启用之前，没有记录。':'这一天没有新增文字。');return;}
    const list=el(c.body,'div','aw-day-list');
    for(const [path,count] of entries){
      const file=this.app.vault.getAbstractFileByPath(path),exists=file instanceof TFile;
      const row=button(list,'','aw-day-row',()=>this.openFile(path));row.disabled=!exists;row.title=exists?path:`${path}（文件已移除）`;
      icon(row,'file-text','aw-row-icon');el(row,'span','aw-day-name',exists?file.basename:path);el(row,'span','aw-day-count',`+${number(count)} 字`);
      row.setAttribute('aria-label',`${exists?file.basename:path}，新增 ${number(count)} 字${exists?'':'，文件已移除'}`);
    }
  }
  renderRecentCard(stack,limit){
    const c=card(stack,{name:'recent',iconName:'history',title:'继续编辑',sub:'按修改时间 · 已排除模板目录',badge:'',hue:'tone-2'});
    this.recentEl=c.body;this.recentPill=c.pill;this.recentLimit=limit;
    this.renderRecent(Core.recentFiles(this.app.vault.getMarkdownFiles(),this.plugin.data.settings));
  }
  renderRecent(files){
    if(!this.recentEl)return;
    const area=this.recentEl;area.replaceChildren();
    this.recentStamp=JSON.stringify(files.map(f=>[f.path,f.stat.mtime]));
    const shown=files.slice(0,this.recentLimit);this.recentPill.textContent=`${shown.length} 篇`;
    if(!shown.length){el(area,'p','aw-empty','还没有笔记，点击“新建笔记”开始记录。');return;}
    const list=el(area,'div','aw-file-list');
    shown.forEach((file,i)=>{
      const row=button(list,'',i===0?'aw-file-row aw-file-latest':'aw-file-row',()=>this.openFile(file.path));row.title=file.path;
      if(i===0)row.setAttribute('aria-label',`继续编辑：${file.basename}`);
      icon(row,'file-text','aw-row-icon');
      const info=el(row,'span','aw-file-info');el(info,'span','aw-file-name',file.basename);
      el(info,'span','aw-file-path',folderLabel(file));
      const time=el(row,'time','aw-file-time',modifiedLabel(file.stat.mtime));time.dateTime=new Date(file.stat.mtime).toISOString();
      if(i===0)icon(row,'arrow-up-right','aw-row-open');
    });
  }
  renderMonthly(stack){
    const rows=months(this.plugin.data),best=Math.max(1,...rows.map(r=>r.score));
    const c=card(stack,{name:'monthly',iconName:'table',title:'月度汇总',sub:'最近 12 个月 · 本机记录',badge:`${rows.filter(r=>r.active).length} 个月活跃`,hue:'tone-3'});
    const wrap=el(c.body,'div','aw-table-scroll'),table=el(wrap,'table','aw-table');
    const head=el(el(table,'thead'),'tr');
    for(const label of ['月份','贡献分','','新增字数','活跃天数','编辑时长','深度专注','新建笔记','完成任务'])el(head,'th','',label);
    const body=el(table,'tbody');
    for(const r of rows){
      const tr=el(body,'tr',r.active?'':'aw-row-idle');
      el(tr,'td','aw-month-name',`${r.month.slice(0,4)}年${Number(r.month.slice(5))}月`);
      const cells=[number(Math.round(r.score*10)/10),'',number(r.characters),`${r.active} 天`,`${hours(r.minutes)} 时`,`${hours(r.focus)} 时`,number(r.notes),number(r.tasks)];
      cells.forEach((value,i)=>{
        const td=el(tr,'td',i===1?'aw-bar-cell':'',r.active||i===1?value:'—');
        if(i===1&&r.active)el(td,'span','aw-bar').style.setProperty('--aw-bar',String(r.score/best));
      });
    }
  }
  async exportCSV(){
    const vault=this.app.vault,stamp=Core.dayKey().replace(/-/g,'');
    let path=`知识脉冲-${stamp}.csv`;
    for(let i=2;vault.getAbstractFileByPath(path);i++)path=`知识脉冲-${stamp}-${i}.csv`;
    try{await vault.create(path,csv(this.plugin.data));new Notice(`已导出到笔记库根目录：${path}`);}
    catch{new Notice('导出失败，请检查笔记库写入权限。');}
  }
  async newNote(){
    if(this.creatingNote)return;this.creatingNote=true;
    try{
      if(this.plugin.folderNotes?.getFolder())await this.plugin.folderNotes.createNote();
      else if(typeof this.app.commands?.executeCommandById==='function'){
        if(await this.app.commands.executeCommandById('file-explorer:new-file')===false)new Notice('新建笔记命令暂不可用。');
      }else new Notice('请使用 Obsidian 的新建笔记命令。');
    }catch{new Notice('无法新建笔记，请检查目标文件夹。');}
    finally{this.creatingNote=false;}
  }
  async openFile(path){
    const file=this.app.vault.getAbstractFileByPath(path);
    if(!(file instanceof TFile)){new Notice('这篇笔记已被移动或删除。');return;}
    try{await this.app.workspace.getLeaf('tab').openFile(file);}catch{new Notice('无法打开这篇笔记。');}
  }
}
module.exports={WorkbenchView,VIEW,overview,modifiedLabel,csv,months};
