'use strict';
// Margin-style annotations: ==highlighted text=={note}. The note sits right after the closing
// == with no space, on one line, up to 80 characters. Nothing here touches the DOM.
const NOTE=/^\{([^{}\n]{1,80})\}/;
const SOURCE=/==([^=\n]+)==\{([^{}\n]{1,80})\}/g;

// Reading view: the text that follows a rendered <mark>.
function parseAnnotation(text) {
  const m=NOTE.exec(text||'');
  if(!m||!m[1].trim())return null;
  return {note:m[1].trim(),rest:text.slice(m[0].length)};
}
// Live Preview: offsets of every {note} in a stretch of source text.
function findAnnotations(text, offset=0) {
  const found=[];
  for(const m of text.matchAll(SOURCE)){
    if(!m[2].trim())continue;
    const to=m.index+m[0].length,from=to-m[2].length-2;
    found.push({markFrom:offset+m.index,from:offset+from,to:offset+to,note:m[2].trim()});
  }
  return found;
}
module.exports={parseAnnotation,findAnnotations};
