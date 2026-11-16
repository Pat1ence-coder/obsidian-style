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
// The image library pane and its tag dialog read the same tokens.
const ROOTS=[LEAF,'.aw-view','.aw-figure-modal','.aw-lib','.aw-lib-modal'];
const pluginTokens=fs.readFileSync(path.join(styleSource,'tokens.css'),'utf8')
  // body → the plugin's own roots (pane, view, modal); body.theme-dark keeps its class qualifier
  // so dark mode applies inside the plugin too.
  .replace(/\bbody((?:\.[\w-]+)*)\s*\{/g,(_match,classes)=>classes?ROOTS.map(r=>`body${classes} ${r}`).join(', ')+' {':ROOTS.join(', ')+' {');
const pluginOut=path.join(root,'dist/algorithm-workbench'),snippetOut=path.join(root,'dist/snippets');
fs.mkdirSync(pluginOut,{recursive:true});fs.mkdirSync(snippetOut,{recursive:true});
fs.writeFileSync(path.join(pluginOut,'styles.css'),generated+pluginTokens+'\n'+cssParts(['materials','workbench','workbench-glass','figure-tools','reading-tools','annotations','library']));
// Build only inside this repository; installation is a separate explicit action.
fs.writeFileSync(path.join(snippetOut,'style.css'),generated+cssParts(['tokens'])+'\n'+cssParts(['shell','controls','typography','components','editor','figures','blocks','glass','window-glass','print']));
fs.writeFileSync(path.join(pluginOut,'main.js'),bundled);
fs.copyFileSync(path.join(root,'manifest.json'),path.join(pluginOut,'manifest.json'));
console.log(`Built ${modules.size} source modules and shared CSS into dist/`);
