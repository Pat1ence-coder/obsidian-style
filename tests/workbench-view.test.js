'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,serialize}=require('./helpers/workbench-host');
const cards=f=>f.content.querySelectorAll('.aw-card').map(n=>n.className.split(' ')[1]);
test('board stacks overview, pulse, day detail and recent notes as uniform cards',()=>{
  const f=fixture();f.view.render();
  assert.deepEqual(cards(f),['aw-card-overview','aw-card-pulse','aw-card-day','aw-card-recent']);
  for(const card of f.content.querySelectorAll('.aw-card')){
    assert.ok(card.querySelector('.aw-card-icon')&&card.querySelector('.aw-card-title')&&card.querySelector('.aw-card-sub')&&card.querySelector('.aw-panel'));
  }
  assert.equal(f.content.querySelector('.aw-card-overview').querySelectorAll('.aw-stat').length,6);
  assert.equal(f.content.querySelectorAll('.aw-file-row').length,5);
  assert.equal(f.content.querySelector('.aw-file-latest').querySelector('.aw-file-name').textContent,f.files[0].basename);
  assert.equal(f.content.querySelectorAll('.aw-tab').filter(t=>t.attributes['aria-pressed']==='true').length,1);
});
test('view tabs switch to the full recent list and the monthly summary',async()=>{
  const f=fixture();f.view.render();
  await f.content.querySelectorAll('.aw-tab')[1].click();
  assert.deepEqual(cards(f),['aw-card-recent']);assert.equal(f.content.querySelectorAll('.aw-file-row').length,6);
  await f.content.querySelectorAll('.aw-tab')[2].click();
  assert.deepEqual(cards(f),['aw-card-monthly']);
  const rows=f.content.querySelectorAll('tr');assert.equal(rows.length,13);
  assert.ok(rows[1].textContent.includes('1,286'));assert.ok(rows.at(-1).textContent.includes('—'));
});
test('recent rows open the correct note',async()=>{
  const f=fixture();f.view.render();const rows=f.content.querySelectorAll('.aw-file-row');
  await rows[0].click();await rows[1].click();
  assert.deepEqual(f.opened,[f.files[0].path,f.files[1].path]);
});
test('new-note button uses selected folder when available and native settings otherwise',async()=>{
  const f=fixture();f.view.render();await f.content.querySelector('.aw-new-note').click();
  assert.deepEqual(f.nativeCommands,['file-explorer:new-file']);let created=0;
  f.plugin.folderNotes.getFolder=()=>({path:'研究'});f.plugin.folderNotes.createNote=async()=>{created++;};
  await f.view.newNote();assert.equal(created,1);assert.equal(f.nativeCommands.length,1);
});
test('calendar always spans 53 full weeks; range and metric choices persist',async()=>{
  const f=fixture();f.view.render();
  assert.equal(f.content.querySelectorAll('.aw-week').length,53);
  assert.ok(f.content.querySelectorAll('.aw-week').every(week=>week.querySelectorAll('button').length===7));
  const range=f.content.querySelector('[data-aw-focus="range"]');range.focus();await range.click();
  assert.equal(f.plugin.data.settings.range,180);assert.equal(f.plugin.changes,1);
  assert.equal(f.document.activeElement.dataset.awFocus,'range');
  await f.content.querySelector('[data-aw-focus="metric-characters"]').click();
  assert.equal(f.plugin.data.settings.metric,'characters');
  const today=f.view.heatCells.get(f.Core.dayKey());
  assert.match(today.title,/新增字数 1,286 字/);assert.match(today.className,/aw-level-4/);
  const old=f.view.heatCells.get(f.view.calendar[0]);assert.match(old.className,/aw-out/);
});
test('date selection updates the detail card; future cells cannot be selected',async()=>{
  const f=fixture();f.view.render();const today=f.Core.dayKey();
  const before=f.Core.dayKey(f.Core.shiftDay(new Date(),-1));await f.view.heatCells.get(before).click();
  assert.equal(f.view.selectedDate,before);assert.equal(f.content.querySelector('.aw-card-day').querySelector('.aw-card-title').title,before);
  assert.equal(f.view.heatCells.get(before).attributes['aria-pressed'],'true');
  assert.equal(f.view.heatCells.get(today).attributes['aria-pressed'],'false');
  for(const [day,cell] of f.view.heatCells)if(day>today)assert.ok(cell.disabled);
});
test('incremental refresh updates figures without rebuilding the page, including deleted-file state',()=>{
  const f=fixture();f.view.render();const page=f.content.querySelector('.aw-page');
  const today=f.Core.dayKey();f.plugin.data.days[today].characters+=10;f.plugin.data.days[today].files[f.files[0].path]+=10;
  f.view.refresh();assert.equal(f.content.querySelector('.aw-page'),page);assert.equal(f.view.statNumbers.get('characters').textContent,'1,296');
  f.files.shift();f.view.refresh();assert.ok(f.content.querySelectorAll('.aw-day-row').some(row=>row.disabled));
});
test('CSV export writes every recorded day into a new vault file without overwriting',async()=>{
  const f=fixture();f.view.render();await f.content.querySelector('.aw-export').click();await f.view.exportCSV();
  assert.equal(f.created.length,2);assert.notEqual(f.created[0][0],f.created[1][0]);
  assert.ok(f.created[0][1].startsWith('\ufeff'),'BOM lets spreadsheet apps detect UTF-8');
  const lines=f.created[0][1].slice(1).trim().split('\n');
  assert.equal(lines[0],'日期,贡献分,新增字数,编辑分钟,专注分钟,新建笔记,完成任务');
  assert.equal(lines[1],`${f.Core.dayKey()},12.9,1286,0,0,0,0`);
});
test('empty vault, exclusion settings and malicious-looking filenames render as text',()=>{
  const f=fixture();f.files.splice(0);f.view.render();assert.equal(f.content.querySelectorAll('.aw-file-row').length,0);assert.ok(f.content.querySelector('.aw-new-note'));
  f.files.push(new f.TFile('研究/<img onerror=alert(1)>.md',Date.now()));f.view.render();
  assert.ok(serialize(f.content).includes('&lt;img onerror=alert(1)&gt;'));
  f.plugin.data.settings.excludedFolders=['研究'];f.view.render();assert.equal(f.content.querySelectorAll('.aw-file-row').length,0);
});
test('closing releases view references and preserves statistics',async()=>{
  const f=fixture();f.view.render();const before=JSON.stringify(f.plugin.data);await f.view.onClose();
  assert.equal(f.content.children.length,0);assert.equal(f.view.heatCells,null);assert.equal(f.view.statNumbers,null);assert.equal(JSON.stringify(f.plugin.data),before);
});
test('palette lives in tone roles, and the pixel banner ships without remote CSS resources',()=>{
  const root=path.resolve(__dirname,'..'),tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8');
  for(const role of ['accent','1','2','3','4','5','neutral'])assert.match(tokens,new RegExp(`--ds-tone-${role}: \\d+,\\d+,\\d+;`));
  assert.match(tokens,/--ds-accent: rgb\(var\(--ds-tone-accent\)\)/);
  // Components derive colour from the tones; no stray hex hues outside tokens.css.
  for(const name of ['shell','typography','components','materials','workbench','figures']){
    const source=fs.readFileSync(path.join(root,`src/styles/${name}.css`),'utf8');
    assert.doesNotMatch(source,/#(?!fff\b|000\b)[0-9a-f]{6}\b/i,name);
  }
  const css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/data:image\/png;base64,/);assert.doesNotMatch(css,/url\(["']?https?:/i);
  assert.ok(css.includes('.aw-card'));assert.ok(css.includes('@container aw'));
  assert.match(css,/\.aw-backdrop \{[^}]*image-rendering:pixelated/);
});
test('header image is a direct background value with a separate fade overlay',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  const direct=/\.aw-view \.aw-backdrop, \.aw-view \.aw-ambient\s*\{background-image:url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\);\}/.exec(css);
  assert.ok(direct,'The data URL must be the entire direct background-image value');
  assert.doesNotMatch(css,/--aw-coast-image/);
  const source=fs.readFileSync(path.join(root,'src/styles/workbench.css'),'utf8');
  assert.match(source,/\.aw-backdrop::after\s*\{[^}]*linear-gradient/);
});
test('each metric owns a companion hue shared by its tab, dot and heatmap card',async()=>{
  const f=fixture();f.view.render();
  const pulse=f.content.querySelector('.aw-card-pulse');assert.equal(pulse.style.values['--aw-hue'],'var(--ds-tone-accent)');
  const dots=f.content.querySelector('.aw-card-overview').querySelectorAll('.aw-dot').map(d=>d.style.values['--aw-hue']);
  assert.deepEqual(dots,['var(--ds-tone-accent)','var(--ds-tone-1)','var(--ds-tone-2)','var(--ds-tone-3)']);
  await f.content.querySelector('[data-aw-focus="metric-tasks"]').click();
  assert.equal(f.content.querySelector('.aw-card-pulse').style.values['--aw-hue'],'var(--ds-tone-5)');
  assert.ok(f.content.querySelector('.aw-ambient'),'ambient light layer sits behind the glass cards');
});
test('document snippet ships glass chrome with fallbacks and a screen-only figure size guard',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.match(css,/mod-sidedock > \.workspace-tabs \{[^}]*border-radius: 16px[^}]*background: var\(--ds-glass-solid\)/,'floating panels have an opaque fallback');
  assert.match(css,/backdrop-filter:\s*var\(--ds-glass-panel-blur\)/);
  assert.match(css,/body \{--ds-wallpaper:url\("data:image\/png;base64,/,'blurred wallpaper is embedded, not fetched');
  assert.match(css,/\.workspace \{[^}]*var\(--ds-wallpaper-veil\)[^}]*var\(--ds-wallpaper, none\)/);
  assert.doesNotMatch(css,/url\(["']?https?:/);
  assert.match(css,/prefers-reduced-transparency:reduce/);
  assert.match(css,/@media screen \{\s*\.callout\[data-callout="figure"\] \{--aw-figure-max-width: 720px/);
  assert.match(css,/img:not\(\[width\]\) \{max-width:min\(100%, var\(--aw-figure-max-width\)\);\}/);
});
test('palette chip switches through the plugin and shows the current palette',async()=>{
  const f=fixture();f.view.render();const chip=f.content.querySelector('[data-aw-focus="palette"]');
  assert.match(chip.textContent,/海盐石墨/);
  await chip.click();assert.equal(f.plugin.data.settings.palette,'sand');assert.equal(f.plugin.changes,1);
  f.view.render();assert.match(f.content.querySelector('[data-aw-focus="palette"]').textContent,/暖砂陶土/);
});
test('every palette ships light and dark twins with identical properties, scoped for plugin and snippet',()=>{
  const root=path.resolve(__dirname,'..'),tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8');
  const block=selector=>{const m=new RegExp(selector.replace(/\./g,'\\.')+'\\s*\\{([^}]*)\\}').exec(tokens);assert.ok(m,selector);return new Set(m[1].match(/--[\w-]+(?=\s*:)/g));};
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  for(const id of ['sand','celadon']){
    assert.deepEqual([...block(`body.aw-palette-${id}`)].sort(),[...block(`body.theme-dark.aw-palette-${id}`)].sort());
    assert.ok(plugin.includes(`body.theme-dark.aw-palette-${id} .aw-view, body.theme-dark.aw-palette-${id} .aw-figure-modal {`));
    assert.ok(snippet.includes(`body.aw-palette-${id} {`));
  }
});
test('print resets outrank every palette selector and keep headings and tones dark',()=>{
  const root=path.resolve(__dirname,'..'),print=fs.readFileSync(path.join(root,'src/styles/print.css'),'utf8');
  const reset=/@media print \{[^{]*?(body,[^{]*)\{([^}]*)\}/.exec(print);assert.ok(reset);
  assert.match(reset[1],/body\.theme-dark\[class\*="aw-palette-"\]/);
  for(const token of ['--ds-text:#111','--ds-heading:#111','--ds-tone-accent:34,34,34','--ds-tone-5:68,68,68'])assert.ok(reset[2].includes(token),token);
  const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.ok(snippet.indexOf('body.theme-dark.aw-palette-celadon {')<snippet.indexOf('body.theme-dark[class*="aw-palette-"]'),'print rules load after palettes');
});
test('reduced transparency also replaces the dark glass card background',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'src/styles/materials.css'),'utf8');
  const block=css.slice(css.indexOf('@media (prefers-reduced-transparency:reduce)'));
  assert.match(block,/\.theme-dark \.aw-view :is\(\.aw-card[^{]*\{[^}]*background:var\(--ds-glass-solid\)/);
  assert.ok(css.indexOf('.theme-dark .aw-view .aw-card {')<css.indexOf('@media (prefers-reduced-transparency:reduce)'));
});

test('academic captions: table caption above, bold label, adjustable size, print sizes in points',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.match(css,/\.aw-caption-label \{[^}]*font-weight:650/);
  assert.match(css,/body\.aw-caption-small \{[^}]*--ds-caption-size/);assert.match(css,/body\.aw-caption-large \{[^}]*--ds-caption-size/);
  const table=/\.callout\[data-callout="table"\] > \.callout-title \{([^}]*)\}/.exec(css);assert.ok(table);assert.match(table[1],/padding:0 0 8px/,'title stays first in DOM order, spaced above the table');
  assert.ok(css.indexOf('body.theme-dark.aw-caption-small')>css.indexOf('body.theme-dark[class*="aw-palette-"]'),'print caption sizes follow the print reset');
  assert.match(css,/aw-caption-small \{--ds-caption-size:8pt;\}/);assert.match(css,/aw-caption-large \{--ds-caption-size:10pt;\}/);
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(plugin,/body\.aw-figure-tools-off :is\(\.aw-figure-bar/);
  assert.match(plugin,/@media print \{\s*:is\(\.aw-figure-bar,\.aw-figure-resize,\.aw-figure-grip\) \{display:none !important;\}/);
});
