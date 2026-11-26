#!/usr/bin/env node
//
// layout-check — задевает ли дифф задачи вёрстку: можно ли сократить прогон по ширинам.
//
//     node <package>/bin/layout-check.mjs <КОД> <репо> [<репо>…]
//
// Дифф — от точки ответвления от базы задачи (как у git-base.mjs) до рабочего дерева задачи
// worktrees/<КОД>/<репо>, а без него — projects/<репо>; с незакоммиченным и новыми файлами.
// По каждому изменённому файлу — строка pass или fail с причиной, последней — ИТОГ.
// Определение «правки без вёрстки» и что делать с ответом — charter, «Прогон по ширинам».
//
// fail, если файл:
//   - стили, конфиг темы или Tailwind, изображение, шрифт;
//   - шаблон (.vue, .svelte, .astro, .html, .blade.php, .twig) и в нём изменились теги
//     или компоненты, атрибуты class, style, ui, размеры, src, условный рендер (v-if, v-show,
//     v-for), число текстовых узлов или длина видимого текста;
//   - блок <style> компонента;
//   - код (script, стор, composable), где изменённая строка трогает классы или стили
//     (class, style, ui:) или ширину экрана (useBreakpoints, matchMedia, innerWidth, md: …);
//   - файл перевода, где у ключа изменилась длина текста;
//   - компонент или шаблон добавлен, удалён или переименован.
// Остальное — pass: значения по умолчанию, логика, валидация, атрибуты без влияния
// на раскладку (placeholder, type, maxlength, aria-*, обработчики), текст той же длины,
// файлы вне фронта.
//
// Код выхода: 0 — все pass, 1 — есть fail, 2 — ошибка (нет репозитория, базы, истории).
// Эвристика ошибается в сторону fail: полный прогон дороже временем, но не пропускает дефект.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, workspacePath } from './lib/ui-workspace.mjs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length < 2 || args[0] === '-h' || args[0] === '--help') {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  process.stdout.write(lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(args[0] === '-h' || args[0] === '--help' ? 0 : 2);
}

const [code, ...repos] = args;
let root;
try {
  root = findRoot();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}

const STYLE_EXT = /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot)$/i;
const THEME_FILE = /(^|\/)(tailwind|uno|windi|postcss)\.config\.[cm]?[jt]s$|(^|\/)app\.config\.[cm]?[jt]s$|(^|\/)(theme|themes|tokens)(\/|\.)/i;
const SECTIONED = /\.(vue|svelte|astro)$/i;
const TEMPLATE_FILE = /\.(html?|blade\.php|twig)$/i;
const CODE_EXT = /\.([cm]?[jt]sx?)$/i;
const I18N_PATH = /(^|\/)(locales?|i18n|lang|langs|translations)\//i;
const LAYOUT_ATTR = /^(?:(?:v-bind)?:)?(class|style|ui|size|width|height|src|srcset|sizes|cols|rows|span)$|^v-(if|else-if|else|show|for)$/i;
const LAYOUT_CODE = /\bclass(Name|es)?\b|\bstyle\b|\bui\s*[:=]|useBreakpoints|useMediaQuery|matchMedia|inner(Width|Height)|outerWidth|clientWidth|breakpoint|@media|(^|[\s"'`])(sm|md|lg|xl|2xl):/i;

// Блоки <name>…</name> верхнего уровня файла компонента. Шаблон берётся от первого
// открывающего до последнего закрывающего: вложенные <template> слотов — его часть.
function block(text, name) {
  if (name === 'template') {
    const a = text.search(/<template[\s>]/i);
    const b = text.toLowerCase().lastIndexOf('</template>');
    return a < 0 || b < a ? '' : text.slice(a, b + '</template>'.length);
  }
  return [...text.matchAll(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'gi'))].map((m) => m[0]).join('\n');
}

// Шаблон — последовательность тегов с атрибутами и текстовых узлов.
function tokens(tpl) {
  const src = tpl.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[^\s=>\/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>|([^<]+)/g;
  for (const m of src.matchAll(re)) {
    if (m[4] !== undefined) {
      const t = m[4].replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t });
      continue;
    }
    const attrs = {};
    for (const a of (m[3] || '').matchAll(/([^\s=>\/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g)) {
      attrs[a[1]] = (a[2] ?? '').replace(/^["']|["']$/g, '');
    }
    out.push({ tag: `${m[1]}${m[2]}`, attrs });
  }
  return out;
}

function compareTemplate(oldTpl, newTpl) {
  const a = tokens(oldTpl);
  const b = tokens(newTpl);
  const shape = (ts) => ts.map((t) => (t.tag ? `<${t.tag}>` : '#text')).join(' ');
  if (shape(a) !== shape(b)) {
    const tags = (ts) => ts.filter((t) => t.tag).map((t) => t.tag).join(' ');
    return tags(a) !== tags(b) ? 'изменились теги или компоненты шаблона' : 'добавлен или удалён текст в шаблоне';
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.text !== undefined) {
      if (x.text.length !== y.text.length) return `изменилась длина текста: «${y.text.slice(0, 40)}»`;
      continue;
    }
    for (const k of new Set([...Object.keys(x.attrs), ...Object.keys(y.attrs)])) {
      if (x.attrs[k] !== y.attrs[k] && LAYOUT_ATTR.test(k)) return `атрибут ${k} у <${y.tag}>`;
    }
  }
  return null;
}

// Строки, которые есть только в одной версии: порядок не важен, важны сами строки.
function changedLines(oldText, newText) {
  const count = (t) => t.split(/\r?\n/).reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const a = count(oldText);
  const b = count(newText);
  const out = [];
  for (const [l, n] of a) if (n > (b.get(l) ?? 0)) out.push(l);
  for (const [l, n] of b) if (n > (a.get(l) ?? 0)) out.push(l);
  return out.filter((l) => l.trim());
}

function codeVerdict(oldText, newText) {
  const hit = changedLines(oldText, newText).find((l) => LAYOUT_CODE.test(l));
  return hit ? `строка трогает классы, стили или ширину: «${hit.trim().slice(0, 60)}»` : null;
}

// Тексты перевода: «ключ: значение» и «"ключ": "значение"».
function i18nVerdict(oldText, newText) {
  const pairs = (t) => {
    const m = new Map();
    for (const l of t.split(/\r?\n/)) {
      const p = l.match(/^\s*["']?([\w.-]+)["']?\s*[:=]\s*["'`]?(.*?)["'`]?,?\s*$/);
      if (p) m.set(p[1], p[2]);
    }
    return m;
  };
  const a = pairs(oldText);
  const b = pairs(newText);
  for (const [k, v] of b) if (a.has(k) && a.get(k).length !== v.length) return `изменилась длина текста ключа ${k}`;
  return null;
}

function verdict(file, status, oldText, newText) {
  if (ASSET_EXT.test(file)) return 'изображение или шрифт';
  if (STYLE_EXT.test(file)) return 'файл стилей';
  if (THEME_FILE.test(file)) return 'конфиг темы или Tailwind';
  const markup = SECTIONED.test(file) || TEMPLATE_FILE.test(file);
  if (markup && status !== 'M') return status === 'A' ? 'добавлен компонент или шаблон' : 'удалён или переименован компонент или шаблон';
  if (SECTIONED.test(file)) {
    const t = compareTemplate(block(oldText, 'template'), block(newText, 'template'));
    if (t) return t;
    if (block(oldText, 'style') !== block(newText, 'style')) return 'изменился блок <style>';
    return codeVerdict(block(oldText, 'script'), block(newText, 'script'));
  }
  if (TEMPLATE_FILE.test(file)) return compareTemplate(oldText, newText);
  if (I18N_PATH.test(file)) return i18nVerdict(oldText, newText);
  if (CODE_EXT.test(file)) return codeVerdict(oldText, newText);
  return null;
}

function check(repoName) {
  const adapter = fileURLToPath(new URL('./git-workspace.mjs', import.meta.url));
  const r = JSON.parse(execFileSync(process.execPath, [adapter, 'resolve', code, repoName], {cwd:root, encoding:'utf8'}));
  const where = r.checkout;
  const abs = workspacePath(root, where);
  const git = (...args) => execFileSync('git', ['-C', abs, ...args], {encoding:'utf8', maxBuffer:32 * 1024 * 1024});
  if (git('branch','--show-current').trim() !== code) throw Error('Wrong checkout for ' + code);
  const base = r.baseSha;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw Error('Missing task base SHA');
  const fields = git('diff','--name-status','--no-renames','-z', base,'--').split('\0');
  fields.pop();
  const files = [];
  for (let i=0; i<fields.length; i+=2) files.push({status:fields[i], file:fields[i+1]});
  for (const file of git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean)) files.push({status:'A',file});
  const rows = files.map(({status,file}) => {
    let why = verdict(file, status, '', '');
    if (!why && [SECTIONED,TEMPLATE_FILE,I18N_PATH,CODE_EXT].some(pattern => pattern.test(file))) {
      const oldText = status === 'A' ? '' : git('show', base + ':' + file).replace(/\r\n/g,'\n');
      const newText = status === 'D' ? '' : fs.readFileSync(workspacePath(abs,file),'utf8').replace(/\r\n/g,'\n');
      why = verdict(file,status,oldText,newText);
    }
    return {file,ok:!why,why};
  });
  return {where,base,rows};
}
let failed = false;
let broken = false;
for (const repo of repos) {
  let res;
  try { res = check(repo); } catch (err) { res = {error:err.message}; }
  if (res.error) {
    process.stderr.write(`layout-check: ${repo}: ${res.error}\n`);
    broken = true;
    continue;
  }
  process.stdout.write(`РЕПО  ${repo} (${res.where}) — дифф от ответвления от ${res.base}\n`);
  if (res.rows.length === 0) process.stdout.write('      изменений нет\n');
  for (const row of res.rows) {
    process.stdout.write(row.ok ? `pass  ${row.file}\n` : `fail  ${row.file} — ${row.why}\n`);
    if (!row.ok) failed = true;
  }
}
if (broken) {
  process.stdout.write('ИТОГ  ошибка — прогон по всем ширинам\n');
  process.exit(2);
}
process.stdout.write(failed
  ? 'ИТОГ  fail — правка задевает вёрстку, прогон по всем ширинам, вопрос не задаётся\n'
  : 'ИТОГ  pass — правка без вёрстки, можно предложить прогон на одной ширине\n');
process.exit(failed ? 1 : 0);
