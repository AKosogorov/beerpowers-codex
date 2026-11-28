import { createHash } from 'node:crypto';

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
export const engineBody = block => block.text.slice(block.text.indexOf('\n') + 1, block.text.lastIndexOf('\n')).replace(/\r$/, '').replaceAll('\r\n', '\n');
export const digest = body => createHash('sha256').update(body).digest('hex');

// Тела изменённых блоков версии 0.12.0. Используются, когда предыдущий пакет уже удалён.
const published = {
  'team-charter': {
    'git-roles': [[4, '56ff2abc5a7603b0775613c2b7e986ff1653f57b3524c9ff4c063e652a444d2d']],
    'task-artifacts': [[32, 'cb81a69369dc1d12bf14e9448235ec2d3d87cd6ffbeaf0f20e83da693c492bb6']],
    'viewports-scope': [[20, '2381cdeae3e91fd78b7e256fb5ea6fc2d61ae37ed76c810aa9b8379bd67a110b']],
    'evidence-discipline': [[86, '6691d89be880903194fecf2ba9c3de6fbb097ac95b275f21c8a9cd197d46ae58']],
  },
  'team-lead': {
    git: [[6, '73b07b6346aed124e866b5ec4256893acee26d0b75e41735174fb8084e82f1c0']],
    'task-class': [[20, 'f943cc77d9fdabf08e4a4209c2b6ebbe76340ba15614a81ca85eb437fc2686d9']],
    'effort-questions': [[70, '6bf69c2feffeb2530d6914eeba3b4d1598aa77b4f61d846b910d06e32eddfecd']],
    gates: [[33, '2fb40d5517f579319b81c195bc0271d76d1238ab0519e1ceb29a2d9a3931b080']],
    closing: [[25, 'fc61da462070fc370ffc5b71e53c9829fc0f7ffa128564b77847a0295fed79ca']],
    'tracker-write': [[46, '596541ed711fb69e60eff2118b80d615824eb19023d0b7c05aba4b27fa17ed25']],
  },
  'frontend-agent': {'self-check': [[10, '1a819d890d2f4d80148a854bb8bc59f66380c50f15dc4e4b778ed771195a5833']]},
  'reviewer-agent': {'diff-base': [[10, 'ca8b317a04f9dfd76bdbfe9d312bec825b36ef6166d9c14f9d3bbf9597d00f88']]},
  'testing-agent': {'real-browser': [[39, '1bddcf230ffe058530a31698c2d2808d20fd37fdbc5d43bb6b428b791d4df6d2']]},
};
const historyFor = path => published[path.split('/').at(-1).replace(/\.md$/, '')] ?? {};
export const knownBlock = (path, block, canonical) => block.condition === canonical.condition &&
  historyFor(path)[block.name]?.some(([, hash]) => digest(engineBody(block)) === hash);

// Обе границы восстанавливаются только вокруг точной редакции тела. Одинокий
// маркер, два совпадения или пересечение с другим блоком требуют разбора.
export function restoreBoundaries(text, path, expected, prior = new Map(), history = historyFor(path)) {
  const actual = blocks(text, path);
  const intervals = [...actual.values()];
  const lines = [...text.matchAll(/^([^\r\n]*)(?:\r\n|\n|$)/gm)];
  const prose = new Set([...markupLines(text)].map(row => row.start));
  const edits = [];
  for (const [name, block] of expected) {
    if (actual.has(name)) continue;
    const versions = [...(history[name] ?? [])];
    for (const example of [block, prior?.get(name)].filter(Boolean)) {
      const body = engineBody(example);
      versions.push([body.split('\n').length, digest(body)]);
    }
    const matches = [];
    for (const size of new Set(versions.map(([length]) => length))) {
      const hashes = new Set(versions.filter(([length]) => length === size).map(([, hash]) => hash));
      for (let i = 0; i + size <= lines.length; i++) {
        const start = lines[i].index, last = lines[i + size - 1], end = last.index + last[1].length;
        if (!prose.has(start) || intervals.some(mark => start < mark.end && end > mark.start)) continue;
        const content = text.slice(start, end);
        if (hashes.has(digest(content.replaceAll('\r\n', '\n')))) matches.push({start, end, content});
      }
    }
    if (matches.length > 1) throw Error('Неоднозначные границы ' + path + ' [' + name + ']');
    if (matches.length) edits.push({...matches[0], name, opener:block.text.split(/\r?\n/)[0]});
  }
  let right = text.length;
  for (const {start, end, content, opener, name} of edits.sort((a, b) => b.start - a.start)) {
    if (end > right) throw Error('Пересекаются границы ' + path + ' [' + name + ']');
    const nl = content.includes('\r\n') || text.slice(end).startsWith('\r\n') ? '\r\n' : '\n';
    text = text.slice(0, start) + opener + nl + content + nl + '<!-- /beerpowers:engine -->' + text.slice(end);
    right = start;
  }
  return text;
}
