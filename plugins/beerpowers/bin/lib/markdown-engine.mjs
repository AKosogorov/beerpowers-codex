export function* markupLines(text) {
  let fence;
  for (const line of text.matchAll(/^[^\r\n]+/gm)) {
    const content = line[0].replace(/^\uFEFF/, '');
    const mark = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (mark && mark[1].startsWith(fence) && !mark[2].trim()) fence = null;
    } else if (mark) fence = mark[1];
    else yield {content, start:line.index + line[0].length - content.length, end:line.index + line[0].length};
  }
  if (fence) throw Error('Unclosed Markdown code fence around the migration target');
}

export function blocks(text, path) {
  const found = new Map();
  let open;
  for (const {content, start, end} of markupLines(text)) {
    if (!/^\s*<!--\s*\/?beerpowers:engine\b/.test(content)) continue;
    const begin = /^<!-- beerpowers:engine ([a-zA-Z0-9-]+)(?: if=([\w-]+:[\w.-]+))? -->$/.exec(content);
    if (begin && !open && !found.has(begin[1])) {
      open = { name: begin[1], condition:begin[2], start };
    } else if (content === '<!-- /beerpowers:engine -->' && open) {
      found.set(open.name, { ...open, end, text: text.slice(open.start, end) });
      open = null;
    } else throw Error('Ambiguous engine marker in ' + path + ': ' + content);
  }
  if (open) throw Error('Unclosed engine block ' + open.name + ': ' + path);
  return found;
}
