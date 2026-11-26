// Собирает индекс техдолга по карточкам памяти и маркерам в отслеживаемом коде.
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { discover } from './git-repositories.mjs';
import { workspacePath } from './ui-workspace.mjs';
import { localDestinations } from './workspace-links.mjs';

const directory = 'memory/tech-debt';
const source = directory + '/tech-debt.md';
const start = '<!-- beerpowers:tech-debt:start -->';
const end = '<!-- beerpowers:tech-debt:end -->';
const statuses = ['открыт', 'частично', 'под сомнением', 'закрыт', 'снят'];
const number = /^(\d{3}[a-z]?)-.+\.md$/;

function parseItem(root, file, repos) {
  const relative = directory + '/' + file;
  const body = readFileSync(workspacePath(root, relative), 'utf8').replace(/^\uFEFF/, '');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(body);
  if (!frontmatter) throw Error(relative + ' — отсутствует frontmatter');
  const fields = Object.fromEntries([...frontmatter[1].matchAll(/^([a-z_]+):[ \t]*(.*)$/gm)]
    .map(([, key, value]) => [key, value.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2')]));
  const heading = /^# (\d+)([абвa-z]?)\. (.+)$/mu.exec(frontmatter[2]);
  const suffix = heading?.[2];
  if (!heading || heading[1].padStart(3, '0') + ({а:'a', б:'b', в:'v'}[suffix] ?? suffix) !== number.exec(file)[1]) {
    throw Error(relative + ' — номер заголовка не совпадает с именем файла');
  }
  if (!statuses.includes(fields.status) || !fields.area) throw Error(relative + ' — проверь поля status и area');
  const listed = (fields.repo ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if ((repos.length > 1 && !listed.length) || listed.some(repo => repo !== 'workspace' && !repos.includes(repo))) {
    throw Error(relative + ' — проверь поле repo');
  }
  return {file, num: heading[1] + suffix, title: heading[3].trim(), status: fields.status,
    status_note: fields.status_note, area: fields.area, checked: fields.checked, repos: listed};
}

function format(items, multiRepo) {
  const cell = value => (value ?? '').replaceAll('|', '\\|');
  const counts = statuses.map(status => status + ' ' + items.filter(item => item.status === status).length);
  const headers = ['№', 'Статус', 'Область', ...(multiRepo ? ['Репозиторий'] : []), 'Пункт', 'Проверено'];
  const table = values => '| ' + values.join(' | ') + ' |';
  const rows = items.map(item => table([item.num, cell(item.status + (item.status_note ? ' — ' + item.status_note : '')),
    cell(item.area), ...(multiRepo ? [cell(item.repos.join(', '))] : []),
    '[' + cell(item.title) + '](' + encodeURIComponent(item.file).replaceAll('(', '%28').replaceAll(')', '%29') + ')',
    cell(item.checked)]));
  return [start, '', 'Пунктов: ' + items.length + ' — ' + counts.join(', ') + '.', '',
    table(headers), table(headers.map(() => '---')), ...rows, '', end].join('\n');
}

export function techDebtIndex(root, refresh = false) {
  const path = workspacePath(root, source);
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (stat && !stat.isFile()) throw Error('Ожидается файл ' + source);
  const current = stat ? readFileSync(path, 'utf8') : '';
  const folder = workspacePath(root, directory);
  const entries = lstatSync(folder, {throwIfNoEntry: false}) ? readdirSync(folder, {withFileTypes:true}) : [];
  const files = entries.filter(entry => number.test(entry.name)).map(entry => {
    if (!entry.isFile()) throw Error('Ожидается файл ' + directory + '/' + entry.name);
    return entry.name;
  }).sort();
  const begin = [...current.matchAll(/^<!-- beerpowers:tech-debt:start -->(?=\r?$)/gm)];
  const finish = [...current.matchAll(/^<!-- beerpowers:tech-debt:end -->(?=\r?$)/gm)];
  const generated = begin.length === 1 && finish.length === 1 && begin[0].index < finish[0].index;
  if (!generated && (begin.length || finish.length)) throw Error('Повреждены границы блока в ' + source);
  if (!generated && !refresh) {
    const links = new Set(localDestinations(current).map(reference => {
      try { return decodeURIComponent(reference).replace(/^\.\//, ''); }
      catch { return reference; }
    }));
    const missing = files.filter(file => !links.has(file));
    return {source, mode:'manual', items:files.length, current:missing.length === 0, missing};
  }
  const repos = files.length ? discover().map(repo => repo.name) : [];
  const items = files.map(file => parseItem(root, file, repos));
  if (new Set(files.map(file => number.exec(file)[1])).size !== files.length) throw Error('Повтор номера пункта в ' + directory);
  const block = format(items, repos.length > 1);
  const first = begin[0]?.index, last = generated ? finish[0].index + end.length : undefined;
  const actual = generated ? current.slice(first, last).replace(/\r\n/g, '\n') : '';
  const changed = actual !== block;
  if (refresh && changed) {
    if ((stat?.nlink ?? 1) > 1) throw Error('Жёсткая ссылка ' + source);
    const newline = current.includes('\r\n') ? '\r\n' : '\n';
    const replacement = block.replaceAll('\n', newline);
    const base = current || '# Технический долг' + newline;
    const next = generated ? current.slice(0, first) + replacement + current.slice(last)
      : base + (base.endsWith(newline) ? newline : newline + newline) + replacement + newline;
    const temporary = workspacePath(root, directory + '/.tech-debt-' + randomUUID() + '.tmp');
    writeFileSync(temporary, next, {flag:'wx', mode:stat?.mode ?? 0o666});
    try {
      if ((lstatSync(workspacePath(root, source), {throwIfNoEntry:false}) ? readFileSync(path, 'utf8') : '') !== current) {
        throw Error('Индекс изменился во время сборки — повтори команду');
      }
      renameSync(temporary, path);
    } finally {
      if (lstatSync(temporary, {throwIfNoEntry:false})) unlinkSync(temporary);
    }
  }
  return {source, mode:'generated', items:items.length, current:refresh || !changed, ...(refresh ? {changed} : {})};
}
