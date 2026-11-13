'use strict';
const fs=require('node:fs'),path=require('node:path');

// Preflight fixed repository inputs/outputs before any mkdir or write. The
// repository root is trusted; every descendant, including dangling links, is checked.
function checkedPath(root, target) {
  root=fs.realpathSync(root);target=path.resolve(target);
  const relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))
    throw Error('Path outside allowed root: '+target);
  let current=root;
  const parts=relative.split(path.sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]);
    let stat;
    try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(stat.isSymbolicLink())throw Error('Symbolic links are not allowed: '+current);
    if(i<parts.length-1&&!stat.isDirectory())throw Error('Expected directory: '+current);
    if(!stat.isDirectory()&&!stat.isFile())throw Error('Expected regular file or directory: '+current);
  }
  return target;
}
function checkedTree(root,target){
  checkedPath(root,target);
  if(fs.statSync(target).isDirectory())for(const name of fs.readdirSync(target))checkedTree(root,path.join(target,name));
}
module.exports={checkedPath,checkedTree};
