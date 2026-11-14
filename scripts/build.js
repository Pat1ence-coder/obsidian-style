'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=fs.realpathSync(path.resolve(__dirname,'..')), source=path.join(root,'src'), modules=new Map();
const {checkedPath,checkedTree}=require('./safe-paths');
checkedTree(root,source);checkedPath(root,path.join(root,'manifest.json'));
for(const name of ['algorithm-workbench/main.js','algorithm-workbench/styles.css','algorithm-workbench/manifest.json','snippets/style.css'])
  checkedPath(root,path.join(root,'dist',name));
// Bundle local feature modules; runtime dependencies remain supplied by Obsidian.
function collect(file) {
  const id=path.relative(source,file).split(path.sep).join('/');
  if(id.startsWith('../'))throw Error('Module outside src: '+file);
  if(modules.has(id))return id;
  modules.set(id,'');
  const code=fs.readFileSync(file,'utf8').replace(/require\((['"])(\.[^'"]+)\1\)/g,(_match,_quote,name)=>{
    const child=path.resolve(path.dirname(file),name.endsWith('.js')?name:name+'.js');
    return `__awRequire(${JSON.stringify(collect(child))})`;
  });
  modules.set(id,code);return id;
}
const entry=collect(path.join(source,'main.js'));
const factories=[...modules].map(([id,code])=>`${JSON.stringify(id)}:(module,exports,__awRequire)=>{\n${code}\n}`).join(',\n');
const bundled=`'use strict';\nconst __awModules={${factories}};\nconst __awCache=Object.create(null);\nfunction __awRequire(id){if(__awCache[id])return __awCache[id].exports;const m={exports:{}};__awCache[id]=m;__awModules[id](m,m.exports,__awRequire);return m.exports;}\nmodule.exports=__awRequire(${JSON.stringify(entry)});\n`;
const styleSource=path.join(source,'styles');
const cssParts=names=>names.map(name=>`/* Source: src/styles/${name}.css */\n`+fs.readFileSync(path.join(styleSource,name+'.css'),'utf8')).join('\n');
const generated='/* GENERATED from src/styles. Edit the source modules, then run npm run build. */\n';
// Scope the shared tokens in the plugin output so stylesheet load order cannot
// override document print tokens (especially when exporting from dark mode).
// The view's pane (leaf) gets the tokens too: it paints the dashboard background behind the header.
const LEAF='.workspace-leaf-content[data-type="algorithm-workbench"]';
const pluginTokens=fs.readFileSync(path.join(styleSource,'tokens.css'),'utf8')
  // body → the plugin's own roots (pane, view, modal); body.theme-dark / body.aw-palette-* keep their class
  // qualifiers so dark mode and palette switching apply inside the plugin too.
  .replace(/\bbody((?:\.[\w-]+)*)\s*\{/g,(_match,classes)=>classes?`body${classes} ${LEAF}, body${classes} .aw-view, body${classes} .aw-figure-modal {`:`${LEAF}, .aw-view, .aw-figure-modal {`);
// Pixel-art banner derived by scripts/pixelate-header.py; scaled up crisply in CSS.
const hero=fs.readFileSync(path.join(source,'assets/coast-header-pixel.png'));
if(!hero.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Header asset is not a PNG');
if(hero.length>4*1024*1024)throw Error('Header asset exceeds the 4 MiB packaging limit');
// A data URI keeps installation to three runtime files and needs no remote requests.
// Keep the large data URI out of custom properties / var() substitution (2 MiB cap).
// One declaration serves both the banner and its blurred ambient copy.
const heroCSS='.aw-view .aw-backdrop, .aw-view .aw-ambient {background-image:url("data:image/png;base64,'+hero.toString('base64')+'");}\n';
// Soft wallpaper behind the glass chrome (scripts/make-wallpaper.py). It is a few KB, so it
// can live in a custom property that shell.css layers under the ambient light.
const wallpaper=fs.readFileSync(path.join(source,'assets/wallpaper.png'));
if(!wallpaper.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Wallpaper asset is not a PNG');
if(wallpaper.length>16*1024)throw Error('Wallpaper asset should stay a small blurred field (< 16 KiB)');
// The glass style's sky (same script): the document floor and the dashboard pane both use it.
const sky=fs.readFileSync(path.join(source,'assets/sky.png'));
if(!sky.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Sky asset is not a PNG');
if(sky.length>16*1024)throw Error('Sky asset should stay a small blurred field (< 16 KiB)');
const skyURI='url("data:image/png;base64,'+sky.toString('base64')+'")';
const wallpaperCSS='body {--ds-wallpaper:url("data:image/png;base64,'+wallpaper.toString('base64')+'");--ds-wallpaper-sky:'+skyURI+';}\n';
const pluginSkyCSS=`${LEAF} {--aw-sky:${skyURI};}\n`;
const pluginOut=path.join(root,'dist/algorithm-workbench'),snippetOut=path.join(root,'dist/snippets');
fs.mkdirSync(pluginOut,{recursive:true});fs.mkdirSync(snippetOut,{recursive:true});
fs.writeFileSync(path.join(pluginOut,'styles.css'),generated+pluginTokens+'\n'+heroCSS+pluginSkyCSS+cssParts(['materials','workbench','workbench-glass','figure-tools','reading-tools']));
// Build only inside this repository; installation is a separate explicit action.
fs.writeFileSync(path.join(snippetOut,'style.css'),generated+cssParts(['tokens'])+'\n'+wallpaperCSS+cssParts(['shell','typography','components','editor','figures','blocks','glass','print']));
fs.writeFileSync(path.join(pluginOut,'main.js'),bundled);
fs.copyFileSync(path.join(root,'manifest.json'),path.join(pluginOut,'manifest.json'));
console.log(`Built ${modules.size} source modules and shared CSS into dist/`);
