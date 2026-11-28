#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { findRoot, workspacePath } from './lib/ui-workspace.mjs';
import { referenceFile, referenceFiles, referenceNamespace } from './lib/role-references.mjs';
import { showHelp } from './lib/cli-help.mjs';

showHelp('role-files.mjs Read FILE | Read beerpowers:reference[/FILE.md] | Grep FILE_OR_DIRECTORY TEXT | Glob DIRECTORY PATTERN');
const [operation, target, query, ...extra] = process.argv.slice(2);
const root = findRoot();
const ignoredDirectories = new Set(['node_modules','vendor']);
function source(file) {
  // Скрытые каталоги и локальные настройки вне источников роли. Бриф и память доставлены пакетом.
  if (file.split('/').some(p => p.startsWith('.') || ignoredDirectories.has(p)) || /(?:^|\.)local\.json$/i.test(file)) {
    throw Error('Закрытый путь: ' + file);
  }
  return workspacePath(root, file);
}
function* regularFiles(file) {
  const path = file === '.' ? root : source(file);
  const stat = lstatSync(path);
  if (stat.isFile()) { yield file; return; }
  if (!stat.isDirectory()) throw Error('Ожидается обычный файл или каталог: ' + file);
  for (const item of readdirSync(path,{withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.') || ignoredDirectories.has(item.name) || /(?:^|\.)local\.json$/i.test(item.name) ||
        !(item.isFile() || item.isDirectory())) continue;
    yield* regularFiles(file === '.' ? item.name : file + '/' + item.name);
  }
}
function readText(file) {
  const path = file.startsWith(referenceNamespace + '/') ? referenceFile(file) : source(file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('Нужен обычный файл до 8 MiB: ' + file);
  const bytes = readFileSync(path);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}
try {
  if (!target || extra.length || !['Read','Grep','Glob'].includes(operation) || (operation === 'Read' ? query !== undefined : !query)) throw Error('Проверь аргументы role-files.mjs --help');
  if (operation === 'Read' && target === referenceNamespace) {
    for (const label of [...referenceFiles().keys()].sort()) console.log(label);
  } else if (operation === 'Read') {
    const text = readText(target);
    if (text === null) throw Error('Ожидается текстовый файл');
    process.stdout.write(text);
  } else {
    for (const file of regularFiles(target)) {
      if (operation === 'Glob') {
        const relative = target === '.' ? file : file.slice(target.length + 1);
        if (matchesGlob(relative, query)) console.log(file);
      } else {
        const text = readText(file);
        if (text !== null) for (const [i,line] of text.split(/\r?\n/).entries()) {
          if (line.includes(query)) console.log(file + ':' + (i + 1) + ':' + line);
        }
      }
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
