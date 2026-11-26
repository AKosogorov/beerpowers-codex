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
    if (['memory/tasks', '.codex/agent-memory', '.codex/agent-memory-local', '.codex/.cache'].includes(source)) return [];
    if (entry.isDirectory()) return markdownFiles(root, source);
    return entry.isFile() && entry.name.endsWith('.md') ? [source] : [];
  });
}

export function workspaceLinks(root) {
  const index = 'memory/MEMORY.md';
  const files = [index, ...['AGENTS.md', 'README.md'].filter(file =>
    lstatSync(workspacePath(root, file), {throwIfNoEntry:false})?.isFile()),
    ...['.codex', 'memory'].flatMap(dir => markdownFiles(root, dir)).filter(file => file !== index)].sort();
  const broken = [];
  let localLinks = 0;
  for (const source of files) {
    const body = readFileSync(workspacePath(root, source), 'utf8');
    const destinations = localDestinations(body).map(reference => ({reference, base:posix.dirname(source)}));
    for (const [, reference] of documentBody(body).matchAll(/`((?:memory|\.codex)\/[\p{L}\p{N}_./-]+\.(?:md|mjs|pl|json|html))`/gu)) {
      if (/NNN|\.local\.json$|-settings\.json$/.test(reference) || createdLater.has(reference)) continue;
      destinations.push({reference, base:'.'});
    }
    for (const {reference, base} of destinations) {
      localLinks++;
      try {
        const decoded = decodeURIComponent(reference).replace(/\\([()])/g, '$1');
        const target = posix.normalize(posix.join(base, decoded)).replace(/\/$/, '');
        if (posix.isAbsolute(decoded) || target === '..' || target.startsWith('../')) throw Error('outside workspace');
        if (target !== '.' && !lstatSync(workspacePath(root, target), {throwIfNoEntry: false})) throw Error('missing path');
      } catch {
        broken.push({source, reference});
      }
    }
  }
  return {source: index, files: files.length, localLinks, missing: broken.filter(link => link.source === index)
    .map(link => link.reference), broken};
}
