// Находит и проверяет локальные Markdown-ссылки в памяти workspace.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { workspacePath } from './ui-workspace.mjs';

function documentBody(markdown) {
  return markdown.replace(/^[ ]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ ]{0,3}\1[ \t]*\r?$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

export function localDestinations(markdown) {
  const prose = documentBody(markdown).replace(/(`+)[^\n]*?\1/g, '');
  return [...prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|((?:\\[()]|[^()\s])+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)]
    .map(match => (match[1] ?? match[2]).split(/[?#]/, 1)[0])
    .filter(reference => reference && (/^[a-z]:[\\/]/i.test(reference) || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)));
}

const createdLater = new Set(['memory/decisions.md', 'memory/product-map.md', 'memory/product-actors.md',
  'memory/product-glossary.md', 'memory/product-metrics.md']);
function markdownFiles(root, relative) {
  const path = workspacePath(root, relative);
  if (!lstatSync(path, {throwIfNoEntry: false})?.isDirectory()) return [];
  return readdirSync(path, {withFileTypes: true}).flatMap(entry => {
    const source = relative + '/' + entry.name;
    if (['.codex/agent-memory', '.codex/agent-memory-local', '.codex/.cache'].includes(source)) return [];
    if (source.startsWith('memory/tasks/') && ['tracker', 'figma', 'screenshots'].includes(entry.name)) return [];
    if (entry.isDirectory()) return markdownFiles(root, source);
    return entry.isFile() && entry.name.endsWith('.md') ? [source] : [];
  });
}

export function workspaceLinks(root) {
  const index = 'memory/MEMORY.md';
  const codexBasenames = new Set(['team-lead.md', 'team-charter.md', 'workspace.json',
    ...markdownFiles(root, '.codex/rules').map(file => posix.basename(file))]);
  const files = [index, ...['AGENTS.md', 'README.md'].filter(file =>
    lstatSync(workspacePath(root, file), {throwIfNoEntry:false})?.isFile()),
    ...['.codex', 'memory'].flatMap(dir => markdownFiles(root, dir)).filter(file => file !== index)].sort();
  const broken = [];
  let localLinks = 0;
  for (const source of files) {
    const body = readFileSync(workspacePath(root, source), 'utf8');
    const base = posix.dirname(source);
    const prose = documentBody(body);
    const task = source.startsWith('memory/tasks/');
    const destinations = localDestinations(body).map(reference => ({reference, base, codexOnly:task}));
    for (const [, reference] of prose.matchAll(/(?<!\x60)\x60([^\x60\r\n]+)\x60(?!\x60)/g)) {
      if (codexBasenames.has(reference)) destinations.push({reference, base});
    }
    for (const [, reference] of prose.matchAll(/`((?:memory|\.codex)\/[\p{L}\p{N}_./-]+\.(?:md|mjs|pl|json|html))`/gu)) {
      if (task && !reference.startsWith('.codex/')) continue;
      if (/NNN|\.local\.json$|-settings\.json$/.test(reference) || createdLater.has(reference)) continue;
      destinations.push({reference, base:'.'});
    }
    for (const {reference, base, codexOnly} of destinations) {
      let included = !codexOnly;
      try {
        const decoded = decodeURIComponent(reference).replace(/\\([()])/g, '$1');
        const target = posix.normalize(posix.join(base, decoded)).replace(/\/$/, '');
        included ||= target === '.codex' || target.startsWith('.codex/');
        if (!included) continue;
        localLinks++;
        if (posix.isAbsolute(decoded) || target === '..' || target.startsWith('../')) throw Error('outside workspace');
        if (target !== '.' && !lstatSync(workspacePath(root, target), {throwIfNoEntry: false})) throw Error('missing path');
      } catch {
        if (included) broken.push({source, reference});
      }
    }
  }
  const uniqueBroken = [...new Map(broken.map(link => [JSON.stringify(link), link])).values()];
  return {source: index, files: files.length, localLinks, missing: uniqueBroken.filter(link => link.source === index)
    .map(link => link.reference), broken: uniqueBroken};
}
