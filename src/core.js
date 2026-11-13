'use strict';
const DEFAULT_SETTINGS = { nameScreenshots: true, folderNotes: true, openOnStartup: true, tracking: true, recentLimit: 8, range: 90, metric: 'score', palette: 'sea', captionSize: 'normal', figureTools: true, excludedFolders: ['Templates', 'templates'] };
const RANGES = [30, 90, 180, 365];
// Colour palettes; each id maps to a body class aw-palette-<id> defined in tokens.css.
const PALETTES = [{id:'sea', label:'海盐石墨'}, {id:'sand', label:'暖砂陶土'}, {id:'celadon', label:'青瓷'}];
// Figure and table caption sizes; body class aw-caption-<id>, defined in figures.css.
const CAPTION_SIZES = [{id:'small', label:'小'}, {id:'normal', label:'标准'}, {id:'large', label:'大'}];
// Score weights are documented in the dashboard; values are derived, never stored.
const METRICS = [
  {key:'score', label:'贡献分', unit:'分'},
  {key:'characters', label:'新增字数', unit:'字'},
  {key:'minutes', label:'编辑时长', unit:'分钟'},
  {key:'focus', label:'深度专注', unit:'分钟'},
  {key:'notes', label:'新建笔记', unit:'篇'},
  {key:'tasks', label:'完成任务', unit:'项'}
];
const COUNTERS = ['minutes', 'focus', 'notes', 'tasks'];
const IDLE_GAP = 5, FOCUS_SPAN = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const dict = () => Object.create(null);
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function shiftDay(date, n) {
  const d = new Date(date); d.setHours(12,0,0,0); d.setDate(d.getDate()+n); return d;
}
function countCharacters(text) {
  let count = 0;
  for (const ch of text) if (!/\s/u.test(ch)) count++;
  return count;
}
// Weak keys do not retain closed editors or obsolete immutable documents.
function transactionCounts(tr, cache) {
  const beforeDoc = tr.startState.doc, afterDoc = tr.newDoc;
  let before = cache.get(beforeDoc);
  if (before === undefined) { before = countCharacters(beforeDoc.toString()); cache.set(beforeDoc, before); }
  let delta = 0, splitSurrogate = false;
  const splitsPair = (doc, pos) => pos > 0 && pos < doc.length && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(doc.sliceString(pos-1,pos+1));
  tr.changes.iterChanges((fromA,toA,fromB,toB,inserted) => {
    delta += countCharacters(inserted.toString()) - countCharacters(beforeDoc.sliceString(fromA,toA));
    if (splitsPair(beforeDoc,fromA) || splitsPair(beforeDoc,toA) || splitsPair(afterDoc,fromB) || splitsPair(afterDoc,toB)) splitSurrogate = true;
  });
  const after = splitSurrogate ? countCharacters(afterDoc.toString()) : before + delta;
  cache.set(afterDoc,after);
  return [before,after];
}
function pruneRecords(data, date) {
  let changed = false;
  for (const [path, record] of Object.entries(data.records)) {
    if (record.day !== date) { delete data.records[path]; changed = true; }
  }
  return changed;
}
function emptyData(now = new Date()) {
  return { version: 2, started: dayKey(now), activityStarted: dayKey(now), settings: {...DEFAULT_SETTINGS}, days: dict(), records: dict() };
}
function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function loadState(raw, now = new Date()) {
  if (raw == null) return emptyData(now);
  if (![1,2].includes(raw.version) || !raw.days || !raw.records || !DATE.test(raw.started)) throw Error('无法识别统计文件格式');
  // Version 1 only tracked characters; the other activity counters start at migration.
  if (raw.version === 2 && !DATE.test(raw.activityStarted)) throw Error('无法识别统计文件格式');
  const d = emptyData(now); d.started = raw.started;
  if (raw.version === 2) d.activityStarted = raw.activityStarted;
  const s = raw.settings || {};
  for (const name of ['openOnStartup', 'tracking', 'folderNotes', 'nameScreenshots', 'figureTools']) if (typeof s[name] === 'boolean') d.settings[name] = s[name];
  if (RANGES.includes(s.range)) d.settings.range = s.range;
  if (METRICS.some(m => m.key === s.metric)) d.settings.metric = s.metric;
  if (PALETTES.some(x => x.id === s.palette)) d.settings.palette = s.palette;
  if (CAPTION_SIZES.some(x => x.id === s.captionSize)) d.settings.captionSize = s.captionSize;
  if (Number.isInteger(s.recentLimit)) d.settings.recentLimit = Math.min(30, Math.max(3,s.recentLimit));
  if (Array.isArray(s.excludedFolders)) d.settings.excludedFolders = s.excludedFolders.filter(x=>typeof x==='string').map(x=>x.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean);
  for (const [date, value] of Object.entries(raw.days)) {
    if (!DATE.test(date) || !value || !value.files || !validCount(value.characters)) throw Error('统计日期或数值损坏');
    const files = dict();
    for (const [path, count] of Object.entries(value.files)) {
      if (!validCount(count)) throw Error('文件统计损坏');
      files[path] = count;
    }
    if (Object.values(files).reduce((a,b)=>a+b,0) !== value.characters) throw Error('统计总数不一致');
    const day = { characters: value.characters, files };
    for (const key of COUNTERS) if (value[key] !== undefined) {
      if (!validCount(value[key])) throw Error('活动统计损坏');
      if (value[key]) day[key] = value[key];
    }
    d.days[date] = day;
  }
  for (const [path,r] of Object.entries(raw.records)) {
    if (!r || !DATE.test(r.day) || !validCount(r.peak) || !validCount(r.last) || r.peak < r.last) throw Error('计数基线损坏');
    if ((r.taskNet !== undefined && !Number.isSafeInteger(r.taskNet)) || (r.taskPeak !== undefined && !validCount(r.taskPeak))) throw Error('任务基线损坏');
    if (r.day === dayKey(now)) d.records[path] = {...r};
  }
  return d;
}
function isExcluded(path, folders) {
  return folders.some(folder => path === folder || path.startsWith(folder + '/'));
}
// Each day's high-water mark counts growth once. Non-user changes move the
// baseline without adding activity; no note contents are stored.
function recordChange(data, path, before, after, date, userEdit = true) {
  let r = own(data.records,path) ? data.records[path] : null;
  if (!r || r.day !== date) r = { day:date, peak:before, last:before };
  if (r.last !== before) r.peak = Math.max(before, r.peak + before-r.last);
  if (!userEdit) {
    r.peak = Math.max(after, r.peak + after-before);
    r.last = after; data.records[path] = r; return 0;
  }
  const added = Math.max(0, after-r.peak);
  r.peak = Math.max(r.peak, after); r.last = after; data.records[path] = r;
  if (added) {
    const day = ensureDay(data,date); day.characters += added;
    day.files[path] = (own(day.files,path) ? day.files[path] : 0) + added;
  }
  return added;
}
function ensureDay(data, date) {
  if (!own(data.days,date)) data.days[date] = {characters:0,files:dict()};
  return data.days[date];
}
// Editing time: minutes containing edits, plus pauses of at most IDLE_GAP minutes
// between them. Once a continuous session reaches FOCUS_SPAN it all counts as focus.
function recordActivity(data, session, now = Date.now()) {
  const minute = Math.floor(now/60000), gap = session.last == null ? Infinity : minute-session.last;
  if (gap <= 0) { if (gap < 0) session.last = minute; return 0; }
  const added = gap <= IDLE_GAP ? gap : 1;
  session.span = gap <= IDLE_GAP ? (session.span||0)+gap : 1; session.last = minute;
  const day = ensureDay(data,dayKey(new Date(now)));
  day.minutes = (day.minutes||0)+added;
  const focus = session.span < FOCUS_SPAN ? 0 : session.span-added < FOCUS_SPAN ? session.span : added;
  if (focus) day.focus = (day.focus||0)+focus;
  return added;
}
const TASK_DONE = /^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\]/gm;
function doneTasks(doc, ranges) {
  let total = 0, start = -1, end = -1;
  const flush = () => { if (end >= 0) total += (doc.sliceString(start,end).match(TASK_DONE)||[]).length; };
  for (const [from,to] of ranges) {
    const a = doc.lineAt(from).from, b = doc.lineAt(to).to;
    if (a <= end) { end = Math.max(end,b); continue; }
    flush(); start = a; end = b;
  }
  flush(); return total;
}
// Net change of checked task lines, reading only the lines a transaction touched.
function taskDelta(tr) {
  const before = [], after = [];
  tr.changes.iterChanges((fromA,toA,fromB,toB) => { before.push([fromA,toA]); after.push([fromB,toB]); });
  return doneTasks(tr.newDoc,after)-doneTasks(tr.startState.doc,before);
}
// Like characters, a per-file daily high-water mark: re-ticking the same task counts once.
function recordTasks(data, path, delta, date) {
  const r = own(data.records,path) ? data.records[path] : null;
  if (!delta || !r || r.day !== date) return 0;
  r.taskNet = (r.taskNet||0)+delta;
  const added = Math.max(0, r.taskNet-(r.taskPeak||0));
  r.taskPeak = Math.max(r.taskPeak||0, r.taskNet);
  if (added) { const day = ensureDay(data,date); day.tasks = (day.tasks||0)+added; }
  return added;
}
function recordNote(data, date) { const day = ensureDay(data,date); day.notes = (day.notes||0)+1; }
const round1 = n => Math.round(n*10)/10;
function dayScore(day) {
  if (!day) return 0;
  return round1(day.characters/100 + (day.minutes||0)/10 + (day.focus||0)/10 + (day.notes||0)*2 + (day.tasks||0));
}
function metricValue(day, key) {
  if (key === 'score') return dayScore(day);
  return day ? (key === 'characters' ? day.characters : day[key]||0) : 0;
}
function lastDays(now, n) { return Array.from({length:n},(_,i)=>dayKey(shiftDay(now,i-n+1))); }
function summary(data, now, n) {
  const totals = {score:0,characters:0,minutes:0,focus:0,notes:0,tasks:0,active:0,longest:0};
  let run = 0;
  for (const date of lastDays(now,n)) {
    const day = data.days[date], score = dayScore(day);
    for (const {key} of METRICS) totals[key] += metricValue(day,key);
    if (score > 0) { totals.active++; run++; totals.longest = Math.max(totals.longest,run); } else run = 0;
  }
  totals.score = round1(totals.score);
  return totals;
}
// A streak survives until the end of today: an idle today still shows yesterday's run.
function currentStreak(data, now = new Date()) {
  let streak = 0, offset = dayScore(data.days[dayKey(now)]) > 0 ? 0 : -1;
  while (dayScore(data.days[dayKey(shiftDay(now,offset))]) > 0) { streak++; offset--; }
  return streak;
}
// Personal intensity: a value's rank among the user's own active days in the chosen
// range, split into quarters. Ranks stay meaningful with only a few active days.
function activeValues(values) { return values.filter(v=>v>0).sort((a,b)=>a-b); }
function rankOf(value, sorted) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo+hi) >> 1; if (sorted[mid] <= value) lo = mid+1; else hi = mid; }
  return lo/sorted.length;
}
function intensity(value, sorted) {
  if (value <= 0) return 0;
  if (!sorted.length) return 4;
  return Math.min(4, Math.max(1, Math.ceil(rankOf(value,sorted)*4)));
}
function percentile(value, sorted) {
  if (value <= 0 || !sorted.length) return null;
  return Math.round(rankOf(value,sorted)*100);
}
function renamePath(data, oldPath, newPath) {
  const renamed = path => path === oldPath ? newPath : path.startsWith(oldPath+'/') ? newPath+path.slice(oldPath.length) : null;
  for (const [path,r] of Object.entries(data.records)) {
    const next = renamed(path); if (!next) continue;
    data.records[next] = r; delete data.records[path];
  }
  for (const day of Object.values(data.days)) for (const [path,n] of Object.entries(day.files)) {
    const next = renamed(path); if (!next) continue;
    day.files[next] = (own(day.files,next) ? day.files[next] : 0)+n; delete day.files[path];
  }
}
function recentFiles(files, settings) {
  return files.filter(f=>!isExcluded(f.path,settings.excludedFolders)).sort((a,b)=>b.stat.mtime-a.stat.mtime || a.path.localeCompare(b.path)).slice(0,settings.recentLimit);
}
function calendarDays(now, weeks) {
  const monday = shiftDay(now,-((now.getDay()+6)%7));
  const start = shiftDay(monday,-7*(weeks-1));
  return Array.from({length:weeks*7},(_,i)=>dayKey(shiftDay(start,i)));
}
module.exports = {transactionCounts,pruneRecords,DEFAULT_SETTINGS,RANGES,METRICS,PALETTES,CAPTION_SIZES,dayKey,shiftDay,countCharacters,emptyData,loadState,isExcluded,recordChange,
  recordActivity,taskDelta,recordTasks,recordNote,dayScore,metricValue,lastDays,summary,currentStreak,activeValues,intensity,percentile,renamePath,recentFiles,calendarDays};
