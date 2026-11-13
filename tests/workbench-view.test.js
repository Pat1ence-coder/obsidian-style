'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,serialize}=require('./helpers/workbench-host');
test('approved composition puts resume and sidebar before the calendar, without duplicate latest file',()=>{
  const f=fixture();f.view.render();
  const page=f.content.querySelector('.aw-page'),classes=page.children.map(n=>n.className.split(' ')[0]);
  assert.ok(classes.indexOf('aw-body')<classes.indexOf('aw-calendar'));
  assert.equal(f.content.querySelectorAll('.aw-note-card').length,1);
  assert.equal(f.content.querySelectorAll('.aw-file-row').length,5);
  assert.equal(f.content.querySelector('.aw-feature-title').textContent,f.files[0].basename);
  assert.ok(!f.content.querySelector('.aw-file-list').textContent.includes(f.files[0].basename));
  assert.equal(f.content.querySelectorAll('.aw-stat').length,3);
});
test('featured and remaining file buttons open the correct note',async()=>{
  const f=fixture();f.view.render();await f.content.querySelector('.aw-note-card').click();await f.content.querySelector('.aw-file-row').click();
  assert.deepEqual(f.opened,[f.files[0].path,f.files[1].path]);
});
test('new-note button uses selected folder when available and native settings otherwise',async()=>{
  const f=fixture();f.view.render();await f.content.querySelector('.aw-new-note').click();
  assert.deepEqual(f.nativeCommands,['file-explorer:new-file']);let created=0;
  f.plugin.folderNotes.getFolder=()=>({path:'研究'});f.plugin.folderNotes.createNote=async()=>{created++;};
  await f.view.newNote();assert.equal(created,1);assert.equal(f.nativeCommands.length,1);
});
test('calendar has seven rows in every week, and range switch persists preference',async()=>{
  const f=fixture();f.view.render();
  assert.equal(f.content.querySelectorAll('.aw-week').length,27);
  assert.equal(f.content.querySelectorAll('.aw-cell').length,27*7);
  assert.ok(f.content.querySelectorAll('.aw-week').every(week=>week.querySelectorAll('button').length===7));
  const range=f.content.querySelector('[data-aw-weeks="53"]');range.focus();await range.click();
  assert.equal(f.plugin.data.settings.weeks,53);assert.equal(f.plugin.changes,1);
  assert.equal(f.content.querySelectorAll('.aw-cell').length,53*7);
  assert.equal(f.document.activeElement.dataset.awWeeks,'53');
});
test('date selection updates the sidebar; future cells cannot be selected',async()=>{
  const f=fixture();f.view.render();const today=f.Core.dayKey();
  const before=f.Core.dayKey(f.Core.shiftDay(new Date(),-1));await f.view.heatCells.get(before).click();
  assert.equal(f.view.selectedDate,before);assert.equal(f.content.querySelector('.aw-selected-date').title,before);
  assert.equal(f.view.heatCells.get(before).attributes['aria-pressed'],'true');
  assert.equal(f.view.heatCells.get(today).attributes['aria-pressed'],'false');
  for(const [day,cell] of f.view.heatCells)if(day>today)assert.ok(cell.disabled);
});
test('incremental refresh updates metrics without rebuilding the page, including deleted-file state',()=>{
  const f=fixture();f.view.render();const page=f.content.querySelector('.aw-page');
  const today=f.Core.dayKey();f.plugin.data.days[today].characters+=10;f.plugin.data.days[today].files[f.files[0].path]+=10;
  f.view.refresh();assert.equal(f.content.querySelector('.aw-page'),page);assert.equal(f.view.statNumbers[0].textContent,'1,296');
  f.files.shift();f.view.refresh();assert.ok(f.content.querySelectorAll('.aw-day-row').some(row=>row.disabled));
});
test('empty vault, exclusion settings and malicious-looking filenames render as text',()=>{
  const f=fixture();f.files.splice(0);f.view.render();assert.equal(f.content.querySelectorAll('.aw-note-card').length,0);assert.ok(f.content.querySelector('.aw-new-note'));
  f.files.push(new f.TFile('研究/<img onerror=alert(1)>.md',Date.now()));f.view.render();
  assert.ok(serialize(f.content).includes('&lt;img onerror=alert(1)&gt;'));
  f.plugin.data.settings.excludedFolders=['研究'];f.view.render();assert.equal(f.content.querySelectorAll('.aw-note-card').length,0);
});
test('closing releases view references and preserves statistics',async()=>{
  const f=fixture();f.view.render();const before=JSON.stringify(f.plugin.data);await f.view.onClose();
  assert.equal(f.content.children.length,0);assert.equal(f.view.heatCells,null);assert.equal(f.view.statNumbers,null);assert.equal(JSON.stringify(f.plugin.data),before);
});
test('coastal palette and local asset are shipped without remote CSS resources',()=>{
  const root=path.resolve(__dirname,'..'),tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8');
  assert.match(tokens,/--ds-paper: #fcfbf7/);assert.match(tokens,/--ds-accent: #557786/);
  assert.doesNotMatch(tokens,/#595cb2|#b2aff4|#c1bff1/i);
  const css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/data:image\/png;base64,/);assert.doesNotMatch(css,/url\(["']?https?:/i);
  assert.ok(css.includes('.aw-body'));assert.ok(css.includes('@container aw'));
});

test('large header image bypasses CSS variable substitution and has a separate overlay',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  const direct=/\.aw-view \.aw-backdrop\s*\{background-image:url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\);\}/.exec(css);
  assert.ok(direct,'The data URL must be the entire direct background-image value');
  assert.ok(direct[1].length>2097152,'Regression fixture exercises the CSS variable size limit');
  assert.doesNotMatch(css,/--aw-coast-image/);
  const source=fs.readFileSync(path.join(root,'src/styles/workbench.css'),'utf8');
  assert.match(source,/\.aw-backdrop::after\s*\{[^}]*linear-gradient/);
  assert.match(source,/\.aw-page > :not\(\.aw-backdrop\)\s*\{position:relative;z-index:1;/);
});
