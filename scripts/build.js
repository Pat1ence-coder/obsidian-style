'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'), source=path.join(root,'src'), modules=new Map();
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
const pluginTokens=fs.readFileSync(path.join(styleSource,'tokens.css'),'utf8')
  .replace(/body\.theme-dark/g,'.theme-dark .aw-view, .theme-dark .aw-figure-modal')
  .replace(/\bbody\s*\{/g,'.aw-view, .aw-figure-modal {');
const hero=fs.readFileSync(path.join(source,'assets/coast-header.png'));
if(!hero.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Header asset is not a PNG');
if(hero.length>4*1024*1024)throw Error('Header asset exceeds the 4 MiB packaging limit');
// A data URI keeps installation to three runtime files and needs no remote requests.
// Keep the large data URI out of custom properties / var() substitution (2 MiB cap).
const heroCSS='.aw-view .aw-backdrop {background-image:url("data:image/png;base64,'+hero.toString('base64')+'");}\n';
const pluginOut=path.join(root,'dist/algorithm-workbench'),snippetOut=path.join(root,'dist/snippets');
fs.mkdirSync(pluginOut,{recursive:true});fs.mkdirSync(snippetOut,{recursive:true});
fs.writeFileSync(path.join(pluginOut,'styles.css'),generated+pluginTokens+'\n'+heroCSS+cssParts(['materials','workbench']));
// Build only inside this repository; installation is a separate explicit action.
fs.writeFileSync(path.join(snippetOut,'style.css'),generated+cssParts(['tokens','shell','typography','components','editor','figures','print']));
fs.writeFileSync(path.join(pluginOut,'main.js'),bundled);
fs.copyFileSync(path.join(root,'manifest.json'),path.join(pluginOut,'manifest.json'));
console.log(`Built ${modules.size} source modules and shared CSS into dist/`);
