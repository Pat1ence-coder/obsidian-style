'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,serialize}=require('./helpers/workbench-host');
const cards=f=>f.content.querySelectorAll('.aw-card').map(n=>n.className.split(' ')[1]);
test('board modules share one card anatomy; recent rows and the active tab',()=>{
  const f=fixture();f.view.render();
  for(const card of f.content.querySelectorAll('.aw-card')){
    assert.ok(card.querySelector('.aw-card-icon')&&card.querySelector('.aw-card-title')&&card.querySelector('.aw-card-sub')&&card.querySelector('.aw-panel'));
  }
  assert.equal(f.content.querySelectorAll('.aw-kpi').length,3);
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
  assert.match(f.created[0][0],/^写作工作台-\d{8}\.csv$/);assert.match(f.created[1][0],/^写作工作台-\d{8}-2\.csv$/);
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
test('palette lives in tone roles, and the dashboard ships without banner images or remote CSS resources',()=>{
  const root=path.resolve(__dirname,'..'),tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8');
  for(const role of ['accent','1','2','3','4','5','neutral'])assert.match(tokens,new RegExp(`--ds-tone-${role}: \\d+,\\d+,\\d+;`));
  assert.match(tokens,/--ds-accent: rgb\(var\(--ds-tone-accent\)\)/);
  // Components derive colour from the tones; no stray hex hues outside tokens.css.
  for(const name of ['shell','typography','components','materials','workbench','figures']){
    const source=fs.readFileSync(path.join(root,`src/styles/${name}.css`),'utf8');
    assert.doesNotMatch(source,/#(?!fff\b|000\b)[0-9a-f]{6}\b/i,name);
  }
  const css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.doesNotMatch(css,/data:image\/png;base64,/,'no banner image');assert.doesNotMatch(css,/url\(["']?https?:/i);
  assert.ok(css.includes('.aw-card'));assert.ok(css.includes('@container aw'));
  assert.doesNotMatch(css,/aw-backdrop|aw-style-/);
});
test('each metric owns a companion hue shared by its tab, dot and heatmap card',async()=>{
  const f=fixture();f.view.render();
  const pulse=f.content.querySelector('.aw-card-pulse');assert.equal(pulse.style.values['--aw-hue'],'var(--ds-tone-accent)');
  const tabs=f.content.querySelectorAll('.aw-segment-item').map(d=>d.style.values['--aw-hue']);
  assert.deepEqual(tabs,['var(--ds-tone-accent)','var(--ds-tone-4)','var(--ds-tone-2)','var(--ds-tone-3)','var(--ds-tone-1)','var(--ds-tone-5)']);
  await f.content.querySelector('[data-aw-focus="metric-tasks"]').click();
  assert.equal(f.content.querySelector('.aw-card-pulse').style.values['--aw-hue'],'var(--ds-tone-5)');
  assert.equal(f.content.querySelector('.aw-ambient'),null,'no blurred banner glow behind the cards');
});
test('document snippet ships glass chrome with fallbacks and a screen-only figure size guard',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.match(css,/mod-sidedock \.workspace-tabs > \.workspace-tab-container \{[^}]*border-radius: 16px[^}]*background: var\(--ds-frost\)[^}]*var\(--ds-elev-3\)/,'sidebar panels are opaque frost on the top elevation');
  assert.match(css,/\.workspace-split\.mod-root \.workspace-leaf-content \{[^}]*background: var\(--ds-frost\)/,'the note card is opaque frost');
  assert.match(css,/--ds-frost: var\(--ds-grain\), var\(--ds-glass-sheen\), var\(--ds-paper\);/,'frost ends on an opaque paper layer');
  assert.match(css,/--ds-grain: url\("data:image\/svg\+xml;utf8,<svg [^\n]*<\/svg>"\);\n/,'the grain is one intact declaration');
  assert.match(css,/\.mod-root \.workspace-tab-header \{align-self: center;/,'note tabs clear the window top');
  assert.match(css,/\.notice \{color: var\(--ds-text\);\}/,'notices are white cards, so their text must be dark to be readable');
  assert.match(css,/body:is\(\.theme-light,\.theme-dark\) \{background-color: var\(--ds-bg\);\}/,'the page is opaque, so a window without a workspace never shows a black title bar');
  assert.match(css,/\.workspace \{background: var\(--ds-bg\);\}/,'the window floor is plain, no wallpaper or gradient');
  assert.doesNotMatch(css,/--ds-wallpaper|radial-gradient\(\d+px/,'no wallpaper and no ambient blooms');
  const chrome=css.slice(css.indexOf('Source: src/styles/shell.css'),css.indexOf('Source: src/styles/print.css'));
  assert.equal((chrome.match(/backdrop-filter: /g)||[]).length,2,'only the modal scrim blurs; panels are opaque');
  assert.doesNotMatch(css,/url\(["']?https?:/);
  assert.match(css,/@media screen \{\s*\.callout\[data-callout="figure"\] \{--aw-figure-max-width: 720px/);
  assert.match(css,/img:not\(\[width\]\) \{max-width:min\(100%, var\(--aw-figure-max-width\)\);\}/);
  assert.match(css,/\[data-callout-metadata\^="grid-"\] \.image-embed:has\(> img:not\(\[width\]\)\) \{width:auto;\}/,'in a grid the embed hugs its image, so the resize dot sits on the image corner');
});
test('the toolbar has no palette chip; one palette ships light and dark twins with identical properties',()=>{
  const f=fixture();f.view.render();assert.equal(f.content.querySelector('[data-aw-focus="palette"]'),null);
  const root=path.resolve(__dirname,'..'),tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8');
  assert.doesNotMatch(tokens,/aw-palette-/);
  const block=selector=>{const m=new RegExp(selector.replace(/\./g,'\\.')+'\\s*\\{([^}]*)\\}').exec(tokens);assert.ok(m,selector);return new Set(m[1].match(/--ds-(?:tone-\w+|bg|paper|text|heading|muted|faint|border|heat-0)(?=\s*:)/g));};
  assert.deepEqual([...block('body.theme-dark')].sort(),[...block('body')].sort());
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.ok(plugin.includes('body.theme-dark .workspace-leaf-content[data-type="algorithm-workbench"], body.theme-dark .aw-view, body.theme-dark .aw-figure-modal, body.theme-dark .aw-lib, body.theme-dark .aw-lib-modal {'));
});
test('print resets outrank the token selectors and keep headings and tones dark',()=>{
  const root=path.resolve(__dirname,'..'),print=fs.readFileSync(path.join(root,'src/styles/print.css'),'utf8');
  const reset=/@media print \{[^{]*?(body,[^{]*)\{([^}]*)\}/.exec(print);assert.ok(reset);
  assert.match(reset[1],/body\.theme-dark/);
  for(const token of ['--ds-text:#111','--ds-heading:#111','--ds-tone-accent:34,34,34','--ds-tone-5:68,68,68'])assert.ok(reset[2].includes(token),token);
  const snippet=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.ok(snippet.indexOf('body.theme-dark {')<snippet.indexOf('body, body.theme-light, body.theme-dark {'),'print rules load after the tokens');
});
test('dashboard layers are opaque: frosted card, raised panel, raised chips, recessed tracks',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/\.aw-view \.aw-card \{[^}]*background:var\(--ds-frost\);[^}]*var\(--ds-elev-2\)/);
  assert.match(css,/\.aw-view \.aw-panel \{[^}]*background:var\(--ds-paper\);[^}]*var\(--ds-elev-1\)/);
  assert.match(css,/\.aw-view \.aw-segment \{[^}]*background:var\(--ds-inset-bg\);box-shadow:var\(--ds-inset\)/);
  const materials=fs.readFileSync(path.join(root,'src/styles/materials.css'),'utf8');
  assert.doesNotMatch(materials,/backdrop-filter/,'no blur behind opaque cards');
  for(const mode of ['body {','body.theme-dark {']){
    const tokens=fs.readFileSync(path.join(root,'src/styles/tokens.css'),'utf8'),start=tokens.indexOf(mode),block=tokens.slice(start,tokens.indexOf('\n}',start));
    for(const name of ['--ds-elev-1','--ds-elev-2','--ds-elev-3','--ds-inset-bg','--ds-inset','--ds-canvas'])assert.match(block,new RegExp(name+'\\s*:'),mode+name);
  }
});

test('academic captions: table caption above, bold label, adjustable size, print sizes in points',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  assert.match(css,/\.aw-caption-label \{[^}]*font-weight:650/);
  assert.match(css,/body\.aw-caption-small \{[^}]*--ds-caption-size/);assert.match(css,/body\.aw-caption-large \{[^}]*--ds-caption-size/);
  const table=/\.callout\[data-callout="table"\] > \.callout-title \{([^}]*)\}/.exec(css);assert.ok(table);assert.match(table[1],/padding:0 0 8px/,'title stays first in DOM order, spaced above the table');
  assert.ok(css.indexOf('body.theme-dark.aw-caption-small')>css.indexOf('body, body.theme-light, body.theme-dark {'),'print caption sizes follow the print reset');
  assert.match(css,/aw-caption-small \{--ds-caption-size:8pt;\}/);assert.match(css,/aw-caption-large \{--ds-caption-size:10pt;\}/);
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(plugin,/body\.aw-figure-tools-off :is\(\.aw-figure-bar/);
  assert.match(plugin,/@media print \{\s*:is\(\.aw-figure-bar,\.aw-figure-resize,\.aw-figure-grip\) \{display:none !important;\}/);
});
test('inside an Obsidian pane the dashboard reaches the card edge and shares one surface with the header',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  const leaf='.workspace .workspace-split .workspace-leaf-content[data-type="algorithm-workbench"]';
  assert.ok(css.includes(`${leaf} > .view-content.aw-view {padding:0;background:transparent;}`),'beats Obsidian default view padding');
  assert.ok(css.includes(`${leaf} > .view-header {background:transparent;`));
  assert.ok(css.includes('.workspace-leaf-content[data-type="algorithm-workbench"], .aw-view, .aw-figure-modal, .aw-lib, .aw-lib-modal {'),'pane (and the image library) receive the tokens they paint with');
});

test('the board is a bento grid with KPI, today, trend and monthly modules; no style chip',()=>{
  const f=fixture();f.view.render();
  assert.equal(f.content.querySelector('[data-aw-focus="style"]'),null);
  assert.ok(f.content.querySelector('.aw-bento'));assert.equal(f.content.querySelector('.aw-stack'),null);
  assert.deepEqual(cards(f),['aw-card-today','aw-card-trend','aw-card-pulse','aw-card-day','aw-card-months','aw-card-recent']);
  const kpis=f.content.querySelectorAll('.aw-kpi');
  assert.deepEqual(kpis.map(k=>k.style.values['--aw-hue']),['var(--ds-tone-accent)','var(--ds-tone-4)','var(--ds-tone-2)']);
  assert.ok(kpis.every(k=>k.querySelector('.aw-kpi-glow')&&k.querySelector('.aw-kpi-value')));
  assert.equal(kpis[1].querySelector('strong').textContent,'1,286');
  assert.equal(f.content.querySelector('.aw-card-today').querySelector('.aw-badge').textContent,'12.9 分');
  assert.equal(f.content.querySelectorAll('.aw-progress').length,2);
  const svg=f.content.querySelector('.aw-trend-plot').querySelector('svg');
  assert.match(svg.getAttribute('aria-label'),/最近 90 天每日贡献分，峰值 12\.9 分/);
  assert.equal(f.content.querySelectorAll('.aw-trend-hit').length,0,'hit groups carry classes as attributes');
  assert.equal(svg.querySelectorAll('rect').length,91,'90 hover areas plus one column for the single active day');
  const bars=f.content.querySelectorAll('.aw-bar-col');assert.equal(bars.length,6);
  assert.ok(bars.at(-1).className.includes('is-current'));
  assert.equal(f.content.querySelector('.aw-card-months').querySelector('.aw-badge').textContent,'本月 1 天活跃');
});
test('bento modules redraw in place when today changes; other views stack full-width cards',()=>{
  const f=fixture();f.view.render();
  const today=f.content.querySelector('.aw-card-today'),kpi=f.content.querySelectorAll('.aw-kpi')[1].querySelector('strong');
  f.plugin.data.days[Object.keys(f.plugin.data.days).sort().at(-1)].characters=2000;
  f.view.refresh();
  assert.equal(f.content.querySelector('.aw-card-today'),today,'no full render');
  assert.equal(today.querySelector('.aw-badge').textContent,'20 分');assert.equal(kpi.textContent,'2,000');
  assert.match(f.content.querySelector('.aw-trend-plot').querySelector('svg').getAttribute('aria-label'),/今天 20 分/);
  f.view.tab='recent';f.view.render();
  assert.ok(f.content.querySelector('.aw-stack'));assert.equal(f.content.querySelectorAll('.aw-kpi').length,0);
});
test('the view is called 写作工作台 with a notebook-and-pen icon, falling back to pencil on older Obsidian',()=>{
  const f=fixture();f.view.render();
  assert.equal(f.view.getDisplayText(),'写作工作台');assert.equal(f.view.getIcon(),'notebook-pen');
  assert.equal(f.content.querySelector('.aw-title').textContent,'写作工作台');
  assert.equal(f.content.querySelector('.aw-card-pulse').querySelector('.aw-card-title').textContent,'年度活跃热力图');
  const old=fixture({getIcon:name=>name==='pencil'?{}:null});
  assert.equal(old.view.getIcon(),'pencil');
  assert.equal(fixture({getIcon:()=>({})}).view.getIcon(),'notebook-pen');
});
test('a live trend redraw keeps the hovered day on show',()=>{
  const f=fixture();f.view.render();
  const plot=f.content.querySelector('.aw-trend-plot');
  const find=(node,test)=>test(node)?node:node.children.map(c=>find(c,test)).find(Boolean)||null;
  const hits=()=>find(plot,n=>n.events?.pointerover);
  hits().dispatch('pointerover',{target:{getAttribute:()=>'29'}});
  const tip=()=>plot.querySelector('.aw-tip');
  assert.match(tip().className,/is-shown/);const date=tip().querySelector('.aw-tip-date').textContent;
  f.plugin.data.days[Object.keys(f.plugin.data.days).sort().at(-1)].characters=2000;
  f.view.refresh();
  assert.match(tip().className,/is-shown/,'still shown after the redraw');
  assert.equal(tip().querySelector('.aw-tip-date').textContent,date);
  hits().dispatch('pointerleave');
  assert.doesNotMatch(tip().className,/is-shown/);
  f.plugin.data.days[Object.keys(f.plugin.data.days).sort().at(-1)].characters=3000;f.view.refresh();
  assert.doesNotMatch(tip().className,/is-shown/,'no tooltip comes back once the pointer has left');
});
test('the view icon is probed once',()=>{
  let probes=0;const f=fixture({getIcon:()=>{probes++;return {};}});
  f.view.render();f.view.getIcon();f.view.getIcon();f.view.render();
  assert.equal(probes,1);
});
test('window glass: one colourless sheet of glass over the chosen picture, only when the plugin asks',()=>{
  const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8');
  const src=fs.readFileSync(path.join(root,'src/styles/window-glass.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  // The theme never tints the glass: every colour it lays over the picture is a neutral grey.
  const colours=src.match(/rgba\([^)]*\)/g);
  assert.ok(colours.length>=12);
  for(const c of colours){const [r,g,b]=c.slice(5,-1).split(',').map(Number);assert.ok(r===g&&g===b,`${c} is neutral`);}
  assert.doesNotMatch(src,/#[0-9a-f]{3,6}\b|gradient|url\(/i,'no tint, no built-in wallpaper: the picture comes from the user');
  // Every rule hangs off the plugin's body class, so without a picture the opaque white look stays.
  for(const rule of src.match(/^[^@{}\n][^{}]*\{/gm))assert.match(rule,/body(\.theme-dark)?\.aw-glass/,rule);
  assert.doesNotMatch(css,/is-translucent/,"Obsidian's own translucent window is left alone (it ghosts on macOS)");
  assert.match(css,/body\.aw-glass \.app-container::before \{[^}]*background: var\(--aw-glass-image\) center \/ cover no-repeat;[^}]*filter: blur\(var\(--ds-glass-blur\)\)/);
  assert.match(css,/body\.aw-glass \.workspace-split\.mod-root \.workspace-leaf-content \{[^}]*background: var\(--ds-glass-wash\);[^}]*box-shadow: none;/);
  assert.match(css,/@media \(prefers-reduced-transparency: reduce\)/);
  assert.ok(css.indexOf('Source: src/styles/window-glass.css')<css.indexOf('Source: src/styles/print.css'),'print rules still load last');
  const plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(plugin,/body\.aw-glass \.aw-view \{background:transparent;\}/,'the dashboard cards float on the glass');
});
test('small fixes stay: search text clears its buttons, one divider on glass, no frame around figures, ruler hides the scrollbar',()=>{
  const root=path.resolve(__dirname,'..');
  const css=fs.readFileSync(path.join(root,'dist/snippets/style.css'),'utf8'),plugin=fs.readFileSync(path.join(root,'dist/algorithm-workbench/styles.css'),'utf8');
  assert.match(css,/\.search-input-container input \{padding-inline-end: 32px;text-overflow: ellipsis;\}/);
  assert.match(css,/\.search-input-container:has\(\.input-right-decorator\) input \{padding-inline-end: 64px;\}/,'room for the Aa match-case toggle');
  assert.match(css,/body\.aw-glass \{[^}]*--divider-color: transparent;/,'on glass only the note hairline separates sidebar and note');
  assert.match(plugin,/\.cm-embed-block:has\(> \.callout\[data-callout="figure"\]\):hover \{box-shadow:none;\}/);
  // Newer Chromium ignores ::-webkit-scrollbar once scrollbar-color is set, so the standard property must be there.
  assert.match(plugin,/\.aw-has-ruler :is\(\.cm-scroller,\.markdown-preview-view\) \{scrollbar-width: none;\}/);
});
